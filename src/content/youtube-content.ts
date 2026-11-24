import type {
  ActiveVideoState,
  Chapter,
  ExtensionSettings,
  KnowledgeEntry,
  QueueJob,
  RuntimeMessage,
  SponsorSegment,
  TranscriptCue,
  VideoMetadata,
} from '../shared/types';
import { extractYouTubeVideoId } from '../shared/youtube-url';
import { DEFAULT_SETTINGS } from '../shared/types';
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  extractSponsorBlockChapters,
} from '../shared/sponsorblock';
import {
  formatTimestamp,
  getActiveChapter,
  getAdjacentChapter,
  mergeChapters,
} from '../shared/chapters';
import {
  addUniqueTopic,
  evaluateChapterRelevance,
  removeTopic,
  toggleChapterIgnore,
} from '../shared/interests';

const state: ActiveVideoState = {
  meta: null,
  currentTimeSec: 0,
  paused: true,
  youtubeChapters: [],
  sponsorSegments: [],
  aiSponsors: [],
  transcript: [],
  transcriptStatus: 'idle',
  kbEntry: null,
};

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let currentVideoId: string | null = null;
const skippedOrHandledUuids = new Set<string>();
const undoneUuids = new Set<string>();
const skippedChapterIds = new Set<string>();
const undoneChapterIds = new Set<string>();
let activeMutedUuid: string | null = null;
let hudHost: HTMLElement | null = null;
let hudShadow: ShadowRoot | null = null;
let stripCollapsed = false;
let filtersExpanded = false;
let toastTimer: number | null = null;
let lastBroadcastTime = 0;

function sendRuntimeMessage<T = unknown>(message: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response as T);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function getWatchVideoId(): string | null {
  try {
    const url = new URL(window.location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const shorts = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (shorts?.[1]) return shorts[1];
  } catch {
    // ignore
  }
  return null;
}

function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video.html5-main-video') ?? document.querySelector('video');
}

function getEffectiveChapters(): Chapter[] {
  const sbChapters = extractSponsorBlockChapters(
    state.sponsorSegments,
    state.meta?.durationSec ?? 0
  );
  const aiChapters = state.kbEntry?.chapters ?? [];
  return mergeChapters(
    state.youtubeChapters,
    sbChapters,
    aiChapters,
    settings.chapterFilterMode,
    state.meta?.durationSec ?? 0
  );
}

function getAllSkipSegments(): SponsorSegment[] {
  return [...state.sponsorSegments, ...state.aiSponsors].sort(
    (a, b) => a.startTime - b.startTime
  );
}

function seekTo(seconds: number) {
  const video = getVideoElement();
  const target = Math.max(0, seconds);
  window.postMessage(
    { source: 'chaptermind-isolated', type: 'CHAPTERMIND_SEEK_TO', seconds: target },
    '*'
  );
  if (video) {
    video.currentTime = target;
  }
  state.currentTimeSec = target;
  renderTimelineOverlay();
  renderInPageStrip();
  broadcastStateToPanel(true);
}

function showSkipToast(segment: SponsorSegment, action: 'skipped' | 'muted') {
  const player = document.getElementById('movie_player');
  if (!player) return;

  let toast = document.getElementById('chaptermind-skip-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'chaptermind-skip-toast';
    Object.assign(toast.style, {
      position: 'absolute',
      right: '16px',
      bottom: '68px',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 12px',
      borderRadius: '10px',
      background: 'rgba(15, 17, 23, 0.92)',
      border: '1px solid rgba(255, 255, 255, 0.16)',
      color: '#f3f4f6',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '12px',
      fontWeight: '600',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(8px)',
    });
    player.appendChild(toast);
  }

  toast.textContent = '';

  const dot = document.createElement('span');
  Object.assign(dot.style, {
    width: '8px',
    height: '8px',
    borderRadius: '999px',
    background: CATEGORY_COLORS[segment.category] || '#00d400',
    flexShrink: '0',
  });

  const label = document.createElement('span');
  const dur = Math.max(1, Math.round(segment.endTime - segment.startTime));
  const prefix = segment.source === 'ai' ? 'AI ' : '';
  const verb = action === 'skipped' ? 'Skipped' : 'Muted';
  label.textContent = `${verb} ${prefix}${CATEGORY_LABELS[segment.category] || segment.category} (${dur}s)`;

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.textContent = 'Undo';
  Object.assign(undoBtn.style, {
    background: 'rgba(255,255,255,0.12)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '600',
  });
  undoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    undoneUuids.add(segment.uuid);
    const video = getVideoElement();
    if (video) {
      if (action === 'muted') {
        video.muted = false;
        activeMutedUuid = null;
      }
      seekTo(segment.startTime);
    }
    toast?.remove();
  });

  toast.append(dot, label, undoBtn);

  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    document.getElementById('chaptermind-skip-toast')?.remove();
  }, 4500);
}

