import {
  DEFAULT_SETTINGS,
  type ActiveVideoState,
  type CategoryRule,
  type ChapterFilterMode,
  type ExtensionSettings,
  type KnowledgeEntry,
  type RuntimeMessage,
  type SponsorCategory,
  type SponsorSegment,
  type SubscriptionProvider,
} from '../shared/types';
import {
  ALL_SPONSOR_CATEGORIES,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  extractSponsorBlockChapters,
  stripSponsorSegmentsFromTranscript,
} from '../shared/sponsorblock';
import {
  formatTimestamp,
  getActiveChapter,
  getAdjacentChapter,
  mergeChapters,
} from '../shared/chapters';
import {
  exportAllToMarkdown,
  exportEntryToMarkdown,
  getActiveEntries,
  getTrashedEntries,
  searchKnowledgeBase,
} from '../shared/kb-storage';
import type { ActivityLogEntry, QueueJob } from '../shared/types';
import { formatActivityLogsText, formatLogTimestamp } from '../shared/logs';
import {
  addUniqueTopic,
  evaluateChapterRelevance,
  extractTopicFromChapter,
  removeTopic,
  toggleChapterCare,
  toggleChapterIgnore,
} from '../shared/interests';
import { parseGithubRepo } from '../shared/github-sync';
import { extractAllYouTubeVideoIds, extractYouTubeVideoId } from '../shared/youtube-url';

let activeTabId: number | null = null;
let videoState: ActiveVideoState | null = null;
const tabStateByTabId = new Map<number, ActiveVideoState>();
const analyzingVideoIds = new Set<string>();
let openYouTubeTabs: Array<{
  id: number;
  windowId: number;
  videoId: string;
  title: string;
  active: boolean;
}> = [];
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let kbEntries: KnowledgeEntry[] = [];
let expandedKbIds = new Set<string>();
let chapterSearch = '';
let transcriptSearch = '';
let kbSearch = '';
let kbEntityFilter = 'all';
let kbCategoryFilter = 'all';
let kbViewingTrash = false;
let addingCategoryInline = false;
let lastWatchingRenderSig = '';

function sendMessage<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (res && typeof res === 'object' && 'error' in res && res.error) {
        reject(new Error(String((res as { error: unknown }).error)));
        return;
      }
      resolve(res as T);
    });
  });
}

function sendTabMessage<T = unknown>(tabId: number, msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res as T);
    });
  });
}

let bannerHideTimer: number | null = null;

function showBanner(text: string, kind: 'info' | 'success' | 'error' = 'info') {
  const el = document.getElementById('banner');
  if (!el) return;
  el.textContent = text;
  el.className = `banner ${kind}`;
  if (bannerHideTimer) window.clearTimeout(bannerHideTimer);
  if (kind !== 'error') {
    bannerHideTimer = window.setTimeout(() => hideBanner(), 6500);
  }
}

function hideBanner() {
  document.getElementById('banner')?.classList.add('hidden');
}

function downloadTextFile(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'note';
}

async function resolveTargetYouTubeTabId(): Promise<number | null> {
  const targetVideoId = videoState?.meta?.videoId;
  const ytTabs = await chrome.tabs.query({
    url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
  });

  if (targetVideoId) {
    const exactCurrentWin = ytTabs.find(
      (t) => t.id === activeTabId && t.url?.includes(targetVideoId)
    );
    if (exactCurrentWin?.id) return exactCurrentWin.id;

    const exactAny = ytTabs.find((t) => t.url?.includes(targetVideoId));
    if (exactAny?.id) {
      activeTabId = exactAny.id;
      return exactAny.id;
    }
  }

  if (activeTabId) {
    const stillExists = ytTabs.find((t) => t.id === activeTabId);
    if (stillExists?.id) return stillExists.id;
  }

  const activeTab = ytTabs.find((t) => t.active) ?? ytTabs[0];
  if (activeTab?.id) {
    activeTabId = activeTab.id;
    return activeTab.id;
  }
  return null;
}

async function seekVideo(seconds: number) {
  const tabId = await resolveTargetYouTubeTabId();
  if (!tabId) {
    showBanner('No YouTube video tab found — open the video tab and click ↻.', 'error');
    return;
  }

  try {
    await sendTabMessage(tabId, { type: 'SEEK_TO', seconds });
    if (videoState) {
      videoState.currentTimeSec = Math.max(0, seconds);
      updateWatchingPlaybackOnly();
    }
  } catch {
    showBanner('Refresh the YouTube tab once (F5) so ChapterMind reconnects.', 'error');
  }
}

function getWatchingRenderSignature(): string {
  if (!videoState?.meta) return 'none';
  return [
    videoState.meta.videoId,
    videoState.meta.durationSec,
    videoState.transcriptStatus,
    videoState.transcript.length,
    videoState.youtubeChapters.length,
    videoState.sponsorSegments.map((s) => `${s.uuid}:${s.disabled ? 1 : 0}`).join(','),
    videoState.aiSponsors.map((s) => `${s.uuid}:${s.disabled ? 1 : 0}`).join(','),
    videoState.kbEntry?.updatedAt ?? 0,
    settings.chapterFilterMode,
    settings.topicsIgnore.join(','),
    settings.topicsCare.join(','),
    (settings.topicsAllow ?? []).join(','),
    settings.autoSkipIgnoredChapters ? 1 : 0,
    settings.hideIgnoredChapters ? 1 : 0,
    chapterSearch,
  ].join('|');
}

function updateWatchingPlaybackOnly() {
  if (!videoState?.meta) return;
  const duration = Math.max(1, videoState.meta.durationSec);
  const currentEl = document.getElementById('timeline-current');
  if (currentEl) {
    currentEl.textContent = formatTimestamp(videoState.currentTimeSec);
  }
  const playhead = document.querySelector('#visual-timeline .vt-playhead') as HTMLElement | null;
  if (playhead) {
    playhead.style.left = `${Math.min(100, (videoState.currentTimeSec / duration) * 100)}%`;
  }
  const activeCh = getActiveChapter(getMergedChapters(), videoState.currentTimeSec);
  document.querySelectorAll('#chapters-list .item-card[data-chapter-id]').forEach((card) => {
    const id = (card as HTMLElement).dataset.chapterId;
    card.classList.toggle('active', Boolean(activeCh && id === activeCh.id));
  });
}

function getMergedChapters() {
  if (!videoState || !videoState.meta) return [];
  const sbChapters = extractSponsorBlockChapters(
    videoState.sponsorSegments,
    videoState.meta.durationSec
  );
  const aiChapters = videoState.kbEntry?.chapters ?? [];
  return mergeChapters(
    videoState.youtubeChapters,
    sbChapters,
    aiChapters,
    settings.chapterFilterMode,
    videoState.meta.durationSec
  );
}

function isVideoBusyInQueue(videoId: string): boolean {
  if (analyzingVideoIds.has(videoId)) return true;
  return queueJobs.some(
    (j) =>
      j.videoId === videoId &&
      (j.status === 'queued' || j.status === 'fetching_transcript' || j.status === 'analyzing')
  );
}

function updateAnalyzeButtonState() {
  const btn = document.getElementById('analyze-api-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const vid = videoState?.meta?.videoId;
  if (vid && analyzingVideoIds.has(vid)) {
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
  } else {
    btn.disabled = false;
    btn.textContent = 'Analyze';
  }
}

function renderOpenTabsBar() {
  const bar = document.getElementById('open-tabs-bar');
  const list = document.getElementById('open-tabs-list');
  const queueAllBtn = document.getElementById('queue-open-tabs-btn') as HTMLButtonElement | null;
  if (!bar || !list) return;

  if (openYouTubeTabs.length < 2) {
    bar.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  list.innerHTML = '';

  const savedIds = new Set(kbEntries.map((e) => e.videoId));
  let unsavedCount = 0;

  for (const t of openYouTubeTabs) {
    const isSaved = savedIds.has(t.videoId);
    const isBusy = isVideoBusyInQueue(t.videoId);
    if (!isSaved && !isBusy) unsavedCount += 1;

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `open-tab-pill${t.id === activeTabId ? ' is-active' : ''}`;
    pill.title = `${t.title}\nClick to switch to this YouTube tab`;

    const dot = document.createElement('span');
    dot.className = `open-tab-dot${isBusy ? ' is-busy' : isSaved ? ' is-kb' : ''}`;

    const label = document.createElement('span');
    label.className = 'open-tab-title';
    label.textContent = t.title;

    pill.append(dot, label);
    pill.addEventListener('click', () => {
      activeTabId = t.id;
      const cached = tabStateByTabId.get(t.id);
      if (cached) {
        videoState = cached;
        renderWatchingTab();
        renderTranscriptTab();
      }
      renderOpenTabsBar();
      void chrome.tabs
        .update(t.id, { active: true })
        .then(() => {
          if (t.windowId) return chrome.windows.update(t.windowId, { focused: true });
        })
        .catch(() => {})
        .finally(() => {
          void syncActiveYouTubeTab();
        });
    });

    list.appendChild(pill);
  }

  if (queueAllBtn) {
    if (unsavedCount > 0) {
      queueAllBtn.textContent = `Queue All (${unsavedCount})`;
      queueAllBtn.disabled = false;
    } else {
      queueAllBtn.textContent = 'All in KB';
      queueAllBtn.disabled = false;
    }
  }
}

async function refreshOpenYouTubeTabs() {
  try {
    const ytTabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
    });
    const next: typeof openYouTubeTabs = [];
    for (const tab of ytTabs) {
      if (!tab.id || !tab.url || tab.url.includes('cm_headless=1')) continue;
      const videoId = extractYouTubeVideoId(tab.url);
      if (!videoId) continue;
      const cachedTitle = tabStateByTabId.get(tab.id)?.meta?.title;
      const rawTitle =
        cachedTitle ||
        tab.title?.replace(/\s*-\s*YouTube$/, '').replace(/^\(\d+\)\s*/, '').trim() ||
        videoId;
      next.push({
        id: tab.id,
        windowId: tab.windowId,
        videoId,
        title: rawTitle,
        active: Boolean(tab.active),
      });
    }
    openYouTubeTabs = next;
    renderOpenTabsBar();
  } catch {
    // ignore
  }
}

