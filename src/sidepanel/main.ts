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
  searchKnowledgeBase,
} from '../shared/kb-storage';
import {
  addUniqueTopic,
  evaluateChapterRelevance,
  extractTopicFromChapter,
  removeTopic,
} from '../shared/interests';
import { parseGithubRepo } from '../shared/github-sync';

let activeTabId: number | null = null;
let videoState: ActiveVideoState | null = null;
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let kbEntries: KnowledgeEntry[] = [];
let expandedKbIds = new Set<string>();
let chapterSearch = '';
let transcriptSearch = '';
let kbSearch = '';
let kbEntityFilter = 'all';
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

function renderWatchingTab() {
  const noVideo = document.getElementById('no-video-card');
  const workspace = document.getElementById('video-workspace');
  if (!noVideo || !workspace) return;

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

  const tldrEl = document.getElementById('video-tldr') as HTMLElement;
  if (videoState.kbEntry?.tldr) {
    tldrEl.textContent = videoState.kbEntry.tldr;
    tldrEl.classList.remove('hidden');
  } else {
    tldrEl.classList.add('hidden');
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
  document.querySelectorAll('#chapter-mode-chips .chip').forEach((chip) => {
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

      if (rel.relevance === 'skip') {
        const skipBadge = document.createElement('span');
        skipBadge.className = 'src-badge src-skip';
        skipBadge.textContent = 'SKIP';
        right.appendChild(skipBadge);
      } else if (rel.relevance === 'must_watch') {
        const careBadge = document.createElement('span');
        careBadge.className = 'src-badge src-care';
        careBadge.textContent = '★';
        right.appendChild(careBadge);
      }

      const src = document.createElement('span');
      src.className = `src-badge src-${ch.source}`;
      src.textContent = ch.source === 'sponsorblock' ? 'SB' : ch.source;

      const fb = document.createElement('div');
      fb.className = 'feedback-btns';

      const careBtn = document.createElement('button');
      careBtn.type = 'button';
      careBtn.className = `fb-btn${rel.relevance === 'must_watch' ? ' is-active-care' : ''}`;
      careBtn.textContent = '★';
      careBtn.title = 'I care about this topic';
      careBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const topic = extractTopicFromChapter(ch);
        void saveInterestUpdate({
          topicsCare: addUniqueTopic(settings.topicsCare, topic),
          topicsIgnore: removeTopic(settings.topicsIgnore, topic),
        }).then(() => {
          showBanner(`Added "${topic}" to Topics I Care About`, 'success');
        });
      });

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = `fb-btn${rel.relevance === 'skip' ? ' is-active-skip' : ''}`;
      skipBtn.textContent = '👎';
      skipBtn.title = "Don't care — auto-skip this topic in future videos too";
      skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const topic = extractTopicFromChapter(ch);
        void saveInterestUpdate({
          topicsIgnore: addUniqueTopic(settings.topicsIgnore, topic),
          topicsCare: removeTopic(settings.topicsCare, topic),
        }).then(() => {
          showBanner(`Added "${topic}" to Don't Care list — auto-skipping!`, 'success');
        });
      });

      fb.append(careBtn, skipBtn);
      right.append(src, fb);

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

function renderKbTab() {
  const entityCount = kbEntries.reduce((acc, e) => acc + e.entities.length, 0);
  const strippedSec = kbEntries.reduce((acc, e) => acc + (e.sponsorTimeStrippedSec || 0), 0);

  (document.getElementById('stat-videos') as HTMLElement).textContent = String(kbEntries.length);
  (document.getElementById('stat-entities') as HTMLElement).textContent = String(entityCount);
  (document.getElementById('stat-saved-time') as HTMLElement).textContent =
    `${Math.round(strippedSec / 60)}m`;

  const list = document.getElementById('kb-list') as HTMLElement;
  list.textContent = '';

  const results = searchKnowledgeBase(kbEntries, kbSearch, kbEntityFilter);
  if (results.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-small';
    p.textContent =
      kbEntries.length === 0
        ? 'No saved videos yet. Analyze a YouTube video to build your AI Knowledge Base.'
        : 'No matching entries found.';
    list.appendChild(p);
    return;
  }

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

    const metaBadge = document.createElement('span');
    metaBadge.className = 'src-badge src-ai';
    metaBadge.textContent = `${entry.chapters.length} ch`;

    top.append(left, metaBadge);

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
          row.className = 'item-sub';
          row.textContent = `[${formatTimestamp(tk.timestampSec)}] ${tk.text}`;
          tkList.appendChild(row);
        }
        detail.appendChild(tkList);
      }

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

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-xs btn-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        await sendMessage({ type: 'KB_DELETE', videoId: entry.videoId });
        await loadKb();
      });

      actions.append(openBtn, mdBtn, delBtn);
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
}