function showChapterSkipToast(chapter: Chapter, reason: string) {
  const player = document.getElementById('movie_player');
  if (!player) return;

  let toast = document.getElementById('chaptermind-skip-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'chaptermind-skip-toast';
    Object.assign(toast.style, {
      position: 'absolute',
      right: '16px',
      bottom: '68px',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 12px',
      borderRadius: '10px',
      background: 'rgba(15, 17, 23, 0.92)',
      border: '1px solid rgba(249, 115, 22, 0.5)',
      color: '#f3f4f6',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '12px',
      fontWeight: '600',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(8px)',
    });
    player.appendChild(toast);
  }

  toast.textContent = '';

  const dot = document.createElement('span');
  Object.assign(dot.style, {
    width: '8px',
    height: '8px',
    borderRadius: '999px',
    background: '#f97316',
    flexShrink: '0',
  });

  const label = document.createElement('span');
  label.textContent = `Skipped "${chapter.title}" (${reason})`;

  const watchBtn = document.createElement('button');
  watchBtn.type = 'button';
  watchBtn.textContent = 'Watch Anyway';
  Object.assign(watchBtn.style, {
    background: 'rgba(255,255,255,0.12)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '600',
  });
  watchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    undoneChapterIds.add(chapter.id);
    seekTo(chapter.startTime);
    toast?.remove();
  });

  toast.append(dot, label, watchBtn);

  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    document.getElementById('chaptermind-skip-toast')?.remove();
  }, 4500);
}

function getNextNonSkippedTime(chapters: Chapter[], currentChapter: Chapter): number {
  const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);
  const idx = sorted.findIndex((c) => c.id === currentChapter.id);
  for (let i = idx + 1; i < sorted.length; i++) {
    const candidate = sorted[i];
    if (!candidate) continue;
    if (evaluateChapterRelevance(candidate, settings).relevance !== 'skip') {
      return candidate.startTime;
    }
  }
  return Math.max(currentChapter.endTime, currentChapter.startTime + 1);
}

function handlePlaybackTick() {
  const video = getVideoElement();
  if (!video) return;
  const playerEl = document.getElementById('movie_player');
  if (playerEl?.classList.contains('ad-showing')) return;

  state.currentTimeSec = video.currentTime;
  state.paused = video.paused;

  if (state.meta && (!state.meta.durationSec || state.meta.durationSec < video.duration)) {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      state.meta.durationSec = Math.round(video.duration);
    }
  }

  // Unmute if we left the muted segment
  if (activeMutedUuid) {
    const seg = getAllSkipSegments().find((s) => s.uuid === activeMutedUuid);
    if (!seg || video.currentTime < seg.startTime || video.currentTime >= seg.endTime) {
      video.muted = false;
      activeMutedUuid = null;
    }
  }

  if (settings.sponsorBlockEnabled) {
    const t = video.currentTime;
    for (const seg of getAllSkipSegments()) {
      if (seg.disabled || undoneUuids.has(seg.uuid)) continue;
      if (seg.actionType === 'chapter' || seg.actionType === 'poi') continue;

      const rule = settings.categoryRules[seg.category] ?? 'show';
      if (rule === 'ignore' || rule === 'show') continue;

      if (t >= seg.startTime && t < seg.endTime - 0.35) {
        if (rule === 'skip' || seg.actionType === 'full') {
          if (!skippedOrHandledUuids.has(seg.uuid)) {
            skippedOrHandledUuids.add(seg.uuid);
            const targetTime =
              seg.actionType === 'full' && state.meta?.durationSec
                ? Math.max(seg.endTime, state.meta.durationSec - 0.5)
                : seg.endTime;
            seekTo(targetTime);
            showSkipToast(seg, 'skipped');
            break;
          }
        } else if (rule === 'mute') {
          if (!video.muted) {
            video.muted = true;
            activeMutedUuid = seg.uuid;
            if (!skippedOrHandledUuids.has(seg.uuid)) {
              skippedOrHandledUuids.add(seg.uuid);
              showSkipToast(seg, 'muted');
            }
          }
        }
      }
    }
  }

  // Auto-skip chapters matching user's "Don't Care" interest filter
  if (settings.autoSkipIgnoredChapters) {
    const chapters = getEffectiveChapters();
    const active = getActiveChapter(chapters, video.currentTime);
    if (
      active &&
      !undoneChapterIds.has(active.id) &&
      !skippedChapterIds.has(active.id) &&
      active.endTime > active.startTime + 2 &&
      video.currentTime >= active.startTime &&
      video.currentTime < active.endTime - 0.5
    ) {
      const evalRes = evaluateChapterRelevance(active, settings);
      if (evalRes.relevance === 'skip') {
        skippedChapterIds.add(active.id);
        const jumpTarget = getNextNonSkippedTime(chapters, active);
        seekTo(jumpTarget);
        showChapterSkipToast(active, evalRes.reason || "Don't care");
      }
    }
  }

  renderInPageStripActiveOnly();

  const now = Date.now();
  if (now - lastBroadcastTime > 900) {
    lastBroadcastTime = now;
    broadcastStateToPanel(false);
  }
}