function renderWatchingTab() {
  const noVideo = document.getElementById('no-video-card');
  const workspace = document.getElementById('video-workspace');
  if (!noVideo || !workspace) return;

  updateAnalyzeButtonState();

  if (!videoState?.meta) {
    lastWatchingRenderSig = 'none';
    noVideo.classList.remove('hidden');
    workspace.classList.add('hidden');
    return;
  }

  lastWatchingRenderSig = getWatchingRenderSignature();
  noVideo.classList.add('hidden');
  workspace.classList.remove('hidden');

  const meta = videoState.meta;
  const allSegs: SponsorSegment[] = [
    ...videoState.sponsorSegments,
    ...videoState.aiSponsors,
  ];
  const nonChapterSegs = allSegs.filter((s) => s.category !== 'chapter');
  const totalSponsorSec = Math.round(
    nonChapterSegs
      .filter((s) => !s.disabled && s.category !== 'poi_highlight')
      .reduce((acc, s) => acc + Math.max(0, s.endTime - s.startTime), 0)
  );

  (document.getElementById('video-title') as HTMLElement).textContent = meta.title;
  (document.getElementById('video-channel') as HTMLElement).textContent = meta.channelName;
  (document.getElementById('video-duration') as HTMLElement).textContent = formatTimestamp(
    meta.durationSec
  );

  const trBadge = document.getElementById('video-transcript-badge') as HTMLElement;
  if (videoState.transcriptStatus === 'ready') {
    trBadge.textContent = `${videoState.transcript.length} cues`;
    trBadge.className = 'pill pill-cyan';
  } else if (videoState.transcriptStatus === 'loading') {
    trBadge.textContent = 'Loading transcript...';
    trBadge.className = 'pill pill-neutral';
  } else {
    trBadge.textContent = 'No transcript';
    trBadge.className = 'pill pill-neutral';
  }

  const sbBadge = document.getElementById('video-sb-badge') as HTMLElement;
  if (nonChapterSegs.length > 0) {
    sbBadge.classList.remove('hidden');
    sbBadge.textContent = `SB: ${nonChapterSegs.length} (${formatTimestamp(totalSponsorSec)})`;
  } else {
    sbBadge.classList.add('hidden');
  }

  const kbSaved = document.getElementById('kb-saved-badge') as HTMLElement;
  kbSaved.classList.toggle('hidden', !videoState.kbEntry);

  const tldrWrap = document.getElementById('tldr-wrap');
  const tldrEl = document.getElementById('video-tldr') as HTMLElement;
  const tldrToggle = document.getElementById('tldr-toggle-btn') as HTMLButtonElement | null;
  if (videoState.kbEntry?.tldr) {
    tldrEl.textContent = videoState.kbEntry.tldr;
    tldrWrap?.classList.remove('hidden');
    if (tldrToggle) {
      tldrToggle.classList.toggle('hidden', videoState.kbEntry.tldr.length < 130);
    }
  } else {
    tldrWrap?.classList.add('hidden');
  }

  // Timeline bar
  (document.getElementById('timeline-current') as HTMLElement).textContent = formatTimestamp(
    videoState.currentTimeSec
  );
  (document.getElementById('timeline-total') as HTMLElement).textContent = formatTimestamp(
    meta.durationSec
  );

  const timeline = document.getElementById('visual-timeline') as HTMLElement;
  timeline.textContent = '';
  const duration = Math.max(1, meta.durationSec);
  const chapters = getMergedChapters();

  for (const ch of chapters) {
    const block = document.createElement('div');
    block.className = 'vt-chapter';
    const left = (ch.startTime / duration) * 100;
    const width = Math.max(0.5, ((ch.endTime - ch.startTime) / duration) * 100);
    block.style.left = `${left}%`;
    block.style.width = `${width}%`;
    block.title = `${formatTimestamp(ch.startTime)} ${ch.title}`;
    timeline.appendChild(block);
  }

  for (const seg of nonChapterSegs) {
    if (seg.disabled) continue;
    const block = document.createElement('div');
    block.className = 'vt-sponsor';
    const left = (seg.startTime / duration) * 100;
    const width =
      seg.actionType === 'poi'
        ? 1
        : Math.max(0.6, ((seg.endTime - seg.startTime) / duration) * 100);
    block.style.left = `${left}%`;
    block.style.width = `${width}%`;
    block.style.background = CATEGORY_COLORS[seg.category] || '#00d400';
    block.title = `${CATEGORY_LABELS[seg.category]} (${formatTimestamp(seg.startTime)}–${formatTimestamp(seg.endTime)})`;
    timeline.appendChild(block);
  }

  const playhead = document.createElement('div');
  playhead.className = 'vt-playhead';
  playhead.style.left = `${Math.min(100, (videoState.currentTimeSec / duration) * 100)}%`;
  timeline.appendChild(playhead);

  // Mode chips
  document.querySelectorAll('#chapter-mode-chips .seg-btn').forEach((chip) => {
    const mode = (chip as HTMLElement).dataset.mode;
    chip.classList.toggle('active', mode === settings.chapterFilterMode);
  });

  renderInterestFilterBar();

  // Chapters list
  const chList = document.getElementById('chapters-list') as HTMLElement;
  chList.textContent = '';
  const activeCh = getActiveChapter(chapters, videoState.currentTimeSec);
  let hiddenSkippedCount = 0;
  const filteredChapters = chapters.filter((c) => {
    if (
      chapterSearch &&
      !`${c.title} ${c.summary ?? ''}`.toLowerCase().includes(chapterSearch.toLowerCase())
    ) {
      return false;
    }
    if (settings.hideIgnoredChapters) {
      const rel = evaluateChapterRelevance(c, settings).relevance;
      if (rel === 'skip') {
        hiddenSkippedCount += 1;
        return false;
      }
    }
    return true;
  });

  if (filteredChapters.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-small';
    p.textContent =
      chapters.length === 0
        ? 'No chapters yet. Click "Analyze via API" or pick Gemini / ChatGPT / Claude above.'
        : hiddenSkippedCount > 0
          ? `All ${hiddenSkippedCount} matching chapters are hidden by your Don't Care filter.`
          : 'No chapters match your filter.';
    chList.appendChild(p);
  } else {
    for (const ch of filteredChapters) {
      const rel = evaluateChapterRelevance(ch, settings);
      const card = document.createElement('div');
      card.className = `item-card${activeCh?.id === ch.id ? ' active' : ''}${
        rel.relevance === 'skip' ? ' is-skip' : rel.relevance === 'must_watch' ? ' is-care' : ''
      }`;
      card.dataset.chapterId = ch.id;
      card.addEventListener('click', () => void seekVideo(ch.startTime));

      const top = document.createElement('div');
      top.className = 'item-top';

      const left = document.createElement('div');
      left.className = 'item-left';

      const ts = document.createElement('span');
      ts.className = 'ts-badge';
      ts.textContent = formatTimestamp(ch.startTime);

      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = ch.title;

      left.append(ts, title);

      const right = document.createElement('div');
      right.className = 'item-right';

      const fb = document.createElement('div');
      fb.className = `feedback-btns${
        rel.relevance === 'must_watch' || rel.relevance === 'skip' ? ' has-active' : ''
      }`;

      const careBtn = document.createElement('button');
      careBtn.type = 'button';
      careBtn.className = `fb-btn${rel.relevance === 'must_watch' ? ' is-active-care' : ''}`;
      careBtn.textContent = '★';
      careBtn.title =
        rel.relevance === 'must_watch' ? 'Remove from Topics I Care About' : 'I care about this topic';
      careBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const res = toggleChapterCare(ch, settings);
        void saveInterestUpdate({
          topicsCare: res.topicsCare,
          topicsIgnore: res.topicsIgnore,
          topicsAllow: res.topicsAllow,
        }).then(() => {
          showBanner(
            res.action === 'cared'
              ? `Added "${res.topic}" to Topics I Care About`
              : `Removed "${res.topic}" from Topics I Care About`,
            'success'
          );
        });
      });

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = `fb-btn${rel.relevance === 'skip' ? ' is-active-skip' : ''}`;
      skipBtn.textContent = rel.relevance === 'skip' ? '↩' : '⊘';
      skipBtn.title =
        rel.relevance === 'skip'
          ? 'Un-ignore this topic (stop auto-skipping)'
          : "Don't care — auto-skip this topic in future videos too";
      skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const res = toggleChapterIgnore(ch, settings);
        void saveInterestUpdate({
          topicsIgnore: res.topicsIgnore,
          topicsCare: res.topicsCare,
          topicsAllow: res.topicsAllow,
        }).then(() => {
          showBanner(
            res.action === 'ignored'
              ? `Added "${res.topic}" to Don't Care list — auto-skipping!`
              : `Un-ignored "${res.topic}" — no longer skipping`,
            'success'
          );
        });
      });

      fb.append(careBtn, skipBtn);
      right.appendChild(fb);

      top.append(left, right);
      card.appendChild(top);

      if (rel.reason || ch.summary) {
        const sub = document.createElement('div');
        sub.className = 'item-sub';
        sub.textContent =
          rel.relevance === 'skip' && rel.reason
            ? `${rel.reason}${ch.summary ? ` · ${ch.summary}` : ''}`
            : ch.summary || rel.reason || '';
        card.appendChild(sub);
      }

      chList.appendChild(card);
    }

    if (hiddenSkippedCount > 0) {
      const hint = document.createElement('p');
      hint.className = 'muted-small';
      hint.textContent = `${hiddenSkippedCount} "Don't Care" chapter(s) hidden`;
      chList.appendChild(hint);
    }
  }

  // Sponsor segments list
  (document.getElementById('sb-summary-text') as HTMLElement).textContent =
    `${nonChapterSegs.length} segments`;
  const segList = document.getElementById('segments-list') as HTMLElement;
  segList.textContent = '';

  if (nonChapterSegs.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-small';
    p.textContent = 'No SponsorBlock or AI sponsor segments for this video.';
    segList.appendChild(p);
  } else {
    for (const seg of nonChapterSegs) {
      const card = document.createElement('div');
      card.className = 'item-card';
      card.addEventListener('click', () => void seekVideo(seg.startTime));

      const top = document.createElement('div');
      top.className = 'item-top';

      const left = document.createElement('div');
      left.className = 'item-left';

      const dot = document.createElement('span');
      dot.className = 'seg-dot';
      dot.style.background = CATEGORY_COLORS[seg.category] || '#00d400';

      const ts = document.createElement('span');
      ts.className = 'ts-badge';
      ts.textContent = `${formatTimestamp(seg.startTime)}–${formatTimestamp(seg.endTime)}`;

      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = CATEGORY_LABELS[seg.category] || seg.category;

      left.append(dot, ts, title);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn btn-xs';
      toggleBtn.textContent = seg.disabled ? 'Enable' : seg.source === 'ai' ? 'AI · Skip' : 'Skip';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activeTabId) return;
        const nextDisabled = !seg.disabled;
        seg.disabled = nextDisabled;
        void sendTabMessage(activeTabId, {
          type: 'TOGGLE_SEGMENT_DISABLED',
          uuid: seg.uuid,
          disabled: nextDisabled,
        });
        renderWatchingTab();
      });

      top.append(left, toggleBtn);
      card.appendChild(top);

      if (seg.description) {
        const sub = document.createElement('div');
        sub.className = 'item-sub';
        sub.textContent = seg.description;
        card.appendChild(sub);
      }

      segList.appendChild(card);
    }
  }
}

