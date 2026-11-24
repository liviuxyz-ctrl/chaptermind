import type {
  Chapter,
  SponsorActionType,
  SponsorCategory,
  SponsorSegment,
  TranscriptCue,
} from './types';

export const SPONSORBLOCK_API_BASE = 'https://sponsor.ajay.app/api';

export const ALL_SPONSOR_CATEGORIES: SponsorCategory[] = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'hook',
  'filler',
  'poi_highlight',
  'chapter',
  'music_offtopic',
  'exclusive_access',
];

export const SKIPPABLE_AD_CATEGORIES: SponsorCategory[] = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'filler',
];

export const CATEGORY_COLORS: Record<SponsorCategory, string> = {
  sponsor: '#00d400',
  selfpromo: '#ffff00',
  interaction: '#cc00ff',
  intro: '#00ffff',
  outro: '#0202ed',
  preview: '#008fd6',
  hook: '#395699',
  filler: '#7300ff',
  poi_highlight: '#ff1684',
  chapter: '#9ca3af',
  music_offtopic: '#ff9900',
  exclusive_access: '#008a5c',
};

export const CATEGORY_LABELS: Record<SponsorCategory, string> = {
  sponsor: 'Sponsor',
  selfpromo: 'Unpaid / Self Promo',
  interaction: 'Interaction Reminder',
  intro: 'Intermission / Intro',
  outro: 'Endcards / Credits',
  preview: 'Preview / Recap',
  hook: 'Hook / Greetings',
  filler: 'Filler / Tangent',
  poi_highlight: 'Highlight',
  chapter: 'SB Chapter',
  music_offtopic: 'Non-Music Section',
  exclusive_access: 'Exclusive Access',
};

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface RawSbSegment {
  UUID?: string;
  category?: string;
  actionType?: string;
  segment?: [number, number];
  description?: string;
  votes?: number;
}

interface RawSbHashEntry {
  videoID: string;
  segments: RawSbSegment[];
}

function normalizeSegments(rawList: RawSbSegment[]): SponsorSegment[] {
  const validCategories = new Set<string>(ALL_SPONSOR_CATEGORIES);
  const validActions = new Set<string>(['skip', 'mute', 'full', 'poi', 'chapter']);

  return rawList
    .filter(
      (item): item is RawSbSegment & { segment: [number, number] } =>
        Array.isArray(item.segment) &&
        item.segment.length >= 2 &&
        typeof item.segment[0] === 'number' &&
        typeof item.segment[1] === 'number' &&
        typeof item.category === 'string' &&
        validCategories.has(item.category)
    )
    .map((item, idx) => {
      const startTime = Math.max(0, item.segment[0]);
      const endTime = Math.max(startTime, item.segment[1]);
      const actionType: SponsorActionType =
        item.actionType && validActions.has(item.actionType)
          ? (item.actionType as SponsorActionType)
          : item.category === 'chapter'
            ? 'chapter'
            : item.category === 'poi_highlight'
              ? 'poi'
              : 'skip';

      return {
        uuid: item.UUID || `sb-${idx}-${startTime}`,
        category: item.category as SponsorCategory,
        actionType,
        startTime,
        endTime,
        description: item.description || undefined,
        source: 'sponsorblock' as const,
        votes: typeof item.votes === 'number' ? item.votes : undefined,
      };
    })
    .sort((a, b) => a.startTime - b.startTime);
}

export async function fetchSponsorBlockSegments(
  videoId: string,
  usePrivacyPrefix = true,
  fetchFn: typeof fetch = fetch
): Promise<SponsorSegment[]> {
  if (!videoId) return [];

  const categoriesParam = encodeURIComponent(JSON.stringify(ALL_SPONSOR_CATEGORIES));
  const actionTypesParam = encodeURIComponent(
    JSON.stringify(['skip', 'mute', 'full', 'poi', 'chapter'])
  );

  let url: string;
  if (usePrivacyPrefix) {
    const hash = await sha256Hex(videoId);
    const prefix = hash.slice(0, 4);
    url = `${SPONSORBLOCK_API_BASE}/skipSegments/${prefix}?categories=${categoriesParam}&actionTypes=${actionTypesParam}`;
  } else {
    url = `${SPONSORBLOCK_API_BASE}/skipSegments?videoID=${encodeURIComponent(
      videoId
    )}&categories=${categoriesParam}&actionTypes=${actionTypesParam}`;
  }

  const response = await fetchFn(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`SponsorBlock API returned HTTP ${response.status}`);
  }

  const json = await response.json();

  if (usePrivacyPrefix) {
    if (!Array.isArray(json)) return [];
    const match = (json as RawSbHashEntry[]).find((entry) => entry.videoID === videoId);
    return match ? normalizeSegments(match.segments || []) : [];
  }

  if (!Array.isArray(json)) return [];
  return normalizeSegments(json as RawSbSegment[]);
}

export function extractSponsorBlockChapters(
  segments: SponsorSegment[],
  videoDurationSec = 0
): Chapter[] {
  const chapterSegs = segments
    .filter((s) => s.category === 'chapter' || s.actionType === 'chapter')
    .sort((a, b) => a.startTime - b.startTime);

  return chapterSegs.map((seg, idx) => {
    const next = chapterSegs[idx + 1];
    const fallbackEnd = next ? next.startTime : videoDurationSec > seg.startTime ? videoDurationSec : seg.endTime;
    const endTime = seg.endTime > seg.startTime ? seg.endTime : fallbackEnd;
    return {
      id: `sb-ch-${seg.uuid}`,
      title: (seg.description || `Chapter ${idx + 1}`).trim(),
      startTime: seg.startTime,
      endTime: Math.max(seg.startTime, endTime),
      source: 'sponsorblock' as const,
    };
  });
}

export function stripSponsorSegmentsFromTranscript(
  cues: TranscriptCue[],
  segments: SponsorSegment[],
  categoriesToStrip: SponsorCategory[] = SKIPPABLE_AD_CATEGORIES
): {
  cleanedCues: TranscriptCue[];
  removedCueCount: number;
  removedDurationSec: number;
} {
  const stripSet = new Set<SponsorCategory>(categoriesToStrip);
  const activeRanges = segments.filter(
    (seg) =>
      !seg.disabled &&
      stripSet.has(seg.category) &&
      seg.actionType !== 'chapter' &&
      seg.actionType !== 'poi' &&
      seg.endTime > seg.startTime
  );

  if (activeRanges.length === 0) {
    return {
      cleanedCues: [...cues],
      removedCueCount: 0,
      removedDurationSec: 0,
    };
  }

  // Merge overlapping ranges so removedDurationSec isn't double-counted
  const sortedRanges = [...activeRanges]
    .map((r) => ({ start: r.startTime, end: r.endTime }))
    .sort((a, b) => a.start - b.start);

  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const r of sortedRanges) {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      mergedRanges.push({ ...r });
    }
  }

  const removedDurationSec = mergedRanges.reduce((acc, r) => acc + (r.end - r.start), 0);

  const cleanedCues: TranscriptCue[] = [];
  let removedCueCount = 0;

  for (const cue of cues) {
    const cueEnd = cue.startSec + Math.max(0.5, cue.durationSec);
    const midpoint = cue.startSec + Math.max(0, cueEnd - cue.startSec) / 2;
    const insideSponsor = mergedRanges.some(
      (range) => midpoint >= range.start && midpoint <= range.end
    );
    if (insideSponsor) {
      removedCueCount += 1;
    } else {
      cleanedCues.push(cue);
    }
  }

  return {
    cleanedCues,
    removedCueCount,
    removedDurationSec: Math.round(removedDurationSec),
  };
}