function renderTimelineOverlay() {
  const progressBar = document.querySelector('.ytp-progress-bar');
  const video = getVideoElement();
  const duration = state.meta?.durationSec || (video && Number.isFinite(video.duration) ? video.duration : 0);
  if (!progressBar || duration <= 0) return;

  let overlay = document.getElementById('chaptermind-timeline-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'chaptermind-timeline-overlay';
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '35',
    });
    progressBar.appendChild(overlay);
  }
  overlay.textContent = '';

  // SponsorBlock + AI sponsor bars
  for (const seg of getAllSkipSegments()) {
    if (seg.disabled || seg.category === 'chapter') continue;
    const rule = settings.categoryRules[seg.category] ?? 'show';
    if (rule === 'ignore') continue;

    const leftPct = Math.max(0, Math.min(100, (seg.startTime / duration) * 100));
    const widthPct =
      seg.actionType === 'poi'
        ? 0.8
        : Math.max(0.4, Math.min(100 - leftPct, ((seg.endTime - seg.startTime) / duration) * 100));

    const bar = document.createElement('div');
    const color = CATEGORY_COLORS[seg.category] || '#00d400';
    Object.assign(bar.style, {
      position: 'absolute',
      left: `${leftPct}%`,
      width: `${widthPct}%`,
      top: '0',
      bottom: '0',
      background:
        seg.source === 'ai'
          ? `repeating-linear-gradient(45deg, ${color}, ${color} 3px, rgba(0,0,0,0.45) 3px, rgba(0,0,0,0.45) 6px)`
          : color,
      opacity: '0.88',
      borderRadius: '1px',
    });
    overlay.appendChild(bar);
  }

  // Chapter tick markers + ignored/interest highlights
  const chapters = getEffectiveChapters();
  for (const ch of chapters) {
    const rel = evaluateChapterRelevance(ch, settings).relevance;
    if (rel === 'skip' && ch.endTime > ch.startTime) {
      const leftPct = Math.max(0, Math.min(100, (ch.startTime / duration) * 100));
      const widthPct = Math.max(
        0.5,
        Math.min(100 - leftPct, ((ch.endTime - ch.startTime) / duration) * 100)
      );
      const skipBar = document.createElement('div');
      Object.assign(skipBar.style, {
        position: 'absolute',
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        top: '0',
        bottom: '0',
        background:
          'repeating-linear-gradient(45deg, rgba(249,115,22,0.55), rgba(249,115,22,0.55) 3px, rgba(0,0,0,0.25) 3px, rgba(0,0,0,0.25) 6px)',
      });
      overlay.appendChild(skipBar);
    }
    if (ch.startTime <= 1) continue;
    const leftPct = Math.max(0, Math.min(100, (ch.startTime / duration) * 100));
    const tick = document.createElement('div');
    Object.assign(tick.style, {
      position: 'absolute',
      left: `${leftPct}%`,
      top: '-2px',
      bottom: '-2px',
      width: '2px',
      background:
        rel === 'skip'
          ? '#f97316'
          : rel === 'must_watch'
            ? '#10b981'
            : ch.source === 'ai'
              ? '#38bdf8'
              : '#ffffff',
      opacity: '0.88',
    });
    overlay.appendChild(tick);
  }
}

function ensureHudMounted(): ShadowRoot | null {
  if (!settings.inPageHudEnabled) {
    hudHost?.remove();
    hudHost = null;
    hudShadow = null;
    return null;
  }

  const anchor =
    document.querySelector('#below') ??
    document.querySelector('ytd-watch-metadata') ??
    document.querySelector('#primary-inner #info');

  if (!anchor || !anchor.parentElement) return null;

  if (!hudHost || !document.contains(hudHost)) {
    hudHost = document.createElement('div');
    hudHost.id = 'chaptermind-inpage-host';
    hudHost.style.margin = '10px 0 4px 0';
    hudShadow = hudHost.attachShadow({ mode: 'open' });
    anchor.parentElement.insertBefore(hudHost, anchor);
  }
  return hudShadow;
}