function renderTranscriptTab() {
  const statusEl = document.getElementById('transcript-status') as HTMLElement;
  const listEl = document.getElementById('transcript-list') as HTMLElement;
  const hideSponsors = (document.getElementById('hide-sponsors-toggle') as HTMLInputElement).checked;
  listEl.textContent = '';

  if (!videoState?.meta) {
    statusEl.textContent = 'Open a YouTube video to inspect its transcript.';
    return;
  }

  const rawCues = videoState.transcript;
  if (rawCues.length === 0) {
    statusEl.textContent =
      videoState.transcriptError || 'Transcript unavailable for this video.';
    return;
  }

  const allSegs = [...videoState.sponsorSegments, ...videoState.aiSponsors];
  const stripped = stripSponsorSegmentsFromTranscript(rawCues, allSegs);
  const cuesToRender = hideSponsors ? stripped.cleanedCues : rawCues;
  const filtered = cuesToRender.filter((c) =>
    transcriptSearch ? c.text.toLowerCase().includes(transcriptSearch.toLowerCase()) : true
  );

  statusEl.textContent = `${filtered.length} lines shown · ${stripped.removedCueCount} sponsor cues (${stripped.removedDurationSec}s) ${hideSponsors ? 'hidden' : 'marked'}`;

  const sponsorRanges = allSegs.filter(
    (s) => !s.disabled && s.category !== 'chapter' && s.category !== 'poi_highlight'
  );

  for (const cue of filtered.slice(0, 600)) {
    const row = document.createElement('div');
    const isSponsor =
      !hideSponsors &&
      sponsorRanges.some((r) => cue.startSec >= r.startTime && cue.startSec <= r.endTime);
    row.className = `cue-row${isSponsor ? ' is-sponsor' : ''}`;
    row.addEventListener('click', () => void seekVideo(cue.startSec));

    const ts = document.createElement('span');
    ts.className = 'ts-badge';
    ts.textContent = formatTimestamp(cue.startSec);

    const text = document.createElement('span');
    text.textContent = cue.text;

    row.append(ts, text);
    listEl.appendChild(row);
  }
}

async function saveInterestUpdate(partial: Partial<ExtensionSettings>) {
  const res = await sendMessage<{ settings: ExtensionSettings }>({
    type: 'SETTINGS_SAVE',
    settings: partial,
  });
  settings = res.settings;
  renderInterestFilterBar();
  renderSettingsInterestChips();
  renderWatchingTab();
}

function renderTopicChips(
  containerId: string,
  topics: string[],
  kind: 'ignore' | 'care',
  onRemove: (topic: string) => void
) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.textContent = '';

  if (topics.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted-small';
    empty.textContent = kind === 'ignore' ? 'No ignored topics yet.' : 'No priority topics yet.';
    container.appendChild(empty);
    return;
  }

  for (const topic of topics) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `topic-chip ${kind === 'ignore' ? 'topic-chip-ignore' : 'topic-chip-care'}`;
    chip.textContent = `${topic} ✕`;
    chip.title = `Remove "${topic}"`;
    chip.addEventListener('click', () => onRemove(topic));
    container.appendChild(chip);
  }
}

function renderInterestFilterBar() {
  const autoSkipEl = document.getElementById('quick-autoskip-toggle') as HTMLInputElement | null;
  if (autoSkipEl) autoSkipEl.checked = settings.autoSkipIgnoredChapters;
  const hideEl = document.getElementById('hide-skipped-toggle') as HTMLInputElement | null;
  if (hideEl) hideEl.checked = settings.hideIgnoredChapters;

  const countLabel = document.getElementById('interest-count-label');
  if (countLabel) {
    countLabel.textContent = String(settings.topicsIgnore.length);
  }

  renderTopicChips('quick-ignore-chips', settings.topicsIgnore, 'ignore', (topic) => {
    void saveInterestUpdate({ topicsIgnore: removeTopic(settings.topicsIgnore, topic) });
  });
}

function renderSettingsInterestChips() {
  const autoSkipEl = document.getElementById('set-autoskip-ignored') as HTMLInputElement | null;
  if (autoSkipEl) autoSkipEl.checked = settings.autoSkipIgnoredChapters;
  const autoReturnEl = document.getElementById('set-autoreturn-bridge') as HTMLInputElement | null;
  if (autoReturnEl) autoReturnEl.checked = settings.autoReturnAfterBridgeCapture;

  renderTopicChips('set-ignore-chips', settings.topicsIgnore, 'ignore', (topic) => {
    void saveInterestUpdate({ topicsIgnore: removeTopic(settings.topicsIgnore, topic) });
  });
  renderTopicChips('set-care-chips', settings.topicsCare, 'care', (topic) => {
    void saveInterestUpdate({ topicsCare: removeTopic(settings.topicsCare, topic) });
  });
}

