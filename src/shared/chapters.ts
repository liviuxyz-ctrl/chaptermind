import type { Chapter, ChapterFilterMode } from './types';

export function formatTimestamp(totalSec: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function parseTimestamp(value: string | number): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.floor(parseFloat(trimmed)));
  }

  const parts = trimmed.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (parts.length === 2) {
    return Math.floor((parts[0] ?? 0) * 60 + (parts[1] ?? 0));
  }
  if (parts.length === 3) {
    return Math.floor((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0));
  }
  return null;
}

export function parseDescriptionChapters(description: string, durationSec: number): Chapter[] {
  if (!description) return [];

  const lines = description.split(/\r?\n/);
  const rawEntries: Array<{ startTime: number; title: string }> = [];

  // Matches timestamps at line start or after bullets/brackets: e.g. "0:00 Intro", "[02:15] - Gemini 5", "1:05:10 Summary"
  const linePattern =
    /^(?:[-*•\s]*)\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?(?:\s*[-–—:|•]?\s+)(.+)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(linePattern);
    if (!match) continue;

    const ts = parseTimestamp(match[1] ?? '');
    const title = (match[2] ?? '').trim();
    if (ts === null || !title) continue;
    if (durationSec > 0 && ts >= durationSec) continue;

    rawEntries.push({ startTime: ts, title });
  }

  if (rawEntries.length < 2) {
    return [];
  }

  // Deduplicate by startTime and sort ascending
  const byTime = new Map<number, string>();
  for (const item of rawEntries) {
    if (!byTime.has(item.startTime)) {
      byTime.set(item.startTime, item.title);
    }
  }

  const sorted = Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([startTime, title]) => ({ startTime, title }));

  return sorted.map((entry, idx) => {
    const next = sorted[idx + 1];
    const endTime = next ? next.startTime : Math.max(entry.startTime, durationSec);
    return {
      id: `yt-${idx}-${entry.startTime}`,
      title: entry.title,
      startTime: entry.startTime,
      endTime,
      source: 'youtube' as const,
    };
  });
}

function finalizeChapterBounds(chapters: Chapter[], durationSec: number): Chapter[] {
  const sorted = [...chapters]
    .filter((c) => Number.isFinite(c.startTime) && c.startTime >= 0)
    .sort((a, b) => a.startTime - b.startTime);

  return sorted.map((ch, idx) => {
    const next = sorted[idx + 1];
    let endTime = ch.endTime;
    if (!Number.isFinite(endTime) || endTime <= ch.startTime) {
      endTime = next ? next.startTime : Math.max(ch.startTime, durationSec);
    }
    if (durationSec > 0) {
      endTime = Math.min(durationSec, Math.max(ch.startTime, endTime));
    }
    return {
      ...ch,
      endTime,
    };
  });
}

export function mergeChapters(
  youtubeChapters: Chapter[],
  sbChapters: Chapter[],
  aiChapters: Chapter[],
  mode: ChapterFilterMode,
  durationSec: number
): Chapter[] {
  if (mode === 'ai') {
    return finalizeChapterBounds(aiChapters, durationSec);
  }
  if (mode === 'youtube') {
    return finalizeChapterBounds(youtubeChapters, durationSec);
  }
  if (mode === 'sponsorblock') {
    return finalizeChapterBounds(sbChapters, durationSec);
  }
  if (mode === 'all') {
    return finalizeChapterBounds([...aiChapters, ...youtubeChapters, ...sbChapters], durationSec);
  }

  // 'best': Prefer AI topic chapters (built on sponsor-cleaned transcript) if available,
  // otherwise YouTube native chapters, otherwise SponsorBlock chapters.
  if (aiChapters.length > 0) {
    return finalizeChapterBounds(aiChapters, durationSec);
  }
  if (youtubeChapters.length > 0) {
    return finalizeChapterBounds(youtubeChapters, durationSec);
  }
  return finalizeChapterBounds(sbChapters, durationSec);
}

export function getActiveChapter(chapters: Chapter[], currentTimeSec: number): Chapter | null {
  if (chapters.length === 0) return null;
  const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);
  let active: Chapter | null = null;
  for (const ch of sorted) {
    if (currentTimeSec >= ch.startTime) {
      active = ch;
    } else {
      break;
    }
  }
  return active ?? sorted[0] ?? null;
}

export function getAdjacentChapter(
  chapters: Chapter[],
  currentTimeSec: number,
  direction: 'prev' | 'next'
): Chapter | null {
  if (chapters.length === 0) return null;
  const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);

  const active = getActiveChapter(sorted, currentTimeSec);
  if (!active) return sorted[0] ?? null;

  const activeIndex = sorted.findIndex((c) => c.id === active.id);
  if (direction === 'next') {
    return sorted[activeIndex + 1] ?? null;
  }

  // 'prev': if more than 3s into current chapter, restart current chapter first
  if (currentTimeSec - active.startTime > 3) {
    return active;
  }
  return activeIndex > 0 ? (sorted[activeIndex - 1] ?? null) : active;
}
