import { describe, expect, it } from 'vitest';
import {
  formatTranscriptForPrompt,
  mergeTranscriptCues,
  parseJson3Transcript,
  parseXmlTranscript,
} from '../src/shared/transcript';

describe('Transcript parsing and formatting', () => {
  it('parses json3 events and decodes HTML entities', () => {
    const cues = parseJson3Transcript({
      events: [
        { tStartMs: 1200, dDurationMs: 2500, segs: [{ utf8: 'Hello &amp; welcome ' }, { utf8: 'to AI' }] },
        { tStartMs: 4000, dDurationMs: 1000, segs: [] },
      ],
    });

    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({
      startSec: 1.2,
      durationSec: 2.5,
      text: 'Hello & welcome to AI',
    });
  });

  it('parses XML timedtext cues and decodes numeric entities', () => {
    const xml = `<transcript><text start="10.5" dur="3.2">It&#39;s &quot;Gemini 5&quot;</text></transcript>`;
    const cues = parseXmlTranscript(xml);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe(`It's "Gemini 5"`);
    expect(cues[0]?.startSec).toBe(10.5);
  });

  it('merges short caption cues into readable blocks', () => {
    const merged = mergeTranscriptCues(
      [
        { startSec: 1, durationSec: 2, text: 'First fragment' },
        { startSec: 3, durationSec: 2, text: 'second fragment.' },
        { startSec: 25, durationSec: 3, text: 'Later topic' },
      ],
      15
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.text).toBe('First fragment second fragment.');
    expect(merged[1]?.text).toBe('Later topic');
  });

  it('downsamples ultra-long transcripts across full duration', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      startSec: i * 25,
      durationSec: 20,
      text: `Line number ${i} discussing benchmark results and architecture details.`,
    }));
    const { text, truncated } = formatTranscriptForPrompt(many, 1200);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain('Line number 0');
  });
});