async function openOrSeekVideo(videoId: string, seconds: number) {
  const targetSec = Math.max(0, Math.floor(seconds));
  const ytTabs = await chrome.tabs.query({
    url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
  });
  const matching = ytTabs.find((t) => t.url?.includes(videoId));
  if (matching?.id) {
    activeTabId = matching.id;
    await chrome.tabs.update(matching.id, { active: true }).catch(() => {});
    await sendTabMessage(matching.id, { type: 'SEEK_TO', seconds: targetSec }).catch(() => {});
    return;
  }
  await chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${videoId}&t=${targetSec}s`,
  });
}

function renderCategoryChips() {
  const wrap = document.getElementById('kb-category-chips');
  if (!wrap) return;
  wrap.innerHTML = '';

  const categories = settings.kbCategories?.length
    ? settings.kbCategories
    : ['Work', 'AI & Tech', 'Learning', 'Personal'];

  const makeChip = (label: string, value: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip${!kbViewingTrash && kbCategoryFilter === value ? ' active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      kbViewingTrash = false;
      kbCategoryFilter = value;
      renderKbTab();
    });
    return btn;
  };

  wrap.appendChild(makeChip('All', 'all'));
  for (const cat of categories) {
    wrap.appendChild(makeChip(cat, cat));
  }
  wrap.appendChild(makeChip('Uncategorized', 'uncategorized'));

  if (addingCategoryInline) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input input-sm';
    input.placeholder = 'New category...';
    input.style.width = '110px';
    input.style.padding = '2px 6px';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        addingCategoryInline = false;
        if (val) {
          const nextCats = addUniqueTopic(categories, val);
          kbCategoryFilter = val;
          kbViewingTrash = false;
          void saveInterestUpdate({ kbCategories: nextCats }).then(() => {
            renderKbTab();
          });
        } else {
          renderKbTab();
        }
      } else if (e.key === 'Escape') {
        addingCategoryInline = false;
        renderKbTab();
      }
    });
    input.addEventListener('blur', () => {
      addingCategoryInline = false;
      renderKbTab();
    });
    wrap.appendChild(input);
    window.setTimeout(() => input.focus(), 0);
  } else {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'chip';
    addBtn.textContent = '+';
    addBtn.title = 'Add custom Library category (e.g. Work)';
    addBtn.addEventListener('click', () => {
      addingCategoryInline = true;
      renderKbTab();
    });
    wrap.appendChild(addBtn);
  }
}

function renderKbTab() {
  const activeEntries = getActiveEntries(kbEntries);
  const trashedEntries = getTrashedEntries(kbEntries);
  const entityCount = activeEntries.reduce((acc, e) => acc + e.entities.length, 0);
  const strippedSec = activeEntries.reduce((acc, e) => acc + (e.sponsorTimeStrippedSec || 0), 0);

  (document.getElementById('stat-videos') as HTMLElement).textContent = String(activeEntries.length);
  (document.getElementById('stat-entities') as HTMLElement).textContent = String(entityCount);
  (document.getElementById('stat-saved-time') as HTMLElement).textContent =
    `${Math.round(strippedSec / 60)}m`;

  renderCategoryChips();

  const trashBtn = document.getElementById('kb-trash-tab-btn');
  if (trashBtn) {
    trashBtn.textContent = `🗑 Trash (${trashedEntries.length})`;
    trashBtn.classList.toggle('active', kbViewingTrash);
  }
  const trashBanner = document.getElementById('kb-trash-banner');
  const trashInfo = document.getElementById('kb-trash-info');
  const entityChips = document.getElementById('kb-entity-chips');
  const retentionDays = settings.trashRetentionDays || 30;
  trashBanner?.classList.toggle('hidden', !kbViewingTrash);
  entityChips?.classList.toggle('hidden', kbViewingTrash);
  if (trashInfo) {
    trashInfo.textContent = `${trashedEntries.length} in Recycle Bin (kept ${retentionDays}d before auto-purge).`;
  }

  const list = document.getElementById('kb-list') as HTMLElement;
  list.textContent = '';

  if (kbViewingTrash) {
    const filteredTrash = searchKnowledgeBase(trashedEntries, kbSearch, 'all', 'all');
    if (filteredTrash.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted-small';
      p.textContent = 'Recycle Bin is empty.';
      list.appendChild(p);
      return;
    }

    for (const { entry } of filteredTrash) {
      const card = document.createElement('div');
      card.className = 'item-card';

      const top = document.createElement('div');
      top.className = 'item-top';

      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = entry.title;

      const daysLeft = Math.max(
        1,
        Math.ceil(retentionDays - (Date.now() - (entry.trashedAt ?? Date.now())) / 86_400_000)
      );
      const rowActions = document.createElement('div');
      rowActions.className = 'kb-row-actions';

      const daysBadge = document.createElement('span');
      daysBadge.className = 'muted-small';
      daysBadge.textContent = `${daysLeft}d left`;

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-xs';
      restoreBtn.textContent = '↩ Restore';
      restoreBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'KB_RESTORE', videoId: entry.videoId });
        await loadKb();
        showBanner(`Restored "${entry.title.slice(0, 36)}" to Library!`, 'success');
      });

      const delPermBtn = document.createElement('button');
      delPermBtn.type = 'button';
      delPermBtn.className = 'btn btn-xs btn-danger';
      delPermBtn.textContent = 'Delete';
      delPermBtn.title = 'Delete permanently now';
      delPermBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'KB_DELETE', videoId: entry.videoId });
        await loadKb();
      });

      rowActions.append(daysBadge, restoreBtn, delPermBtn);
      top.append(title, rowActions);

      const sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = `${entry.channelName}${entry.category ? ` · ${entry.category}` : ''}`;

      card.append(top, sub);
      list.appendChild(card);
    }
    return;
  }

  const results = searchKnowledgeBase(activeEntries, kbSearch, kbEntityFilter, kbCategoryFilter);
  if (results.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-small';
    p.textContent =
      activeEntries.length === 0
        ? 'No saved videos yet. Analyze a YouTube video to build your AI Knowledge Base.'
        : 'No matching entries found.';
    list.appendChild(p);
    return;
  }

  const categories = settings.kbCategories?.length
    ? settings.kbCategories
    : ['Work', 'AI & Tech', 'Learning', 'Personal'];

  for (const { entry, bestTimestampSec, matchSnippet } of results) {
    const card = document.createElement('div');
    card.className = 'item-card';

    const top = document.createElement('div');
    top.className = 'item-top';

    const left = document.createElement('div');
    left.className = 'item-left';

    const ts = document.createElement('span');
    ts.className = 'ts-badge';
    ts.textContent = formatTimestamp(bestTimestampSec);
    ts.title = 'Jump to matched timestamp';
    ts.addEventListener('click', (e) => {
      e.stopPropagation();
      void openOrSeekVideo(entry.videoId, bestTimestampSec);
    });

    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = entry.title;

    left.append(ts, title);

    const rowActions = document.createElement('div');
    rowActions.className = 'kb-row-actions';

    if (entry.category?.trim()) {
      const catBadge = document.createElement('span');
      catBadge.className = 'kb-cat-badge';
      catBadge.textContent = entry.category;
      rowActions.appendChild(catBadge);
    }

    const metaBadge = document.createElement('span');
    metaBadge.className = 'src-badge src-ai';
    metaBadge.textContent = `${entry.chapters.length} ch`;

    const quickTrashBtn = document.createElement('button');
    quickTrashBtn.type = 'button';
    quickTrashBtn.className = 'kb-trash-btn';
    quickTrashBtn.textContent = '🗑';
    quickTrashBtn.title = `Move to Recycle Bin (kept ${retentionDays} days)`;
    quickTrashBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendMessage({ type: 'KB_TRASH', videoId: entry.videoId });
      await loadKb();
      showBanner(`Moved to Recycle Bin (kept ${retentionDays}d).`, 'info');
    });

    rowActions.append(metaBadge, quickTrashBtn);
    top.append(left, rowActions);

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = `${entry.channelName} · ${matchSnippet.slice(0, 120)}`;

    card.append(top, sub);

    card.addEventListener('click', () => {
      if (expandedKbIds.has(entry.videoId)) expandedKbIds.delete(entry.videoId);
      else expandedKbIds.add(entry.videoId);
      renderKbTab();
    });

    if (expandedKbIds.has(entry.videoId)) {
      const detail = document.createElement('div');
      detail.className = 'kb-detail';
      detail.addEventListener('click', (e) => e.stopPropagation());

      const tldr = document.createElement('div');
      tldr.className = 'tldr';
      tldr.textContent = entry.tldr || 'No summary.';
      detail.appendChild(tldr);

      const filteredEntities =
        kbEntityFilter && kbEntityFilter !== 'all'
          ? entry.entities.filter((e) => e.type === kbEntityFilter)
          : entry.entities;

      if (filteredEntities.length > 0) {
        const entWrap = document.createElement('div');
        entWrap.className = 'chip-group';
        for (const ent of filteredEntities.slice(0, 30)) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'entity-chip';
          chip.textContent = `${ent.name} (${ent.type}) @ ${formatTimestamp(ent.timestampSec)}`;
          chip.title = ent.note;
          chip.addEventListener('click', () => {
            void openOrSeekVideo(entry.videoId, ent.timestampSec);
          });
          entWrap.appendChild(chip);
        }
        detail.appendChild(entWrap);
      }

      if (entry.tags.length > 0) {
        const tagWrap = document.createElement('div');
        tagWrap.className = 'chip-group';
        for (const tag of entry.tags) {
          const tagChip = document.createElement('button');
          tagChip.type = 'button';
          tagChip.className = 'kb-tag-chip';
          tagChip.textContent = `#${tag}`;
          tagChip.title = `Filter Knowledge Base by #${tag}`;
          tagChip.addEventListener('click', () => {
            kbSearch = tag;
            const searchInput = document.getElementById('kb-search-input') as HTMLInputElement | null;
            if (searchInput) searchInput.value = tag;
            renderKbTab();
          });
          tagWrap.appendChild(tagChip);
        }
        detail.appendChild(tagWrap);
      }

      if (entry.keyTakeaways.length > 0) {
        const tkList = document.createElement('div');
        tkList.className = 'stack-sm';
        for (const tk of entry.keyTakeaways) {
          const row = document.createElement('div');
          row.className = 'takeaway-link';
          row.title = 'Jump to timestamp';
          row.addEventListener('click', () => {
            void openOrSeekVideo(entry.videoId, tk.timestampSec);
          });
          const tkTs = document.createElement('span');
          tkTs.className = 'ts-badge';
          tkTs.textContent = formatTimestamp(tk.timestampSec);
          const tkText = document.createElement('span');
          tkText.textContent = tk.text;
          row.append(tkTs, tkText);
          tkList.appendChild(row);
        }
        detail.appendChild(tkList);
      }

      const catRow = document.createElement('div');
      catRow.className = 'kb-cat-select-row';
      const catLabel = document.createElement('span');
      catLabel.textContent = 'Category';
      const catSel = document.createElement('select');
      catSel.className = 'input kb-cat-select';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'Uncategorized';
      catSel.appendChild(noneOpt);
      for (const c of categories) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        catSel.appendChild(opt);
      }
      if (entry.category && !categories.includes(entry.category)) {
        const extraOpt = document.createElement('option');
        extraOpt.value = entry.category;
        extraOpt.textContent = entry.category;
        catSel.appendChild(extraOpt);
      }
      catSel.value = entry.category || '';
      catSel.addEventListener('change', async () => {
        await sendMessage({
          type: 'KB_SET_CATEGORY',
          videoId: entry.videoId,
          category: catSel.value,
        });
        await loadKb();
      });
      catRow.append(catLabel, catSel);
      detail.appendChild(catRow);

      const actions = document.createElement('div');
      actions.className = 'row-end';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-xs';
      openBtn.textContent = 'Jump / Open';
      openBtn.addEventListener('click', () => {
        void openOrSeekVideo(entry.videoId, bestTimestampSec);
      });

      const mdBtn = document.createElement('button');
      mdBtn.type = 'button';
      mdBtn.className = 'btn btn-xs';
      mdBtn.textContent = 'Export .md';
      mdBtn.addEventListener('click', () => {
        downloadTextFile(
          `${sanitizeFilename(entry.title)}.md`,
          exportEntryToMarkdown(entry),
          'text/markdown'
        );
      });

      const trashBtnCard = document.createElement('button');
      trashBtnCard.type = 'button';
      trashBtnCard.className = 'btn btn-xs btn-danger';
      trashBtnCard.textContent = 'Move to Trash';
      trashBtnCard.addEventListener('click', async () => {
        await sendMessage({ type: 'KB_TRASH', videoId: entry.videoId });
        await loadKb();
        showBanner(`Moved "${entry.title.slice(0, 36)}" to Recycle Bin.`, 'info');
      });

      actions.append(openBtn, mdBtn, trashBtnCard);
      detail.appendChild(actions);
      card.appendChild(detail);
    }

    list.appendChild(card);
  }
}