function renderInPageStrip() {
  const shadow = ensureHudMounted();
  if (!shadow) return;

  const chapters = getEffectiveChapters();
  const active = getActiveChapter(chapters, state.currentTimeSec);
  const skipSegs = getAllSkipSegments().filter(
    (s) => s.category !== 'chapter' && s.category !== 'poi_highlight' && !s.disabled
  );
  const highlight = getAllSkipSegments().find((s) => s.category === 'poi_highlight');
  const totalSponsorSec = Math.round(
    skipSegs.reduce((sum, s) => sum + Math.max(0, s.endTime - s.startTime), 0)
  );

  shadow.textContent = '';

  const style = document.createElement('style');
  style.textContent = `
    .cm-bar {
      font-family: "YouTube Sans", "Roboto", system-ui, -apple-system, sans-serif;
      background: #0f0f0f;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 8px 12px;
      color: #f1f1f1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .cm-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cm-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .cm-brand {
      font-size: 11px;
      font-weight: 600;
      color: #34d399;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 2px 7px;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .cm-active {
      font-size: 12.5px;
      font-weight: 500;
      color: #f1f1f1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 440px;
    }
    .cm-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cm-btn {
      background: #272727;
      color: #f1f1f1;
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .cm-btn:hover { background: #3f3f3f; }
    .cm-btn-highlight { color: #f472b6; }
    .cm-btn-panel { color: #7dd3fc; }
    .cm-btn-on { color: #6ee7b7; border-color: rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.12); }
    .cm-btn-off { color: #a1a1aa; }
    .cm-sb-badge {
      font-size: 11px;
      font-weight: 500;
      color: #6ee7b7;
      background: rgba(16, 185, 129, 0.1);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .cm-filters-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 8px;
      background: #171717;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
    }
    .cm-filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(249, 115, 22, 0.14);
      border: 1px solid rgba(249, 115, 22, 0.38);
      color: #fdba74;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .cm-filter-chip:hover { background: rgba(249, 115, 22, 0.25); }
    .cm-filter-input {
      background: #0f0f0f;
      color: #f1f1f1;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11px;
      outline: none;
      width: 190px;
    }
    .cm-pills {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: thin;
    }
    .cm-pill-wrap {
      flex-shrink: 0;
      display: inline-flex;
      align-items: stretch;
      background: #212121;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      overflow: hidden;
    }
    .cm-pill-wrap:hover { background: #2c2c2c; }
    .cm-pill-wrap.active {
      background: #f1f1f1;
      border-color: #f1f1f1;
    }
    .cm-pill-wrap.is-care {
      border-color: rgba(16, 185, 129, 0.45);
    }
    .cm-pill-wrap.is-skip {
      opacity: 0.55;
      border-color: rgba(249, 115, 22, 0.4);
    }
    .cm-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: none;
      color: #d4d4d8;
      padding: 5px 7px 5px 9px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .cm-pill-wrap.active .cm-pill {
      color: #0f0f0f;
      font-weight: 600;
    }
    .cm-pill-wrap.is-skip .cm-pill-title {
      text-decoration: line-through;
    }
    .cm-pill-wrap.active .cm-pill-time {
      color: #52525b;
    }
    .cm-pill-act {
      background: transparent;
      border: none;
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      color: #71717a;
      padding: 0 7px;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
    }
    .cm-pill-act:hover { color: #f4f4f5; background: rgba(255, 255, 255, 0.08); }
    .cm-pill-wrap.active .cm-pill-act {
      border-left-color: rgba(0, 0, 0, 0.14);
      color: #52525b;
    }
    .cm-pill-wrap.is-skip .cm-pill-act {
      color: #fdba74;
    }
    .cm-pill-time {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #a1a1aa;
    }
    .cm-src-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .cm-empty {
      font-size: 12px;
      color: #a1a1aa;
    }
  `;

  const bar = document.createElement('div');
  bar.className = 'cm-bar';

  const top = document.createElement('div');
  top.className = 'cm-top';

  const left = document.createElement('div');
  left.className = 'cm-left';

  const brand = document.createElement('span');
  brand.className = 'cm-brand';
  brand.textContent = 'ChapterMind';

  const activeLabel = document.createElement('span');
  activeLabel.className = 'cm-active';
  activeLabel.id = 'cm-active-title';
  if (active) {
    const idx = chapters.findIndex((c) => c.id === active.id) + 1;
    activeLabel.textContent = `${idx}/${chapters.length} · ${active.title}`;
  } else {
    activeLabel.textContent = state.meta?.title || 'Ready';
  }

  left.append(brand, activeLabel);

  const actions = document.createElement('div');
  actions.className = 'cm-actions';

  if (skipSegs.length > 0) {
    const sbBadge = document.createElement('span');
    sbBadge.className = 'cm-sb-badge';
    sbBadge.textContent = `SB: ${skipSegs.length} seg (${formatTimestamp(totalSponsorSec)})`;
    actions.appendChild(sbBadge);
  }

  if (highlight) {
    const hlBtn = document.createElement('button');
    hlBtn.type = 'button';
    hlBtn.className = 'cm-btn cm-btn-highlight';
    hlBtn.textContent = `★ Highlight ${formatTimestamp(highlight.startTime)}`;
    hlBtn.addEventListener('click', () => seekTo(highlight.startTime));
    actions.appendChild(hlBtn);
  }

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'cm-btn';
  prevBtn.title = 'Previous Chapter ( [ )';
  prevBtn.textContent = '◀ Prev';
  prevBtn.addEventListener('click', () => {
    const target = getAdjacentChapter(getEffectiveChapters(), state.currentTimeSec, 'prev');
    if (target) seekTo(target.startTime);
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'cm-btn';
  nextBtn.title = 'Next Chapter ( ] )';
  nextBtn.textContent = 'Next ▶';
  nextBtn.addEventListener('click', () => {
    const target = getAdjacentChapter(getEffectiveChapters(), state.currentTimeSec, 'next');
    if (target) seekTo(target.startTime);
  });

  const panelBtn = document.createElement('button');
  panelBtn.type = 'button';
  panelBtn.className = 'cm-btn cm-btn-panel';
  panelBtn.textContent = state.kbEntry ? 'KB + AI Panel' : '✨ AI Chapters / KB';
  panelBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'OPEN_SIDEPANEL' }).catch(() => {});
  });

  const savePartialSettings = async (partial: Partial<ExtensionSettings>) => {
    const res = await sendRuntimeMessage<{ settings?: ExtensionSettings }>({
      type: 'SETTINGS_SAVE',
      settings: partial,
    }).catch(() => ({ settings: undefined }));
    if (res.settings) {
      settings = res.settings;
    } else {
      settings = { ...settings, ...partial };
    }
    renderTimelineOverlay();
    renderInPageStrip();
  };

  const autoSkipBtn = document.createElement('button');
  autoSkipBtn.type = 'button';
  autoSkipBtn.className = `cm-btn ${settings.autoSkipIgnoredChapters ? 'cm-btn-on' : 'cm-btn-off'}`;
  autoSkipBtn.title = 'Toggle automatic skipping of Don’t Care chapters';
  autoSkipBtn.textContent = settings.autoSkipIgnoredChapters ? 'Auto-Skip ON' : 'Auto-Skip OFF';
  autoSkipBtn.addEventListener('click', () => {
    void savePartialSettings({ autoSkipIgnoredChapters: !settings.autoSkipIgnoredChapters });
  });

  const filtersBtn = document.createElement('button');
  filtersBtn.type = 'button';
  filtersBtn.className = 'cm-btn';
  filtersBtn.title = 'Show / remove Don’t Care ignore filters';
  filtersBtn.textContent = `Filters (${settings.topicsIgnore.length})`;
  filtersBtn.addEventListener('click', () => {
    filtersExpanded = !filtersExpanded;
    renderInPageStrip();
  });

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'cm-btn';
  collapseBtn.textContent = stripCollapsed ? 'Show' : 'Hide';
  collapseBtn.addEventListener('click', () => {
    stripCollapsed = !stripCollapsed;
    renderInPageStrip();
  });

  actions.append(prevBtn, nextBtn, autoSkipBtn, filtersBtn, panelBtn, collapseBtn);
  top.append(left, actions);
  bar.appendChild(top);

  if (!stripCollapsed && filtersExpanded) {
    const filterRow = document.createElement('div');
    filterRow.className = 'cm-filters-row';

    for (const topic of settings.topicsIgnore) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cm-filter-chip';
      chip.title = `Remove "${topic}" from Don't Care list`;
      chip.textContent = `${topic} ✕`;
      chip.addEventListener('click', () => {
        void savePartialSettings({
          topicsIgnore: removeTopic(settings.topicsIgnore, topic),
        });
      });
      filterRow.appendChild(chip);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-filter-input';
    input.placeholder = '+ Ignore topic & Enter...';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        input.value = '';
        void savePartialSettings({
          topicsIgnore: addUniqueTopic(settings.topicsIgnore, val),
          topicsCare: removeTopic(settings.topicsCare, val),
          topicsAllow: removeTopic(settings.topicsAllow, val),
        });
      }
    });
    filterRow.appendChild(input);
    bar.appendChild(filterRow);
  }

  if (!stripCollapsed) {
    if (chapters.length > 0) {
      const pills = document.createElement('div');
      pills.className = 'cm-pills';
      for (const ch of chapters) {
        const rel = evaluateChapterRelevance(ch, settings);
        const wrap = document.createElement('div');
        wrap.className = `cm-pill-wrap${active?.id === ch.id ? ' active' : ''}${
          rel.relevance === 'skip' ? ' is-skip' : rel.relevance === 'must_watch' ? ' is-care' : ''
        }`;
        wrap.dataset.chapterId = ch.id;

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'cm-pill';
        pill.title = rel.reason
          ? `${ch.title} (${rel.reason})`
          : ch.summary
            ? `${ch.title} — ${ch.summary}`
            : ch.title;

        const dot = document.createElement('span');
        dot.className = 'cm-src-dot';
        dot.style.background =
          rel.relevance === 'skip'
            ? '#f97316'
            : rel.relevance === 'must_watch'
              ? '#10b981'
              : ch.source === 'ai'
                ? '#38bdf8'
                : ch.source === 'sponsorblock'
                  ? '#4ade80'
                  : '#f59e0b';

        const time = document.createElement('span');
        time.className = 'cm-pill-time';
        time.textContent = formatTimestamp(ch.startTime);

        const title = document.createElement('span');
        title.className = 'cm-pill-title';
        const prefix = rel.relevance === 'skip' ? '⊘ ' : rel.relevance === 'must_watch' ? '★ ' : '';
        title.textContent = `${prefix}${ch.title}`;

        pill.append(dot, time, title);
        pill.addEventListener('click', () => seekTo(ch.startTime));

        const actBtn = document.createElement('button');
        actBtn.type = 'button';
        actBtn.className = 'cm-pill-act';
        actBtn.textContent = rel.relevance === 'skip' ? '↩' : '⊘';
        actBtn.title =
          rel.relevance === 'skip'
            ? 'Un-ignore this chapter (remove skip)'
            : "Don't care — auto-skip this topic";
        actBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const res = toggleChapterIgnore(ch, settings);
          if (res.action === 'unignored') {
            undoneChapterIds.add(ch.id);
            skippedChapterIds.delete(ch.id);
          }
          void savePartialSettings({
            topicsIgnore: res.topicsIgnore,
            topicsCare: res.topicsCare,
            topicsAllow: res.topicsAllow,
          });
        });

        wrap.append(pill, actBtn);
        pills.appendChild(wrap);
      }
      bar.appendChild(pills);
    } else {
      const empty = document.createElement('div');
      empty.className = 'cm-empty';
      empty.textContent =
        state.transcriptStatus === 'ready'
          ? `No native chapters yet — click "✨ AI Chapters / KB" to generate instant skip chapters from ${state.transcript.length} transcript cues.`
          : 'Waiting for chapters or transcript...';
      bar.appendChild(empty);
    }
  }

  shadow.append(style, bar);
}

