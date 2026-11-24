import type { CaptionTrackInfo, Chapter, TranscriptCue, VideoMetadata } from '../shared/types';
import { parseDescriptionChapters } from '../shared/chapters';
import { parseJson3Transcript, parseXmlTranscript } from '../shared/transcript';

interface MoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => Record<string, unknown> | undefined;
  getDuration?: () => number;
  getVideoData?: () => { video_id?: string; title?: string; author?: string };
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  getPlayerState?: () => number;
  playVideo?: () => void;
}

interface RawCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  vssId?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

function getVideoIdFromLocation(): string | null {
  try {
    const url = new URL(window.location.href);
    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }
    const shortsMatch = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (shortsMatch?.[1]) return shortsMatch[1];
  } catch {
    // ignore
  }
  return null;
}

function getPlayerResponse(): Record<string, unknown> | null {
  const player = document.getElementById('movie_player') as MoviePlayerElement | null;
  if (player && typeof player.getPlayerResponse === 'function') {
    const resp = player.getPlayerResponse();
    if (resp && typeof resp === 'object') return resp;
  }

  const win = window as unknown as { ytInitialPlayerResponse?: Record<string, unknown> };
  if (win.ytInitialPlayerResponse && typeof win.ytInitialPlayerResponse === 'object') {
    return win.ytInitialPlayerResponse;
  }
  return null;
}

function extractChaptersFromYtInitialData(durationSec: number): Chapter[] {
  const flexy = document.querySelector('ytd-watch-flexy') as { data?: unknown } | null;
  const win = window as unknown as { ytInitialData?: unknown };
  const root = flexy?.data ?? win.ytInitialData;
  if (!root || typeof root !== 'object') return [];

  const found: Array<{ title: string; startTime: number }> = [];
  const visited = new Set<unknown>();
  const stack: unknown[] = [root];
  let steps = 0;

  while (stack.length > 0 && steps < 6000) {
    steps += 1;
    const node = stack.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    const rec = node as Record<string, unknown>;
    const macro = rec.macroMarkersListItemRenderer as Record<string, unknown> | undefined;
    const chapterRenderer = rec.chapterRenderer as Record<string, unknown> | undefined;

    const target = macro ?? chapterRenderer;
    if (target) {
      const titleObj = target.title as
        | { simpleText?: string; runs?: Array<{ text?: string }> }
        | undefined;
      const title =
        titleObj?.simpleText ||
        titleObj?.runs?.map((r) => r.text ?? '').join('') ||
        '';

      let startMs: number | null = null;
      if (typeof target.timeRangeStartMillis === 'number') {
        startMs = target.timeRangeStartMillis;
      } else {
        const onTap = target.onTap as Record<string, unknown> | undefined;
        const watchEndpoint = (onTap?.watchEndpoint ??
          (target.navigationEndpoint as Record<string, unknown> | undefined)?.watchEndpoint) as
          | Record<string, unknown>
          | undefined;
        if (typeof watchEndpoint?.startTimeSeconds === 'number') {
          startMs = watchEndpoint.startTimeSeconds * 1000;
        }
      }

      if (title.trim() && startMs !== null && Number.isFinite(startMs)) {
        found.push({
          title: title.trim(),
          startTime: Math.max(0, Math.floor(startMs / 1000)),
        });
      }
    }

    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') {
        stack.push(val);
      }
    }
  }

  if (found.length < 2) return [];

  const byStart = new Map<number, string>();
  for (const item of found) {
    if (!byStart.has(item.startTime)) {
      byStart.set(item.startTime, item.title);
    }
  }

  const sorted = Array.from(byStart.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([startTime, title]) => ({ startTime, title }));

  return sorted.map((item, idx) => {
    const next = sorted[idx + 1];
    return {
      id: `yt-native-${idx}-${item.startTime}`,
      title: item.title,
      startTime: item.startTime,
      endTime: next ? next.startTime : Math.max(item.startTime, durationSec),
      source: 'youtube' as const,
    };
  });
}

function extractCaptionTracks(playerResponse: Record<string, unknown> | null): CaptionTrackInfo[] {
  const captions = playerResponse?.captions as Record<string, unknown> | undefined;
  const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const tracks = renderer?.captionTracks as RawCaptionTrack[] | undefined;
  if (!Array.isArray(tracks)) return [];

  return tracks
    .filter((t): t is RawCaptionTrack & { baseUrl: string } => typeof t.baseUrl === 'string' && t.baseUrl.length > 0)
    .map((t) => {
      const name =
        t.name?.simpleText ||
        t.name?.runs?.map((r) => r.text ?? '').join('') ||
        t.languageCode ||
        'Unknown';
      return {
        baseUrl: t.baseUrl,
        languageCode: t.languageCode || 'en',
        name,
        isAutoGenerated: Boolean(t.vssId?.startsWith('a.')),
      };
    });
}