function renderSettingsTab() {
  (document.getElementById('set-api-provider') as HTMLSelectElement).value = settings.apiProvider;
  (document.getElementById('set-api-key') as HTMLInputElement).value = settings.apiKey;
  (document.getElementById('set-api-model') as HTMLInputElement).value = settings.apiModel;
  (document.getElementById('set-custom-url') as HTMLInputElement).value = settings.customBaseUrl;
  (document.getElementById('set-sub-provider') as HTMLSelectElement).value =
    settings.subscriptionProvider;
  (document.getElementById('set-bridge-pill') as HTMLInputElement).checked =
    settings.bridgePillEnabled;
  (document.getElementById('set-sb-enabled') as HTMLInputElement).checked =
    settings.sponsorBlockEnabled;
  (document.getElementById('set-privacy-prefix') as HTMLInputElement).checked =
    settings.usePrivacyPrefix;
  (document.getElementById('set-strip-ai') as HTMLInputElement).checked =
    settings.stripSponsorsFromAi;
  (document.getElementById('set-ai-sponsors') as HTMLInputElement).checked =
    settings.aiFallbackSponsorDetection;
  (document.getElementById('set-inpage-hud') as HTMLInputElement).checked =
    settings.inPageHudEnabled;
  (document.getElementById('set-shortcuts') as HTMLInputElement).checked =
    settings.shortcutsEnabled;

  (document.getElementById('set-gh-repo') as HTMLInputElement).value = settings.githubRepo;
  (document.getElementById('set-gh-branch') as HTMLInputElement).value = settings.githubBranch;
  (document.getElementById('set-gh-folder') as HTMLInputElement).value = settings.githubFolder;
  (document.getElementById('set-gh-token') as HTMLInputElement).value = settings.githubToken;
  (document.getElementById('set-gh-autopush') as HTMLInputElement).checked =
    settings.githubAutoPush;

  renderSettingsInterestChips();
  renderInterestFilterBar();

  const customField = document.getElementById('custom-url-field');
  customField?.classList.toggle('hidden', settings.apiProvider !== 'custom');

  const rulesGrid = document.getElementById('category-rules-grid') as HTMLElement;
  rulesGrid.textContent = '';
  for (const cat of ALL_SPONSOR_CATEGORIES) {
    const row = document.createElement('div');
    row.className = 'rule-row';

    const left = document.createElement('div');
    left.className = 'rule-left';
    const dot = document.createElement('span');
    dot.className = 'seg-dot';
    dot.style.background = CATEGORY_COLORS[cat];
    const lbl = document.createElement('span');
    lbl.textContent = CATEGORY_LABELS[cat];
    left.append(dot, lbl);

    const sel = document.createElement('select');
    sel.className = 'input rule-select';
    sel.dataset.category = cat;
    for (const optVal of ['skip', 'mute', 'show', 'ignore'] as CategoryRule[]) {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = optVal[0]!.toUpperCase() + optVal.slice(1);
      sel.appendChild(opt);
    }
    sel.value = settings.categoryRules[cat] ?? 'show';

    row.append(left, sel);
    rulesGrid.appendChild(row);
  }
}

async function loadKb() {
  const res = await sendMessage<{ entries: KnowledgeEntry[] }>({ type: 'KB_LIST' });
  kbEntries = res.entries ?? [];
  renderKbTab();
  renderOpenTabsBar();
}

async function syncActiveYouTubeTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isHeadless = (u?: string) => Boolean(u && u.includes('cm_headless=1'));
  if (!tab?.id || !tab.url?.includes('youtube.com/watch') || isHeadless(tab.url)) {
    const ytTabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
      currentWindow: true,
    });
    tab = ytTabs.find((t) => !isHeadless(t.url)) ?? undefined;
  }
  activeTabId = tab?.id ?? null;

  if (!tab?.id || !tab.url?.includes('youtube.com/') || isHeadless(tab.url)) {
    videoState = null;
    renderWatchingTab();
    renderTranscriptTab();
    void refreshOpenYouTubeTabs();
    return;
  }

  try {
    const res = await sendTabMessage<{ state: ActiveVideoState }>(tab.id, {
      type: 'GET_ACTIVE_VIDEO_STATE',
    });
    videoState = res?.state ?? null;
    if (videoState) {
      tabStateByTabId.set(tab.id, videoState);
    }
  } catch {
    videoState = null;
  }

  renderWatchingTab();
  renderTranscriptTab();
  void refreshOpenYouTubeTabs();
}

function collectSettingsFromForm(): Partial<ExtensionSettings> {
  const categoryRules = { ...settings.categoryRules };
  document.querySelectorAll('#category-rules-grid select').forEach((el) => {
    const sel = el as HTMLSelectElement;
    const cat = sel.dataset.category as SponsorCategory | undefined;
    if (cat) {
      categoryRules[cat] = sel.value as CategoryRule;
    }
  });

  return {
    apiProvider: (document.getElementById('set-api-provider') as HTMLSelectElement)
      .value as ExtensionSettings['apiProvider'],
    apiKey: (document.getElementById('set-api-key') as HTMLInputElement).value.trim(),
    apiModel: (document.getElementById('set-api-model') as HTMLInputElement).value.trim(),
    customBaseUrl: (document.getElementById('set-custom-url') as HTMLInputElement).value.trim(),
    subscriptionProvider: (document.getElementById('set-sub-provider') as HTMLSelectElement)
      .value as SubscriptionProvider,
    bridgePillEnabled: (document.getElementById('set-bridge-pill') as HTMLInputElement).checked,
    sponsorBlockEnabled: (document.getElementById('set-sb-enabled') as HTMLInputElement).checked,
    usePrivacyPrefix: (document.getElementById('set-privacy-prefix') as HTMLInputElement).checked,
    stripSponsorsFromAi: (document.getElementById('set-strip-ai') as HTMLInputElement).checked,
    aiFallbackSponsorDetection: (
      document.getElementById('set-ai-sponsors') as HTMLInputElement
    ).checked,
    inPageHudEnabled: (document.getElementById('set-inpage-hud') as HTMLInputElement).checked,
    shortcutsEnabled: (document.getElementById('set-shortcuts') as HTMLInputElement).checked,
    autoSkipIgnoredChapters: (
      document.getElementById('set-autoskip-ignored') as HTMLInputElement
    ).checked,
    autoReturnAfterBridgeCapture: (
      document.getElementById('set-autoreturn-bridge') as HTMLInputElement
    ).checked,
    githubRepo: (document.getElementById('set-gh-repo') as HTMLInputElement).value.trim(),
    githubBranch:
      (document.getElementById('set-gh-branch') as HTMLInputElement).value.trim() || 'main',
    githubFolder:
      (document.getElementById('set-gh-folder') as HTMLInputElement).value.trim() ||
      'knowledge-base',
    githubToken: (document.getElementById('set-gh-token') as HTMLInputElement).value.trim(),
    githubAutoPush: (document.getElementById('set-gh-autopush') as HTMLInputElement).checked,
    categoryRules,
  };
}

