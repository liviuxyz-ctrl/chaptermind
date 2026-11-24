import { describe, expect, it } from 'vitest';
import { parseAiAnalysisResponse } from '../src/shared/prompts';
import { exportEntryToMarkdown, searchKnowledgeBase } from '../src/shared/kb-storage';
import type { KnowledgeEntry } from '../src/shared/types';

describe('AI response parsing and Knowledge Base search/export', () => {
  it('parses fenced JSON with string MM:SS timestamps', () => {
    const raw = `Here is the breakdown:
\`\`\`json
{
  "tldr": "Covers Gemini 5 rumors and GLM 5.4 release.",
  "chapters": [
    { "title": "Gemini 5 Leaks", "startSec": "0:15", "endSec": "03:20", "summary": "New reasoning benchmarks" },
    { "title": "GLM 5.4 Release", "startSec": 200, "endSec": 450 }
  ],
  "detectedSponsors": [
    { "startSec": 450, "endSec": 510, "category": "sponsor", "reason": "Host read ad" }
  ],
  "keyTakeaways": [
    { "text": "GLM 5.4 is open weights", "timestampSec": "03:35" }
  ],
  "entities": [
    { "name": "GLM 5.4", "type": "model", "note": "Open-weight LLM", "timestampSec": 215 }
  ],
  "tags": ["AI-News", "LLM"]
}
\`\`\``;

    const parsed = parseAiAnalysisResponse(raw, 600);
    expect(parsed.tldr).toContain('Gemini 5');
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0]?.startSec).toBe(15);
    expect(parsed.chapters[0]?.endSec).toBe(200);
    expect(parsed.detectedSponsors).toHaveLength(1);
    expect(parsed.keyTakeaways[0]?.timestampSec).toBe(215);
    expect(parsed.tags).toEqual(['ai-news', 'llm']);
  });

  it('searches KB entries and surfaces exact matched timestamp', () => {
    const entries: KnowledgeEntry[] = [
      {
        videoId: 'abc123',
        url: 'https://www.youtube.com/watch?v=abc123',
        title: 'Weekly AI Roundup',
        channelName: 'AI Channel',
        channelUrl: '',
        durationSec: 600,
        savedAt: 1000,
        updatedAt: 1000,
        aiProviderUsed: 'gemini',
        tldr: 'Roundup of weekly releases',
        chapters: [{ id: 'c1', title: 'Intro', startTime: 0, endTime: 100, source: 'ai' }],
        aiSponsors: [],
        sponsorBlockCount: 1,
        sponsorTimeStrippedSec: 45,
        keyTakeaways: [{ text: 'Nano Banana Pro 2 launches', timestampSec: 340 }],
        entities: [{ name: 'Nano Banana Pro 2', type: 'model', note: 'Image model', timestampSec: 340 }],
        tags: ['ai'],
        cleanedTranscript: [],
      },
    ];

    const results = searchKnowledgeBase(entries, 'Nano Banana');
    expect(results).toHaveLength(1);
    expect(results[0]?.bestTimestampSec).toBe(340);

    const md = exportEntryToMarkdown(entries[0]!);
    expect(md).toContain('https://youtu.be/abc123?t=340');
    expect(md).toContain('sponsor_stripped_sec: 45');
  });
});