function collectVideoPayload(): {
  meta: VideoMetadata | null;
  youtubeChapters: Chapter[];
  captionTracks: CaptionTrackInfo[];
} {
  const videoId = getVideoIdFromLocation();
  if (!videoId) {
    return { meta: null, youtubeChapters: [], captionTracks: [] };
  }

  const playerResponse = getPlayerResponse();
  const videoDetails = (playerResponse?.videoDetails ?? {}) as Record<string, unknown>;
  const player = document.getElementById('movie_player') as MoviePlayerElement | null;
  const playerData = player?.getVideoData?.();

  // Only accept playerResponse if it matches the current URL videoId
  const respVideoId = typeof videoDetails.videoId === 'string' ? videoDetails.videoId : null;
  const matchesCurrent = !respVideoId || respVideoId === videoId;

  const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string');
  const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a');
  const videoEl = document.querySelector('video');

  const title =
    (matchesCurrent && typeof videoDetails.title === 'string' ? videoDetails.title : '') ||
    playerData?.title ||
    titleEl?.textContent?.trim() ||
    document.title.replace(/\s*-\s*YouTube$/, '').trim();

  const channelName =
    (matchesCurrent && typeof videoDetails.author === 'string' ? videoDetails.author : '') ||
    playerData?.author ||
    channelEl?.textContent?.trim() ||
    'Unknown Channel';

  const channelUrl = (channelEl as HTMLAnchorElement | null)?.href || '';
  const durationFromResp =
    matchesCurrent && videoDetails.lengthSeconds ? Number(videoDetails.lengthSeconds) : 0;
  const durationFromPlayer = player?.getDuration?.() ?? 0;
  const durationFromVideo = videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  const durationSec = Math.max(
    0,
    Math.round(durationFromResp || durationFromPlayer || durationFromVideo || 0)
  );

  const description =
    matchesCurrent && typeof videoDetails.shortDescription === 'string'
      ? videoDetails.shortDescription
      : '';

  const descChapters = parseDescriptionChapters(description, durationSec);
  const nativeChapters = descChapters.length > 0 ? descChapters : extractChaptersFromYtInitialData(durationSec);
  const captionTracks = matchesCurrent ? extractCaptionTracks(playerResponse) : [];

  return {
    meta: {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      channelName,
      channelUrl,
      durationSec,
      description,
    },
    youtubeChapters: nativeChapters,
    captionTracks,
  };
}

function pickBestTrack(tracks: CaptionTrackInfo[]): CaptionTrackInfo | null {
  if (tracks.length === 0) return null;
  const manualEn = tracks.find((t) => t.languageCode.startsWith('en') && !t.isAutoGenerated);
  if (manualEn) return manualEn;
  const anyEn = tracks.find((t) => t.languageCode.startsWith('en'));
  if (anyEn) return anyEn;
  const manualAny = tracks.find((t) => !t.isAutoGenerated);
  return manualAny ?? tracks[0] ?? null;
}

function parseTimestampText(timeText: string): number | null {
  const parts = timeText.trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  return null;
}