function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      hideBanner();
      const target = (btn as HTMLElement).dataset.tab;
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${target}`)?.classList.add('active');
      if (target === 'kb') void loadKb();
    });
  });

  // Interest filter quick controls (Now Watching tab)
  document.getElementById('quick-autoskip-toggle')?.addEventListener('change', (e) => {
    void saveInterestUpdate({
      autoSkipIgnoredChapters: (e.currentTarget as HTMLInputElement).checked,
    });
  });

  document.getElementById('hide-skipped-toggle')?.addEventListener('change', (e) => {
    void saveInterestUpdate({
      hideIgnoredChapters: (e.currentTarget as HTMLInputElement).checked,
    });
  });

  const addQuickIgnore = () => {
    const input = document.getElementById('quick-ignore-input') as HTMLInputElement | null;
    const val = input?.value.trim() ?? '';
    if (!val) return;
    if (input) input.value = '';
    void saveInterestUpdate({
      topicsIgnore: addUniqueTopic(settings.topicsIgnore, val),
      topicsCare: removeTopic(settings.topicsCare, val),
    }).then(() => {
      showBanner(`Added "${val}" to Don't Care auto-skip list!`, 'success');
    });
  };
  document.getElementById('quick-ignore-add-btn')?.addEventListener('click', addQuickIgnore);
  document.getElementById('quick-ignore-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addQuickIgnore();
    }
  });

  // Settings Interest Profile add controls
  const addSetIgnore = () => {
    const input = document.getElementById('set-ignore-input') as HTMLInputElement | null;
    const val = input?.value.trim() ?? '';
    if (!val) return;
    if (input) input.value = '';
    void saveInterestUpdate({
      topicsIgnore: addUniqueTopic(settings.topicsIgnore, val),
      topicsCare: removeTopic(settings.topicsCare, val),
    });
  };
  document.getElementById('set-ignore-add-btn')?.addEventListener('click', addSetIgnore);
  document.getElementById('set-ignore-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSetIgnore();
    }
  });

  const addSetCare = () => {
    const input = document.getElementById('set-care-input') as HTMLInputElement | null;
    const val = input?.value.trim() ?? '';
    if (!val) return;
    if (input) input.value = '';
    void saveInterestUpdate({
      topicsCare: addUniqueTopic(settings.topicsCare, val),
      topicsIgnore: removeTopic(settings.topicsIgnore, val),
    });
  };
  document.getElementById('set-care-add-btn')?.addEventListener('click', addSetCare);
  document.getElementById('set-care-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSetCare();
    }
  });

  document.getElementById('refresh-btn')?.addEventListener('click', async () => {
    hideBanner();
    if (activeTabId) {
      await sendTabMessage(activeTabId, { type: 'REFRESH_VIDEO' }).catch(() => {});
    }
    await syncActiveYouTubeTab();
  });

  document.getElementById('visual-timeline')?.addEventListener('click', (e) => {
    if (!videoState?.meta) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    void seekVideo(ratio * videoState.meta.durationSec);
  });

  document.getElementById('prev-ch-btn')?.addEventListener('click', () => {
    if (!videoState) return;
    const target = getAdjacentChapter(getMergedChapters(), videoState.currentTimeSec, 'prev');
    if (target) void seekVideo(target.startTime);
  });

  document.getElementById('next-ch-btn')?.addEventListener('click', () => {
    if (!videoState) return;
    const target = getAdjacentChapter(getMergedChapters(), videoState.currentTimeSec, 'next');
    if (target) void seekVideo(target.startTime);
  });

  document.getElementById('tldr-toggle-btn')?.addEventListener('click', (e) => {
    const tldr = document.getElementById('video-tldr');
    const btn = e.currentTarget as HTMLButtonElement;
    if (!tldr) return;
    const expanded = !tldr.classList.toggle('clamped');
    btn.textContent = expanded ? 'Less' : 'More';
  });

  document.querySelectorAll('#chapter-mode-chips .seg-btn').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const mode = (chip as HTMLElement).dataset.mode as ChapterFilterMode;
      const res = await sendMessage<{ settings: ExtensionSettings }>({
        type: 'SETTINGS_SAVE',
        settings: { chapterFilterMode: mode },
      });
      settings = res.settings;
      renderWatchingTab();
    });
  });

  document.getElementById('chapter-search')?.addEventListener('input', (e) => {
    chapterSearch = (e.target as HTMLInputElement).value;
    renderWatchingTab();
  });

  // Analyze via API (safe across concurrent multi-tab / multi-video switches)
  document.getElementById('analyze-api-btn')?.addEventListener('click', async () => {
    if (!videoState?.meta) return;
    if (videoState.transcript.length === 0) {
      showBanner('No transcript available for this video yet.', 'error');
      return;
    }

    const targetMeta = videoState.meta;
    const targetVideoId = targetMeta.videoId;
    if (analyzingVideoIds.has(targetVideoId)) return;

    const targetTranscript = [...videoState.transcript];
    const targetChapters = [...videoState.youtubeChapters];
    const targetSponsors = [...videoState.sponsorSegments];

    analyzingVideoIds.add(targetVideoId);
    updateAnalyzeButtonState();
    renderOpenTabsBar();
    showBanner(`Analyzing "${targetMeta.title.slice(0, 42)}" via AI API...`, 'info');

    try {
      const res = await sendMessage<{ entry: KnowledgeEntry }>({
        type: 'ANALYZE_VIDEO_API',
        meta: targetMeta,
        transcript: targetTranscript,
        youtubeChapters: targetChapters,
        sponsorSegments: targetSponsors,
      });

      for (const [tid, st] of tabStateByTabId.entries()) {
        if (st.meta?.videoId === res.entry.videoId) {
          tabStateByTabId.set(tid, {
            ...st,
            kbEntry: res.entry,
            aiSponsors: res.entry.aiSponsors,
          });
        }
      }

      if (videoState?.meta?.videoId === res.entry.videoId) {
        videoState.kbEntry = res.entry;
        videoState.aiSponsors = res.entry.aiSponsors;
        renderWatchingTab();
      }
      await loadKb();
      showBanner(
        `Saved ${res.entry.chapters.length} AI chapters for "${res.entry.title.slice(0, 36)}"!`,
        'success'
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'API analysis failed', 'error');
    } finally {
      analyzingVideoIds.delete(targetVideoId);
      updateAnalyzeButtonState();
      renderOpenTabsBar();
    }
  });

  // Subscription Bridge buttons (Gemini / ChatGPT / Claude)
  document.querySelectorAll('[data-bridge-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!videoState?.meta) return;
      if (videoState.transcript.length === 0) {
        showBanner('No transcript loaded yet for this video.', 'error');
        return;
      }
      const provider = (btn as HTMLElement).dataset.bridgeProvider as SubscriptionProvider;
      try {
        const res = await sendMessage<{ prompt: string }>({
          type: 'START_SUBSCRIPTION_BRIDGE',
          provider,
          kind: 'analyze_video',
          meta: videoState.meta,
          transcript: videoState.transcript,
          youtubeChapters: videoState.youtubeChapters,
          sponsorSegments: videoState.sponsorSegments,
          tabId: activeTabId ?? undefined,
        });
        await navigator.clipboard.writeText(res.prompt).catch(() => {});
        showBanner(
          `Opened ${provider} & copied sponsor-free prompt! Use the floating Bridge Pill ("Paste Prompt" → "Capture Reply") or paste below.`,
          'success'
        );
      } catch (err) {
        showBanner(err instanceof Error ? err.message : 'Could not launch bridge', 'error');
      }
    });
  });

  // Manual Paste Reply
  document.getElementById('toggle-manual-paste-btn')?.addEventListener('click', () => {
    document.getElementById('manual-paste-box')?.classList.toggle('hidden');
  });

  document.getElementById('copy-prompt-only-btn')?.addEventListener('click', async () => {
    if (!videoState?.meta || videoState.transcript.length === 0) {
      showBanner('Need an active YouTube video with transcript first.', 'error');
      return;
    }
    const stripped = stripSponsorSegmentsFromTranscript(
      videoState.transcript,
      videoState.sponsorSegments
    );
    const { buildVideoAnalysisPrompt } = await import('../shared/prompts');
    const { formatTranscriptForPrompt } = await import('../shared/transcript');
    const formatted = formatTranscriptForPrompt(stripped.cleanedCues);
    const prompt = buildVideoAnalysisPrompt(
      videoState.meta,
      formatted.text,
      videoState.youtubeChapters,
      videoState.sponsorSegments.filter((s) => s.category !== 'chapter').length,
      {
        topicsCare: settings.topicsCare,
        topicsIgnore: settings.topicsIgnore,
      }
    );
    await navigator.clipboard.writeText(prompt);
    showBanner('Copied sponsor-free AI prompt to clipboard!', 'success');
  });

  document.getElementById('import-manual-btn')?.addEventListener('click', async () => {
    if (!videoState?.meta) return;
    const rawText = (document.getElementById('manual-paste-input') as HTMLTextAreaElement).value;
    if (!rawText.trim()) {
      showBanner('Paste the AI reply JSON first.', 'error');
      return;
    }
    try {
      const res = await sendMessage<{ entry: KnowledgeEntry }>({
        type: 'PARSE_MANUAL_ANALYSIS',
        rawText,
        meta: videoState.meta,
        transcript: videoState.transcript,
        sponsorSegments: videoState.sponsorSegments,
      });
      videoState.kbEntry = res.entry;
      videoState.aiSponsors = res.entry.aiSponsors;
      document.getElementById('manual-paste-box')?.classList.add('hidden');
      renderWatchingTab();
      await loadKb();
      showBanner(`Imported ${res.entry.chapters.length} chapters into KB!`, 'success');
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Failed to parse reply', 'error');
    }
  });

  // Transcript tab
  document
    .getElementById('hide-sponsors-toggle')
    ?.addEventListener('change', () => renderTranscriptTab());
  document.getElementById('transcript-search')?.addEventListener('input', (e) => {
    transcriptSearch = (e.target as HTMLInputElement).value;
    renderTranscriptTab();
  });
  document.getElementById('copy-transcript-btn')?.addEventListener('click', async () => {
    if (!videoState?.transcript.length) return;
    const stripped = stripSponsorSegmentsFromTranscript(
      videoState.transcript,
      [...videoState.sponsorSegments, ...videoState.aiSponsors]
    );
    const text = stripped.cleanedCues
      .map((c) => `[${formatTimestamp(c.startSec)}] ${c.text}`)
      .join('\n');
    await navigator.clipboard.writeText(text);
    showBanner(`Copied ${stripped.cleanedCues.length} sponsor-free transcript lines!`, 'success');
  });

  // KB tab
  document.getElementById('kb-search-input')?.addEventListener('input', (e) => {
    kbSearch = (e.target as HTMLInputElement).value;
    renderKbTab();
  });

  document.querySelectorAll('#kb-entity-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      kbEntityFilter = (chip as HTMLElement).dataset.entity || 'all';
      document.querySelectorAll('#kb-entity-chips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderKbTab();
    });
  });

  document.getElementById('ask-kb-api-btn')?.addEventListener('click', async (e) => {
    const q = (document.getElementById('kb-question-input') as HTMLTextAreaElement).value.trim();
    if (!q) return;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    const ansBox = document.getElementById('kb-answer-box') as HTMLElement;
    ansBox.classList.remove('hidden');
    ansBox.textContent = 'Searching Knowledge Base & querying AI API...';
    try {
      const res = await sendMessage<{ answer: string }>({ type: 'ASK_KB_API', question: q });
      ansBox.textContent = res.answer;
    } catch (err) {
      ansBox.textContent = err instanceof Error ? err.message : 'Query failed';
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll('[data-ask-sub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const q = (document.getElementById('kb-question-input') as HTMLTextAreaElement).value.trim();
      if (!q) {
        showBanner('Enter a question for your Knowledge Base first.', 'error');
        return;
      }
      const provider = (btn as HTMLElement).dataset.askSub as SubscriptionProvider;
      try {
        const res = await sendMessage<{ prompt: string }>({
          type: 'START_SUBSCRIPTION_BRIDGE',
          provider,
          kind: 'ask_kb',
          question: q,
        });
        await navigator.clipboard.writeText(res.prompt).catch(() => {});
        showBanner(
          `Opened ${provider} with your Knowledge Base context! Click "Paste Prompt" → "Capture Reply" on the floating pill.`,
          'success'
        );
      } catch (err) {
        showBanner(err instanceof Error ? err.message : 'Bridge launch failed', 'error');
      }
    });
  });

  document.getElementById('git-push-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    showBanner('Pushing Knowledge Base JSON & Markdown to GitHub...', 'info');
    try {
      const res = await sendMessage<{
        pushedFiles: number;
        skippedFiles: number;
        videoCount: number;
      }>({ type: 'GITHUB_PUSH_ALL' });
      showBanner(
        `Synced ${res.videoCount} video(s) to GitHub (${res.pushedFiles} updated, ${res.skippedFiles} unchanged).`,
        'success'
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'GitHub push failed', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('git-fetch-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    showBanner('Fetching Knowledge Base from GitHub...', 'info');
    try {
      const res = await sendMessage<{ fetchedCount: number; totalRemote: number }>({
        type: 'GITHUB_FETCH_ALL',
      });
      const settingsRes = await sendMessage<{ settings: ExtensionSettings }>({
        type: 'SETTINGS_GET',
      });
      settings = settingsRes.settings;
      renderSettingsTab();
      await loadKb();
      showBanner(
        `Fetched ${res.fetchedCount} new/updated video(s) from GitHub (${res.totalRemote} total remote).`,
        'success'
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'GitHub fetch failed', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  const openConfiguredGithubRepo = () => {
    const formRepo = (document.getElementById('set-gh-repo') as HTMLInputElement | null)?.value.trim();
    const formBranch = (
      document.getElementById('set-gh-branch') as HTMLInputElement | null
    )?.value.trim();
    const formFolder = (
      document.getElementById('set-gh-folder') as HTMLInputElement | null
    )?.value.trim();

    const repoInput = formRepo || settings.githubRepo;
    if (!repoInput.trim()) {
      showBanner('Set your GitHub repo in Settings → GitHub Knowledge Base Sync first.', 'error');
      return;
    }

    try {
      const { owner, repo } = parseGithubRepo(repoInput);
      const branch = formBranch || settings.githubBranch || 'main';
      const folder = (formFolder || settings.githubFolder || 'knowledge-base').replace(
        /^\/+|\/+$/g,
        ''
      );
      const url = folder
        ? `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}/${folder}`
        : `https://github.com/${owner}/${repo}`;
      void chrome.tabs.create({ url });
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Invalid GitHub repository', 'error');
    }
  };

  document.getElementById('git-open-btn')?.addEventListener('click', openConfiguredGithubRepo);
  document.getElementById('open-gh-repo-btn')?.addEventListener('click', openConfiguredGithubRepo);

  document.getElementById('export-all-md-btn')?.addEventListener('click', () => {
    const active = getActiveEntries(kbEntries);
    if (active.length === 0) return;
    downloadTextFile('chaptermind-knowledge-base.md', exportAllToMarkdown(active), 'text/markdown');
  });

  document.getElementById('export-all-json-btn')?.addEventListener('click', () => {
    const active = getActiveEntries(kbEntries);
    if (active.length === 0) return;
    downloadTextFile(
      'chaptermind-knowledge-base.json',
      JSON.stringify(active, null, 2),
      'application/json'
    );
  });

  document.getElementById('kb-trash-tab-btn')?.addEventListener('click', () => {
    kbViewingTrash = !kbViewingTrash;
    renderKbTab();
  });

  document.getElementById('kb-empty-trash-btn')?.addEventListener('click', async () => {
    const res = await sendMessage<{ ok: boolean; deletedCount: number }>({ type: 'KB_EMPTY_TRASH' });
    await loadKb();
    showBanner(`Permanently deleted ${res.deletedCount} trashed item(s).`, 'info');
  });

  document.getElementById('import-json-input')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as KnowledgeEntry[];
      if (!Array.isArray(parsed)) throw new Error('Expected JSON array of KnowledgeEntry items.');
      await sendMessage({ type: 'KB_IMPORT_BULK', entries: parsed });
      await loadKb();
      showBanner(`Imported ${parsed.length} Knowledge Base entries!`, 'success');
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'JSON import failed', 'error');
    }
  });

  // Settings tab
  document.getElementById('set-api-provider')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value as ExtensionSettings['apiProvider'];
    document.getElementById('custom-url-field')?.classList.toggle('hidden', val !== 'custom');
    const modelInput = document.getElementById('set-api-model') as HTMLInputElement;
    if (val === 'gemini' && !modelInput.value) modelInput.value = 'gemini-2.5-flash';
    if (val === 'openai' && (!modelInput.value || modelInput.value.startsWith('gemini'))) {
      modelInput.value = 'gpt-4.1-mini';
    }
    if (val === 'anthropic' && (!modelInput.value || modelInput.value.startsWith('gemini'))) {
      modelInput.value = 'claude-sonnet-4-20250514';
    }
  });

  document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
    const partial = collectSettingsFromForm();
    const res = await sendMessage<{ settings: ExtensionSettings }>({
      type: 'SETTINGS_SAVE',
      settings: partial,
    });
    settings = res.settings;
    showBanner('Settings saved!', 'success');
  });

  document.getElementById('queue-clear-done-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void sendMessage<{ jobs: QueueJob[] }>({ type: 'QUEUE_CLEAR_DONE' }).then((res) => {
      queueJobs = res.jobs ?? [];
      renderQueueCard();
    });
  });

  document.getElementById('logs-copy-btn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (activityLogs.length === 0) {
      showBanner('No activity logs to copy yet.', 'info');
      return;
    }
    await navigator.clipboard.writeText(formatActivityLogsText(activityLogs));
    showBanner(`Copied ${activityLogs.length} log entries to clipboard!`, 'success');
  });

  document.getElementById('logs-clear-btn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await sendMessage({ type: 'LOGS_CLEAR' });
    activityLogs = [];
    renderLogsDrawer();
  });

  document.getElementById('queue-open-tabs-btn')?.addEventListener('click', async () => {
    try {
      const res = await sendMessage<{
        ok: boolean;
        queuedCount: number;
        skippedSavedCount: number;
        jobs: QueueJob[];
      }>({ type: 'QUEUE_ADD_OPEN_TABS', onlyUnsaved: true });
      queueJobs = res.jobs ?? [];
      renderQueueCard();
      renderOpenTabsBar();
      if (res.queuedCount > 0) {
        showBanner(
          `Queued ${res.queuedCount} open YouTube video${res.queuedCount > 1 ? 's' : ''} in Library → Headless Queue!`,
          'success'
        );
      } else {
        showBanner(
          `All ${res.skippedSavedCount} open YouTube videos are already in your Library.`,
          'info'
        );
      }
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Could not queue open tabs', 'error');
    }
  });

  document.getElementById('queue-add-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('queue-url-input') as HTMLInputElement | null;
    const raw = input?.value.trim() ?? '';
    if (!raw) return;
    const ids = extractAllYouTubeVideoIds(raw);
    if (ids.length === 0) {
      showBanner('Could not recognize a valid YouTube URL or 11-char video ID.', 'error');
      return;
    }

    if (ids.length === 1) {
      const res = await sendMessage<{ ok: boolean; jobs: QueueJob[] }>({
        type: 'QUEUE_ADD',
        urlOrId: ids[0]!,
      });
      if (!res.ok) {
        showBanner('Could not recognize a valid YouTube URL or 11-char video ID.', 'error');
        return;
      }
      queueJobs = res.jobs ?? [];
      showBanner('Queued video for headless background analysis!', 'success');
    } else {
      const res = await sendMessage<{ ok: boolean; addedCount: number; jobs: QueueJob[] }>({
        type: 'QUEUE_ADD_BATCH',
        items: ids.map((id) => ({ urlOrId: id })),
      });
      queueJobs = res.jobs ?? [];
      showBanner(`Queued ${res.addedCount} videos for headless analysis!`, 'success');
    }

    if (input) input.value = '';
    renderQueueCard();
    renderOpenTabsBar();
  });

  document.getElementById('queue-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('queue-add-btn')?.click();
    }
  });

  document.getElementById('save-gh-settings-btn')?.addEventListener('click', async () => {
    const partial = collectSettingsFromForm();
    const res = await sendMessage<{ settings: ExtensionSettings }>({
      type: 'SETTINGS_SAVE',
      settings: partial,
    });
    settings = res.settings;
    showBanner('GitHub Sync settings saved!', 'success');
  });

  document.getElementById('toggle-gh-token-btn')?.addEventListener('click', (e) => {
    const input = document.getElementById('set-gh-token') as HTMLInputElement | null;
    const btn = e.currentTarget as HTMLButtonElement;
    if (!input) return;
    const revealing = input.type === 'password';
    input.type = revealing ? 'text' : 'password';
    btn.textContent = revealing ? 'Hide' : 'Show';
  });

  document.getElementById('test-gh-btn')?.addEventListener('click', async () => {
    const candidate = { ...settings, ...collectSettingsFromForm() };
    showBanner('Testing GitHub repository access...', 'info');
    try {
      const res = await sendMessage<{
        info: { fullName: string; isPrivate: boolean; canPush: boolean; defaultBranch: string };
      }>({
        type: 'GITHUB_TEST_CONNECTION',
        settings: candidate,
      });
      const savedRes = await sendMessage<{ settings: ExtensionSettings }>({
        type: 'SETTINGS_SAVE',
        settings: collectSettingsFromForm(),
      });
      settings = savedRes.settings;
      const access = res.info.canPush ? 'Read & Write' : 'Read-only';
      showBanner(
        `Connected & saved! ${res.info.fullName} (${res.info.isPrivate ? 'Private' : 'Public'}, ${access})`,
        'success'
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'GitHub test failed', 'error');
    }
  });

  document.getElementById('test-api-btn')?.addEventListener('click', async () => {
    const candidate = { ...settings, ...collectSettingsFromForm() };
    showBanner('Testing AI API connection...', 'info');
    try {
      const res = await sendMessage<{ reply: string }>({
        type: 'TEST_API_CONNECTION',
        settings: candidate,
      });
      showBanner(`API connected! Reply: "${res.reply}"`, 'success');
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'API test failed', 'error');
    }
  });
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender) => {
  if (msg.type === 'VIDEO_STATE_CHANGED') {
    if (sender.tab?.url?.includes('cm_headless=1')) {
      return;
    }
    if (sender.tab?.id) {
      tabStateByTabId.set(sender.tab.id, msg.state);
      // Never let an inactive background YouTube tab overwrite the currently inspected video
      if (!sender.tab.active && sender.tab.id !== activeTabId) {
        renderOpenTabsBar();
        return;
      }
      if (sender.tab.active) {
        activeTabId = sender.tab.id;
      }
    }
    videoState = msg.state;
    const nextSig = getWatchingRenderSignature();
    if (nextSig === lastWatchingRenderSig) {
      updateWatchingPlaybackOnly();
    } else {
      renderWatchingTab();
      renderTranscriptTab();
    }
    renderOpenTabsBar();
  } else if (msg.type === 'SETTINGS_UPDATED') {
    settings = msg.settings;
    renderWatchingTab();
    renderTranscriptTab();
    renderSettingsInterestChips();
  } else if (msg.type === 'ANALYSIS_COMPLETED') {
    for (const [tid, st] of tabStateByTabId.entries()) {
      if (st.meta?.videoId === msg.entry.videoId) {
        tabStateByTabId.set(tid, {
          ...st,
          kbEntry: msg.entry,
          aiSponsors: msg.entry.aiSponsors,
        });
      }
    }
    if (videoState?.meta?.videoId === msg.entry.videoId) {
      videoState.kbEntry = msg.entry;
      videoState.aiSponsors = msg.entry.aiSponsors;
      renderWatchingTab();
    }
    void loadKb();
  } else if (msg.type === 'BRIDGE_ANALYSIS_READY') {
    for (const [tid, st] of tabStateByTabId.entries()) {
      if (st.meta?.videoId === msg.entry.videoId) {
        tabStateByTabId.set(tid, {
          ...st,
          kbEntry: msg.entry,
          aiSponsors: msg.entry.aiSponsors,
        });
      }
    }
    if (videoState?.meta?.videoId === msg.entry.videoId) {
      videoState.kbEntry = msg.entry;
      videoState.aiSponsors = msg.entry.aiSponsors;
      renderWatchingTab();
    }
    void loadKb();
    showBanner(
      `Captured ${msg.entry.chapters.length} chapters from AI subscription & saved to KB!`,
      'success'
    );
  } else if (msg.type === 'BRIDGE_KB_ANSWER_READY') {
    const ansBox = document.getElementById('kb-answer-box');
    if (ansBox) {
      ansBox.classList.remove('hidden');
      ansBox.textContent = msg.answer;
    }
    showBanner('Captured answer from your AI subscription!', 'success');
  } else if (msg.type === 'QUEUE_UPDATED') {
    queueJobs = msg.jobs;
    renderQueueCard();
    renderOpenTabsBar();
    updateAnalyzeButtonState();
    if (queueJobs.some((j) => j.status === 'done')) {
      void loadKb();
    }
  } else if (msg.type === 'LOGS_UPDATED') {
    activityLogs = msg.logs;
    renderLogsDrawer();
  }
});

