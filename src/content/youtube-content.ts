import type {
  ActiveVideoState,
  Chapter,
  ExtensionSettings,
  KnowledgeEntry,
  RuntimeMessage,
  SponsorSegment,
  TranscriptCue,
  VideoMetadata,
} from '../shared/types';
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
import { evaluateChapterRelevance } from '../shared/interests';

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
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #12151e;
      border: 1px solid #262c3d;
      border-radius: 12px;
      padding: 8px 12px;
      color: #e5e7eb;
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
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #34d399;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.35);
      padding: 2px 7px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .cm-active {
      font-size: 13px;
      font-weight: 600;
      color: #f9fafb;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 420px;
    }
    .cm-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .cm-btn {
      background: #1d2230;
      color: #e5e7eb;
      border: 1px solid #2e364a;
      border-radius: 7px;
      padding: 4px 9px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .cm-btn:hover { background: #272e40; border-color: #4b5563; }
    .cm-btn-highlight { border-color: rgba(255, 22, 132, 0.5); color: #ff69b4; }
    .cm-btn-panel { border-color: rgba(56, 189, 248, 0.45); color: #7dd3fc; }
    .cm-sb-badge {
      font-size: 11px;
      font-weight: 600;
      color: #4ade80;
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .cm-pills {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: thin;
    }
    .cm-pill {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #191d29;
      border: 1px solid #2a3142;
      color: #cbd5e1;
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .cm-pill:hover { background: #23293a; color: #ffffff; }
    .cm-pill.active {
      background: rgba(56, 189, 248, 0.16);
      border-color: #38bdf8;
      color: #ffffff;
      font-weight: 600;
    }
    .cm-pill.is-skip {
      opacity: 0.52;
      border-color: rgba(249, 115, 22, 0.45);
      text-decoration: line-through;
    }
    .cm-pill.is-care {
      border-color: rgba(16, 185, 129, 0.55);
    }
    .cm-pill-time {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #94a3b8;
    }
    .cm-src-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .cm-empty {
      font-size: 12px;
      color: #94a3b8;
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

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'cm-btn';
  collapseBtn.textContent = stripCollapsed ? 'Show' : 'Hide';
  collapseBtn.addEventListener('click', () => {
    stripCollapsed = !stripCollapsed;
    renderInPageStrip();
  });

  actions.append(prevBtn, nextBtn, panelBtn, collapseBtn);
  top.append(left, actions);
  bar.appendChild(top);

  if (!stripCollapsed) {
    if (chapters.length > 0) {
      const pills = document.createElement('div');
      pills.className = 'cm-pills';
      for (const ch of chapters) {
        const rel = evaluateChapterRelevance(ch, settings);
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `cm-pill${active?.id === ch.id ? ' active' : ''}${
          rel.relevance === 'skip' ? ' is-skip' : rel.relevance === 'must_watch' ? ' is-care' : ''
        }`;
        pill.dataset.chapterId = ch.id;
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
        const prefix = rel.relevance === 'skip' ? '⊘ ' : rel.relevance === 'must_watch' ? '★ ' : '';
        title.textContent = `${prefix}${ch.title}`;

        pill.append(dot, time, title);
        pill.addEventListener('click', () => seekTo(ch.startTime));
        pills.appendChild(pill);
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
  const pills = hudShadow.querySelectorAll('.cm-pill');
  pills.forEach((pill) => {
    const id = (pill as HTMLElement).dataset.chapterId;
    pill.classList.toggle('active', Boolean(active && id === active.id));
  });
}

function broadcastStateToPanel(force = false) {
  if (!force && !state.meta) return;
  void sendRuntimeMessage({
    type: 'VIDEO_STATE_CHANGED',
    state: { ...state },
  }).catch(() => {
    // Side panel might be closed; safe to ignore
  });
}

async function loadVideoContext(videoId: string) {
  currentVideoId = videoId;
  skippedOrHandledUuids.clear();
  undoneUuids.clear();
  skippedChapterIds.clear();
  undoneChapterIds.clear();
  activeMutedUuid = null;

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
    { source: 'chaptermind-isolated', type: 'CHAPTERMIND_FETCH_TRANSCRIPT', videoId },
    '*'
  );

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
  if (!video || video.dataset.chaptermindBound === '1') return;
  video.dataset.chaptermindBound = '1';
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
      renderInPageStrip();
      broadcastStateToPanel(true);
    }
  }
});

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'GET_ACTIVE_VIDEO_STATE') {
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
      void loadVideoContext(vid).then(() => sendResponse({ ok: true }));
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
    renderTimelineOverlay();
    renderInPageStrip();
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

// Initialize
void sendRuntimeMessage<{ settings?: ExtensionSettings }>({ type: 'SETTINGS_GET' })
  .then((res) => {
    if (res.settings) settings = res.settings;
  })
  .catch(() => {})
  .finally(() => {
    checkNavigation();
  });

window.addEventListener('yt-navigate-finish', () => setTimeout(checkNavigation, 250));
window.addEventListener('yt-page-data-updated', () => setTimeout(checkNavigation, 250));

const observer = new MutationObserver(() => {
  attachVideoListeners();
  const progressBar = document.querySelector('.ytp-progress-bar');
  if (progressBar && !document.getElementById('chaptermind-timeline-overlay')) {
    renderTimelineOverlay();
  }
  if (settings.inPageHudEnabled && !document.getElementById('chaptermind-inpage-host')) {
    renderInPageStrip();
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

window.setInterval(checkNavigation, 1500);
