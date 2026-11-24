import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  getActiveChapter,
  getAdjacentChapter,
  mergeChapters,
  parseDescriptionChapters,
  parseTimestamp,
} from '../src/shared/chapters';
import type { Chapter } from '../src/shared/types';

describe('Chapters and timestamp helpers', () => {
  it('formats and parses MM:SS and H:MM:SS timestamps', () => {
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(3661)).toBe('1:01:01');
    expect(parseTimestamp('02:15')).toBe(135);
    expect(parseTimestamp('1:05:10')).toBe(3910);
  });

  it('parses chapters from YouTube video description', () => {
    const desc = `
Check out today's AI news:
0:00 Intro
01:45 - Gemini 5 Leaks
12:30 GLM 5.4 Benchmarks
    `;
    const chapters = parseDescriptionChapters(desc, 1200);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]?.title).toBe('Intro');
    expect(chapters[0]?.endTime).toBe(105);
    expect(chapters[2]?.endTime).toBe(1200);
  });

  it('merges best chapters prioritizing AI when present', () => {
    const yt: Chapter[] = [
      { id: 'y1', title: 'Part 1', startTime: 0, endTime: 300, source: 'youtube' },
    ];
    const ai: Chapter[] = [
      { id: 'a1', title: 'AI Intro', startTime: 0, endTime: 100, source: 'ai' },
      { id: 'a2', title: 'Deep Dive', startTime: 100, endTime: 300, source: 'ai' },
    ];
    const best = mergeChapters(yt, [], ai, 'best', 300);
    expect(best).toHaveLength(2);
    expect(best[0]?.source).toBe('ai');
  });

  it('handles active and adjacent chapters with 3-second restart threshold', () => {
    const chapters: Chapter[] = [
      { id: '1', title: 'Intro', startTime: 0, endTime: 60, source: 'ai' },
      { id: '2', title: 'Models', startTime: 60, endTime: 180, source: 'ai' },
      { id: '3', title: 'Outro', startTime: 180, endTime: 240, source: 'ai' },
    ];

    expect(getActiveChapter(chapters, 75)?.id).toBe('2');
    expect(getAdjacentChapter(chapters, 75, 'next')?.id).toBe('3');
    // >3s into chapter 2 restarts chapter 2
    expect(getAdjacentChapter(chapters, 75, 'prev')?.id).toBe('2');
    // <=3s into chapter 2 jumps to chapter 1
    expect(getAdjacentChapter(chapters, 61, 'prev')?.id).toBe('1');
  });
});