async function syncActiveYouTubeTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes('youtube.com/watch')) {
    const ytTabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
      currentWindow: true,
    });
    tab = ytTabs[0];
  }
  activeTabId = tab?.id ?? null;

  if (!tab?.id || !tab.url?.includes('youtube.com/')) {
    videoState = null;
    renderWatchingTab();
    renderTranscriptTab();
    return;
  }

  try {
    const res = await sendTabMessage<{ state: ActiveVideoState }>(tab.id, {
      type: 'GET_ACTIVE_VIDEO_STATE',
    });
    videoState = res?.state ?? null;
  } catch {
    videoState = null;
  }

  renderWatchingTab();
  renderTranscriptTab();
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

  document.querySelectorAll('#chapter-mode-chips .chip').forEach((chip) => {
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

  // Analyze via API
  document.getElementById('analyze-api-btn')?.addEventListener('click', async (e) => {
    if (!videoState?.meta) return;
    if (videoState.transcript.length === 0) {
      showBanner('No transcript available for this video yet.', 'error');
      return;
    }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    showBanner('Stripping SponsorBlock ads & analyzing transcript via AI API...', 'info');

    try {
      const res = await sendMessage<{ entry: KnowledgeEntry }>({
        type: 'ANALYZE_VIDEO_API',
        meta: videoState.meta,
        transcript: videoState.transcript,
        youtubeChapters: videoState.youtubeChapters,
        sponsorSegments: videoState.sponsorSegments,
      });
      videoState.kbEntry = res.entry;
      videoState.aiSponsors = res.entry.aiSponsors;
      renderWatchingTab();
      await loadKb();
      showBanner(
        `Saved ${res.entry.chapters.length} AI chapters & ${res.entry.entities.length} entities to KB!`,
        'success'
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'API analysis failed', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Analyze via API';
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
    if (kbEntries.length === 0) return;
    downloadTextFile('chaptermind-knowledge-base.md', exportAllToMarkdown(kbEntries), 'text/markdown');
  });

  document.getElementById('export-all-json-btn')?.addEventListener('click', () => {
    if (kbEntries.length === 0) return;
    downloadTextFile(
      'chaptermind-knowledge-base.json',
      JSON.stringify(kbEntries, null, 2),
      'application/json'
    );
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
    if (sender.tab?.id) {
      activeTabId = sender.tab.id;
    }
    videoState = msg.state;
    const nextSig = getWatchingRenderSignature();
    if (nextSig === lastWatchingRenderSig) {
      updateWatchingPlaybackOnly();
    } else {
      renderWatchingTab();
      renderTranscriptTab();
    }
  } else if (msg.type === 'BRIDGE_ANALYSIS_READY') {
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
  }
});

chrome.tabs.onActivated.addListener(() => void syncActiveYouTubeTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && (changeInfo.status === 'complete' || changeInfo.url)) {
    void syncActiveYouTubeTab();
  }
});

async function init() {
  bindEvents();
  const res = await sendMessage<{ settings: ExtensionSettings }>({ type: 'SETTINGS_GET' });
  settings = res.settings;
  renderSettingsTab();
  await Promise.all([syncActiveYouTubeTab(), loadKb()]);
}

void init();