function renderInPageStripActiveOnly() {
  if (!hudShadow) return;
  const chapters = getEffectiveChapters();
  const active = getActiveChapter(chapters, state.currentTimeSec);
  const activeTitle = hudShadow.getElementById('cm-active-title');
  if (activeTitle && active) {
    const idx = chapters.findIndex((c) => c.id === active.id) + 1;
    activeTitle.textContent = `${idx}/${chapters.length} · ${active.title}`;
  }
  const pills = hudShadow.querySelectorAll('.cm-pill-wrap');
  pills.forEach((pill) => {
    const id = (pill as HTMLElement).dataset.chapterId;
    pill.classList.toggle('active', Boolean(active && id === active.id));
  });
}

function broadcastStateToPanel(force = false) {
  if (IS_HEADLESS_TAB) return;
  if (!force && !state.meta) return;
  if (state.meta && state.meta.videoId !== currentVideoId) return;
  void sendRuntimeMessage({
    type: 'VIDEO_STATE_CHANGED',
    state: { ...state },
  }).catch(() => {
    // Side panel might be closed; safe to ignore
  });
}

async function loadVideoContext(videoId: string, forceRefresh = false) {
  currentVideoId = videoId;
  headlessReportedVideoId = null;
  skippedOrHandledUuids.clear();
  undoneUuids.clear();
  skippedChapterIds.clear();
  undoneChapterIds.clear();
  activeMutedUuid = null;

  state.meta = null;
  state.youtubeChapters = [];
  state.sponsorSegments = [];
  state.aiSponsors = [];
  state.transcript = [];
  state.transcriptStatus = 'loading';
  state.transcriptError = undefined;
  state.kbEntry = null;

  // Ask MAIN world for metadata + chapters + trigger transcript fetch
  window.postMessage(
    { source: 'chaptermind-isolated', type: 'CHAPTERMIND_REQUEST_VIDEO_DATA' },
    '*'
  );
  window.postMessage(
    {
      source: 'chaptermind-isolated',
      type: 'CHAPTERMIND_FETCH_TRANSCRIPT',
      videoId,
      forceRefresh,
    },
    '*'
  );

  if (IS_HEADLESS_TAB) {
    return;
  }

  // Fetch SponsorBlock + saved Knowledge Base entry in parallel from background
  const [sbRes, kbRes] = await Promise.all([
    sendRuntimeMessage<{ segments?: SponsorSegment[] }>({
      type: 'FETCH_SPONSORBLOCK',
      videoId,
    }).catch(() => ({ segments: [] })),
    sendRuntimeMessage<{ entry?: KnowledgeEntry | null }>({
      type: 'KB_GET',
      videoId,
    }).catch(() => ({ entry: null })),
  ]);

  if (currentVideoId !== videoId) return;

  state.sponsorSegments = sbRes.segments ?? [];
  state.kbEntry = kbRes.entry ?? null;
  state.aiSponsors = kbRes.entry?.aiSponsors ?? [];

  renderTimelineOverlay();
  renderInPageStrip();
  broadcastStateToPanel(true);
}