let queueJobs: QueueJob[] = [];
let queueElapsedTimer: number | null = null;

function formatActiveQueueText(status: QueueJob['status'], sinceMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const suffix = sec >= 1 ? ` ${sec}s` : '';
  if (status === 'queued') return `Queued${suffix}`;
  if (status === 'fetching_transcript') return `Extracting captions…${suffix}`;
  if (status === 'analyzing') return `Analyzing AI…${suffix}`;
  return '';
}

function formatQueueStatusLabel(job: QueueJob): { label: string; cls: string; activeSince?: number } {
  const since = job.updatedAt || job.addedAt || Date.now();
  if (job.status === 'queued' || job.status === 'fetching_transcript' || job.status === 'analyzing') {
    return { label: formatActiveQueueText(job.status, since), cls: 'is-running', activeSince: since };
  }
  if (job.status === 'done') {
    const ch = job.chapterCount ?? 0;
    const ent = job.entityCount ?? 0;
    return { label: `✓ ${ch} ch · ${ent} ent`, cls: 'is-done' };
  }
  return { label: 'Failed', cls: 'is-error' };
}

function syncQueueElapsedTimer() {
  const hasRunning = queueJobs.some(
    (j) => j.status === 'queued' || j.status === 'fetching_transcript' || j.status === 'analyzing'
  );
  if (hasRunning && queueElapsedTimer === null) {
    queueElapsedTimer = window.setInterval(() => {
      document.querySelectorAll<HTMLElement>('.queue-badge[data-queue-since]').forEach((el) => {
        const st = el.dataset.queueStatus as QueueJob['status'] | undefined;
        const since = Number(el.dataset.queueSince);
        if (st && Number.isFinite(since)) {
          el.textContent = formatActiveQueueText(st, since);
        }
      });
    }, 1000);
  } else if (!hasRunning && queueElapsedTimer !== null) {
    window.clearInterval(queueElapsedTimer);
    queueElapsedTimer = null;
  }
}