function readTranscriptFromDom(): TranscriptCue[] {
  const cues: TranscriptCue[] = [];

  // Modern 2025/2026 YouTube transcript DOM
  const viewModels = document.querySelectorAll('transcript-segment-view-model');
  if (viewModels && viewModels.length > 0) {
    viewModels.forEach((node) => {
      const timeText =
        node.querySelector('.ytwTranscriptSegmentViewModelTimestamp')?.textContent?.trim() || '';
      const bodyText =
        node.querySelector('span[role="text"], .ytAttributedStringHost')?.textContent?.trim() || '';
      const sec = parseTimestampText(timeText);
      if (sec !== null && bodyText) {
        cues.push({ startSec: sec, durationSec: 3, text: bodyText });
      }
    });
  }

  // Legacy YouTube transcript DOM fallback
  if (cues.length === 0) {
    const legacyNodes = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (legacyNodes && legacyNodes.length > 0) {
      legacyNodes.forEach((node) => {
        const timeText = node.querySelector('.segment-timestamp')?.textContent?.trim() || '';
        const bodyText = node.querySelector('.segment-text')?.textContent?.trim() || '';
        const sec = parseTimestampText(timeText);
        if (sec !== null && bodyText) {
          cues.push({ startSec: sec, durationSec: 3, text: bodyText });
        }
      });
    }
  }

  // Fill durationSec from gap to next cue
  for (let i = 0; i < cues.length - 1; i++) {
    const curr = cues[i];
    const next = cues[i + 1];
    if (curr && next && next.startSec > curr.startSec) {
      curr.durationSec = Math.max(1, next.startSec - curr.startSec);
    }
  }
  return cues;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchTranscriptViaYouTubePanel(): Promise<TranscriptCue[]> {
  const existing = readTranscriptFromDom();
  if (existing.length > 0) return existing;

  const panel = document.querySelector(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
  );
  const wasExpanded =
    panel?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';

  let transcriptBtn: HTMLElement | null = null;
  let clickedExpand = false;

  // Wait for YouTube's watch metadata / description expander to hydrate
  for (let i = 0; i < 16; i++) {
    transcriptBtn = document.querySelector(
      'ytd-video-description-transcript-section-renderer button'
    ) as HTMLElement | null;
    if (transcriptBtn) break;

    if (!clickedExpand) {
      const expandBtn = document.querySelector(
        'ytd-text-inline-expander #expand, #description-inline-expander #expand, #expand'
      ) as HTMLElement | null;
      if (expandBtn) {
        expandBtn.click();
        clickedExpand = true;
      }
    }
    await waitMs(300);
  }

  if (!transcriptBtn) {
    return [];
  }

  transcriptBtn.click();

  for (let attempt = 0; attempt < 20; attempt++) {
    await waitMs(250);
    const cues = readTranscriptFromDom();
    if (cues.length > 0) {
      if (!wasExpanded) {
        const closeBtn = document.querySelector(
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button'
        ) as HTMLElement | null;
        closeBtn?.click();
      }
      return cues;
    }
  }

  return [];
}

async function fetchTranscriptForVideo(requestedVideoId: string): Promise<{
  videoId: string;
  cues: TranscriptCue[];
  error?: string;
}> {
  const immediateDom = readTranscriptFromDom();
  if (immediateDom.length > 0) {
    return { videoId: requestedVideoId, cues: immediateDom };
  }

  let payload = collectVideoPayload();

  // If SPA just navigated and playerResponse hasn't updated yet, fetch watch HTML as fallback
  if (payload.captionTracks.length === 0 && requestedVideoId) {
    try {
      const htmlRes = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(requestedVideoId)}`, {
        credentials: 'include',
      });
      const html = await htmlRes.text();
      const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|let\s|const\s|<\/script)/s);
      if (match?.[1]) {
        const parsed = JSON.parse(match[1]) as Record<string, unknown>;
        const tracks = extractCaptionTracks(parsed);
        if (tracks.length > 0) {
          payload = { ...payload, captionTracks: tracks };
        }
      }
    } catch {
      // ignore fallback HTML fetch errors
    }
  }

  const track = pickBestTrack(payload.captionTracks);
  if (track) {
    // Try JSON3 first
    try {
      const sep = track.baseUrl.includes('?') ? '&' : '?';
      const jsonUrl = track.baseUrl.includes('fmt=')
        ? track.baseUrl.replace(/fmt=[^&]+/, 'fmt=json3')
        : `${track.baseUrl}${sep}fmt=json3`;

      const res = await fetch(jsonUrl, { credentials: 'include' });
      if (res.ok) {
        const raw = await res.text();
        if (raw.trim().startsWith('{')) {
          const parsed = parseJson3Transcript(JSON.parse(raw));
          if (parsed.length > 0) {
            return { videoId: requestedVideoId, cues: parsed };
          }
        }
      }
    } catch {
      // fall through to XML
    }

    // Fallback to default XML timedtext
    try {
      const res = await fetch(track.baseUrl, { credentials: 'include' });
      if (res.ok) {
        const xml = await res.text();
        const parsed = parseXmlTranscript(xml);
        if (parsed.length > 0) {
          return { videoId: requestedVideoId, cues: parsed };
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback to YouTube's native transcript drawer (handles PoToken / exp=xpe tracks)
  const panelCues = await fetchTranscriptViaYouTubePanel();
  if (panelCues.length > 0) {
    return { videoId: requestedVideoId, cues: panelCues };
  }

  return {
    videoId: requestedVideoId,
    cues: [],
    error: track
      ? 'YouTube protected this transcript with PoToken; click "Show transcript" in the description and hit Refresh.'
      : 'No captions/transcript available for this video.',
  };
}

function postVideoData() {
  const payload = collectVideoPayload();
  window.postMessage(
    {
      source: 'chaptermind-main',
      type: 'CHAPTERMIND_VIDEO_DATA',
      payload,
    },
    '*'
  );
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as {
    source?: string;
    type?: string;
    videoId?: string;
    seconds?: number;
  } | null;
  if (!data || data.source !== 'chaptermind-isolated') return;

  if (data.type === 'CHAPTERMIND_REQUEST_VIDEO_DATA') {
    postVideoData();
  } else if (data.type === 'CHAPTERMIND_FETCH_TRANSCRIPT' && data.videoId) {
    void fetchTranscriptForVideo(data.videoId).then((result) => {
      window.postMessage(
        {
          source: 'chaptermind-main',
          type: 'CHAPTERMIND_TRANSCRIPT_RESULT',
          payload: result,
        },
        '*'
      );
    });
  } else if (data.type === 'CHAPTERMIND_SEEK_TO' && typeof data.seconds === 'number') {
    const target = Math.max(0, data.seconds);
    const player = document.getElementById('movie_player') as MoviePlayerElement | null;
    if (player && typeof player.seekTo === 'function') {
      if (typeof player.getPlayerState === 'function' && player.getPlayerState() === -1) {
        player.playVideo?.();
      }
      player.seekTo(target, true);
    } else {
      const video = document.querySelector('video');
      if (video) video.currentTime = target;
    }
  }
});

window.addEventListener('yt-navigate-finish', () => {
  setTimeout(postVideoData, 300);
});
window.addEventListener('yt-page-data-updated', () => {
  setTimeout(postVideoData, 300);
});