function attachVideoListeners() {
  const video = getVideoElement();
  if (!video) return;
  if (IS_HEADLESS_TAB) {
    video.muted = true;
    if (!video.paused) video.pause();
  }
  if (video.dataset.chaptermindBound === '1') return;
  video.dataset.chaptermindBound = '1';
  if (IS_HEADLESS_TAB) {
    video.addEventListener('play', () => {
      video.muted = true;
      video.pause();
    });
    return;
  }
  video.addEventListener('timeupdate', handlePlaybackTick);
  video.addEventListener('seeked', () => {
    handlePlaybackTick();
    renderTimelineOverlay();
  });
}

function checkNavigation() {
  attachVideoListeners();
  const vid = getWatchVideoId();
  if (vid && vid !== currentVideoId) {
    void loadVideoContext(vid);
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as {
    source?: string;
    type?: string;
    payload?: unknown;
  } | null;
  if (!data || data.source !== 'chaptermind-main') return;

  if (data.type === 'CHAPTERMIND_VIDEO_DATA') {
    const payload = data.payload as {
      meta: VideoMetadata | null;
      youtubeChapters: Chapter[];
    };
    if (payload.meta && payload.meta.videoId === currentVideoId) {
      state.meta = payload.meta;
      state.youtubeChapters = payload.youtubeChapters ?? [];
      if (IS_HEADLESS_TAB) {
        maybeReportHeadlessCapture();
        return;
      }
      renderTimelineOverlay();
      renderInPageStrip();
      broadcastStateToPanel(true);
    }
  } else if (data.type === 'CHAPTERMIND_TRANSCRIPT_RESULT') {
    const payload = data.payload as {
      videoId: string;
      cues: TranscriptCue[];
      error?: string;
    };
    if (payload.videoId === currentVideoId) {
      state.transcript = payload.cues ?? [];
      state.transcriptStatus =
        state.transcript.length > 0 ? 'ready' : payload.error ? 'unavailable' : 'unavailable';
      state.transcriptError = payload.error;
      if (IS_HEADLESS_TAB) {
        maybeReportHeadlessCapture();
        return;
      }
      renderInPageStrip();
      broadcastStateToPanel(true);
    }
  }
});

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'GET_ACTIVE_VIDEO_STATE') {
    const vid = getWatchVideoId();
    if (vid && vid !== currentVideoId) {
      void loadVideoContext(vid);
      sendResponse({
        state: {
          ...state,
          meta: null,
          youtubeChapters: [],
          sponsorSegments: [],
          aiSponsors: [],
          transcript: [],
          transcriptStatus: 'loading',
          kbEntry: null,
        },
      });
      return false;
    }
    const video = getVideoElement();
    if (video) {
      state.currentTimeSec = video.currentTime;
      state.paused = video.paused;
    }
    sendResponse({ state });
    return false;
  }

  if (msg.type === 'SEEK_TO') {
    seekTo(msg.seconds);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'REFRESH_VIDEO') {
    const vid = getWatchVideoId();
    if (vid) {
      void loadVideoContext(vid, true).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (msg.type === 'APPLY_ANALYSIS') {
    if (msg.entry.videoId === currentVideoId) {
      state.kbEntry = msg.entry;
      state.aiSponsors = msg.entry.aiSponsors ?? [];
      renderTimelineOverlay();
      renderInPageStrip();
      broadcastStateToPanel(true);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'TOGGLE_SEGMENT_DISABLED') {
    for (const seg of state.sponsorSegments) {
      if (seg.uuid === msg.uuid) seg.disabled = msg.disabled;
    }
    for (const seg of state.aiSponsors) {
      if (seg.uuid === msg.uuid) seg.disabled = msg.disabled;
    }
    renderTimelineOverlay();
    renderInPageStrip();
    broadcastStateToPanel(true);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'SETTINGS_UPDATED') {
    settings = msg.settings;
    if (!IS_HEADLESS_TAB) {
      renderTimelineOverlay();
      renderInPageStrip();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'QUEUE_UPDATED') {
    queueJobsById.clear();
    for (const job of msg.jobs) {
      queueJobsById.set(job.videoId, job);
    }
    if (msg.kbVideoIds) {
      kbVideoIds = new Set(msg.kbVideoIds);
    }
    if (!IS_HEADLESS_TAB) {
      refreshAllThumbnailQueueButtons();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

document.addEventListener('keydown', (e) => {
  if (!settings.shortcutsEnabled) return;
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  ) {
    return;
  }

  if (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const prev = getAdjacentChapter(getEffectiveChapters(), state.currentTimeSec, 'prev');
    if (prev) {
      e.preventDefault();
      seekTo(prev.startTime);
    }
  } else if (e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const next = getAdjacentChapter(getEffectiveChapters(), state.currentTimeSec, 'next');
    if (next) {
      e.preventDefault();
      seekTo(next.startTime);
    }
  } else if (e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    const t = state.currentTimeSec;
    const currentSeg = getAllSkipSegments().find(
      (s) => !s.disabled && s.actionType !== 'chapter' && t >= s.startTime && t < s.endTime
    );
    if (currentSeg) {
      seekTo(currentSeg.endTime);
    } else {
      const highlight = getAllSkipSegments().find((s) => s.category === 'poi_highlight');
      if (highlight) seekTo(highlight.startTime);
    }
  } else if (e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    stripCollapsed = !stripCollapsed;
    renderInPageStrip();
  }
});

const IS_HEADLESS_TAB = new URLSearchParams(window.location.search).get('cm_headless') === '1';
const queueJobsById = new Map<string, QueueJob>();
let kbVideoIds = new Set<string>();
let headlessReportedVideoId: string | null = null;
let thumbScanTimer: number | null = null;

function maybeReportHeadlessCapture() {
  if (!IS_HEADLESS_TAB || !currentVideoId) return;
  if (headlessReportedVideoId === currentVideoId) return;
  if (state.transcriptStatus === 'loading') return;
  headlessReportedVideoId = currentVideoId;
  void sendRuntimeMessage({
    type: 'HEADLESS_TRANSCRIPT_CAPTURED',
    videoId: currentVideoId,
    meta: state.meta,
    transcript: state.transcript,
    youtubeChapters: state.youtubeChapters,
    error: state.transcriptError,
  }).catch(() => {});
}

function ensureThumbQueueStyles() {
  if (document.getElementById('cm-thumb-btn-style')) return;
  const style = document.createElement('style');
  style.id = 'cm-thumb-btn-style';
  style.textContent = `
    .cm-thumb-queue-btn {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 25;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 7px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(9, 9, 11, 0.84);
      backdrop-filter: blur(6px);
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
      opacity: 0.9;
      transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
    }
    .cm-thumb-queue-btn:hover {
      opacity: 1;
      background: rgba(24, 24, 27, 0.96);
      border-color: rgba(56, 189, 248, 0.65);
      color: #ffffff;
    }
    .cm-thumb-queue-btn.is-queued {
      border-color: rgba(245, 158, 11, 0.55);
      color: #fbbf24;
    }
    .cm-thumb-queue-btn.is-done {
      border-color: rgba(16, 185, 129, 0.55);
      color: #34d399;
    }
    .cm-thumb-queue-btn.is-error {
      border-color: rgba(244, 63, 94, 0.55);
      color: #fda4af;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function applyThumbButtonState(btn: HTMLButtonElement, videoId: string) {
  const job = queueJobsById.get(videoId);
  btn.classList.remove('is-queued', 'is-done', 'is-error');
  if (job) {
    if (job.status === 'queued' || job.status === 'fetching_transcript' || job.status === 'analyzing') {
      btn.classList.add('is-queued');
      btn.textContent = job.status === 'analyzing' ? '⏳ AI' : '⏳ Queue';
      btn.title = `ChapterMind: ${job.status.replace('_', ' ')}...`;
      return;
    }
    if (job.status === 'done') {
      btn.classList.add('is-done');
      btn.textContent = '✓ KB';
      btn.title = 'ChapterMind: Saved in Knowledge Base (click to re-run headlessly)';
      return;
    }
    if (job.status === 'error') {
      btn.classList.add('is-error');
      btn.textContent = '! Retry';
      btn.title = `ChapterMind failed: ${job.error || 'Unknown error'} (click to retry)`;
      return;
    }
  }
  if (kbVideoIds.has(videoId)) {
    btn.classList.add('is-done');
    btn.textContent = '✓ KB';
    btn.title = 'ChapterMind: Saved in Knowledge Base (click to re-run headlessly)';
    return;
  }
  btn.textContent = '+ CM';
  btn.title = 'ChapterMind: Queue & analyze headlessly in background';
}

function refreshAllThumbnailQueueButtons() {
  document.querySelectorAll<HTMLButtonElement>('.cm-thumb-queue-btn[data-cm-vid]').forEach((btn) => {
    const vid = btn.dataset.cmVid;
    if (vid) applyThumbButtonState(btn, vid);
  });
}

function scanThumbnailQueueButtons() {
  if (IS_HEADLESS_TAB) return;
  ensureThumbQueueStyles();

  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    'ytd-rich-item-renderer a#thumbnail[href], ytd-video-renderer a#thumbnail[href], ytd-compact-video-renderer a#thumbnail[href], ytd-grid-video-renderer a#thumbnail[href], ytd-playlist-video-renderer a#thumbnail[href], yt-lockup-view-model a.yt-lockup-view-model-wiz__content-image[href], yt-lockup-view-model a[href*="/watch"]:has(yt-thumbnail-view-model, yt-image, img)'
  );

  for (const anchor of anchors) {
    if (anchor.querySelector('.cm-thumb-queue-btn')) continue;
    if (anchor.closest('yt-lockup-metadata-view-model, #details, #meta')) continue;
    if (!anchor.querySelector('img, yt-image, yt-thumbnail-view-model')) continue;

    const vid = extractYouTubeVideoId(anchor.href);
    if (!vid) continue;
    const rect = anchor.getBoundingClientRect();
    if (rect.width > 0 && rect.width < 90) continue;

    const card = anchor.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model'
    );
    if (card?.querySelector('.cm-thumb-queue-btn')) continue;

    if (getComputedStyle(anchor).position === 'static') {
      anchor.style.position = 'relative';
    }
    const titleEl = card?.querySelector('#video-title, h3 a, .yt-lockup-metadata-view-model-wiz__title');
    const channelEl = card?.querySelector('ytd-channel-name #text, #channel-name a');
    const title = titleEl?.textContent?.trim() || `YouTube Video (${vid})`;
    const channelName = channelEl?.textContent?.trim() || undefined;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-thumb-queue-btn';
    btn.dataset.cmVid = vid;
    applyThumbButtonState(btn, vid);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      queueJobsById.set(vid, {
        videoId: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title,
        channelName,
        status: 'queued',
        addedAt: Date.now(),
        updatedAt: Date.now(),
      });
      applyThumbButtonState(btn, vid);
      void sendRuntimeMessage<{ jobs?: QueueJob[] }>({
        type: 'QUEUE_ADD',
        urlOrId: vid,
        title,
        channelName,
      }).catch(() => {});
    });

    anchor.appendChild(btn);
  }
}

function scheduleScanThumbnailButtons() {
  if (IS_HEADLESS_TAB || thumbScanTimer !== null) return;
  thumbScanTimer = window.setTimeout(() => {
    thumbScanTimer = null;
    scanThumbnailQueueButtons();
  }, 350);
}

// Initialize
void sendRuntimeMessage<{ settings?: ExtensionSettings }>({ type: 'SETTINGS_GET' })
  .then((res) => {
    if (res.settings) settings = res.settings;
  })
  .catch(() => {})
  .finally(() => {
    checkNavigation();
    if (!IS_HEADLESS_TAB) {
      void Promise.all([
        sendRuntimeMessage<{ jobs?: QueueJob[] }>({ type: 'QUEUE_LIST' }).catch(() => ({ jobs: [] })),
        sendRuntimeMessage<{ ids?: string[] }>({ type: 'KB_IDS_GET' }).catch(() => ({ ids: [] })),
      ]).then(([qRes, kbRes]) => {
        for (const job of qRes.jobs ?? []) {
          queueJobsById.set(job.videoId, job);
        }
        kbVideoIds = new Set(kbRes.ids ?? []);
        scanThumbnailQueueButtons();
        refreshAllThumbnailQueueButtons();
      });
    }
  });

window.addEventListener('yt-navigate-finish', () =>
  setTimeout(() => {
    checkNavigation();
    scheduleScanThumbnailButtons();
  }, 250)
);
window.addEventListener('yt-page-data-updated', () =>
  setTimeout(() => {
    checkNavigation();
    scheduleScanThumbnailButtons();
  }, 250)
);

const observer = new MutationObserver(() => {
  attachVideoListeners();
  if (IS_HEADLESS_TAB) return;
  const progressBar = document.querySelector('.ytp-progress-bar');
  if (progressBar && !document.getElementById('chaptermind-timeline-overlay')) {
    renderTimelineOverlay();
  }
  if (settings.inPageHudEnabled && !document.getElementById('chaptermind-inpage-host')) {
    renderInPageStrip();
  }
  scheduleScanThumbnailButtons();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.setInterval(checkNavigation, 1500);