function renderQueueCard() {
  const card = document.getElementById('queue-card') as HTMLDetailsElement | null;
  const badge = document.getElementById('queue-summary-badge');
  const list = document.getElementById('queue-list');
  if (!card || !badge || !list) return;

  if (queueJobs.length === 0) {
    card.classList.add('hidden');
    badge.textContent = '0';
    list.innerHTML = '';
    syncQueueElapsedTimer();
    return;
  }

  card.classList.remove('hidden');
  const activeCount = queueJobs.filter(
    (j) => j.status === 'queued' || j.status === 'fetching_transcript' || j.status === 'analyzing'
  ).length;
  if (activeCount > 0) {
    card.open = true;
  }
  badge.textContent = activeCount > 0 ? `${activeCount} active` : `${queueJobs.length}`;

  list.innerHTML = '';
  for (const job of queueJobs) {
    const item = document.createElement('div');
    item.className = 'queue-item';

    const head = document.createElement('div');
    head.className = 'queue-item-head';

    const title = document.createElement('span');
    title.className = 'queue-item-title';
    title.textContent = job.title || job.videoId;
    title.title = job.title || job.videoId;

    const headActions = document.createElement('div');
    headActions.className = 'kb-row-actions';

    if (job.status === 'fetching_transcript' || job.status === 'analyzing') {
      const forceRetryBtn = document.createElement('button');
      forceRetryBtn.type = 'button';
      forceRetryBtn.className = 'btn btn-ghost btn-xs';
      forceRetryBtn.textContent = '↻';
      forceRetryBtn.title = 'Cancel stuck attempt & retry now';
      forceRetryBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'QUEUE_REMOVE', videoId: job.videoId });
        const res = await sendMessage<{ jobs: QueueJob[] }>({
          type: 'QUEUE_ADD',
          urlOrId: job.videoId,
          title: job.title,
          channelName: job.channelName,
        });
        queueJobs = res.jobs ?? [];
        renderQueueCard();
      });
      headActions.appendChild(forceRetryBtn);
    }

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'btn btn-ghost btn-xs';
    rmBtn.textContent = '✕';
    rmBtn.title = 'Remove / cancel from queue';
    rmBtn.addEventListener('click', () => {
      void sendMessage<{ jobs: QueueJob[] }>({
        type: 'QUEUE_REMOVE',
        videoId: job.videoId,
      }).then((res) => {
        queueJobs = res.jobs ?? [];
        renderQueueCard();
      });
    });

    headActions.appendChild(rmBtn);
    head.append(title, headActions);

    const meta = document.createElement('div');
    meta.className = 'queue-item-meta';

    const statusInfo = formatQueueStatusLabel(job);
    const pill = document.createElement('span');
    pill.className = `queue-badge ${statusInfo.cls}`;
    pill.textContent = statusInfo.label;
    if (statusInfo.activeSince) {
      pill.dataset.queueStatus = job.status;
      pill.dataset.queueSince = String(statusInfo.activeSince);
    }
    if (job.error) pill.title = job.error;

    const actions = document.createElement('span');
    if (job.status === 'error') {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-ghost btn-xs';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        void sendMessage<{ jobs: QueueJob[] }>({
          type: 'QUEUE_ADD',
          urlOrId: job.videoId,
          title: job.title,
          channelName: job.channelName,
        }).then((res) => {
          queueJobs = res.jobs ?? [];
          renderQueueCard();
        });
      });
      actions.appendChild(retryBtn);
    } else if (job.status === 'done') {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-ghost btn-xs';
      openBtn.textContent = 'Open ↗';
      openBtn.addEventListener('click', () => {
        void chrome.tabs.create({ url: job.url, active: true });
      });
      actions.appendChild(openBtn);
    } else if (job.channelName) {
      actions.textContent = job.channelName;
    }

    meta.append(pill, actions);
    item.append(head, meta);
    if (job.error) {
      const errEl = document.createElement('div');
      errEl.className = 'muted-small';
      errEl.textContent = job.error;
      item.appendChild(errEl);
    }
    list.appendChild(item);
  }
  syncQueueElapsedTimer();
}

async function loadQueue() {
  try {
    const res = await sendMessage<{ jobs?: QueueJob[] }>({ type: 'QUEUE_LIST' });
    queueJobs = res.jobs ?? [];
    renderQueueCard();
  } catch {
    // ignore
  }
}

let activityLogs: ActivityLogEntry[] = [];

function renderLogsDrawer() {
  const badge = document.getElementById('logs-count-badge');
  const list = document.getElementById('logs-list');
  if (!badge || !list) return;

  badge.textContent = String(activityLogs.length);
  list.innerHTML = '';

  if (activityLogs.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-small';
    p.textContent = 'No activity yet. Analyze or queue a video to see timing and debug logs.';
    list.appendChild(p);
    return;
  }

  for (const entry of activityLogs) {
    const row = document.createElement('div');
    row.className = `log-row is-${entry.level}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'log-time';
    timeEl.textContent = formatLogTimestamp(entry.ts);

    const scopeEl = document.createElement('span');
    scopeEl.className = 'log-scope';
    scopeEl.textContent = `[${entry.scope}]`;

    const msgEl = document.createElement('span');
    msgEl.className = 'log-msg';
    msgEl.textContent = entry.videoId ? `${entry.message} (${entry.videoId})` : entry.message;

    row.append(timeEl, scopeEl, msgEl);
    list.appendChild(row);
  }
}

async function loadLogs() {
  try {
    const res = await sendMessage<{ logs?: ActivityLogEntry[] }>({ type: 'LOGS_GET' });
    activityLogs = res.logs ?? [];
    renderLogsDrawer();
  } catch {
    // ignore
  }
}

chrome.tabs.onActivated.addListener(() => void syncActiveYouTubeTab());
chrome.windows?.onFocusChanged?.addListener(() => void syncActiveYouTubeTab());
chrome.tabs.onCreated?.addListener(() => void refreshOpenYouTubeTabs());
chrome.tabs.onRemoved?.addListener((tabId) => {
  tabStateByTabId.delete(tabId);
  void refreshOpenYouTubeTabs();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    void refreshOpenYouTubeTabs();
  }
  if (tabId === activeTabId && (changeInfo.status === 'complete' || changeInfo.url)) {
    void syncActiveYouTubeTab();
  }
});

async function init() {
  bindEvents();
  const res = await sendMessage<{ settings: ExtensionSettings }>({ type: 'SETTINGS_GET' });
  settings = res.settings;
  renderSettingsTab();
  await Promise.all([syncActiveYouTubeTab(), loadKb(), loadQueue(), loadLogs()]);
  await refreshOpenYouTubeTabs();
}

void init();
