import { describe, expect, it } from 'vitest';
import {
  extractSponsorBlockChapters,
  fetchSponsorBlockSegments,
  sha256Hex,
  stripSponsorSegmentsFromTranscript,
} from '../src/shared/sponsorblock';
import type { SponsorSegment, TranscriptCue } from '../src/shared/types';

describe('SponsorBlock utilities', () => {
  it('computes SHA-256 hex digest for k-anonymity prefix', async () => {
    const hash = await sha256Hex('7n3cZzR0tVE');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fetches segments using 4-char hash prefix and treats 404 as empty', async () => {
    const mock404 = async () => new Response('Not found', { status: 404 });
    const empty = await fetchSponsorBlockSegments('7n3cZzR0tVE', true, mock404 as typeof fetch);
    expect(empty).toEqual([]);

    const mockOk = async () =>
      new Response(
        JSON.stringify([
          {
            videoID: '7n3cZzR0tVE',
            segments: [
              {
                UUID: 'seg-1',
                category: 'sponsor',
                actionType: 'skip',
                segment: [30, 75],
              },
              {
                UUID: 'seg-2',
                category: 'chapter',
                actionType: 'chapter',
                segment: [0, 30],
                description: 'Intro',
              },
            ],
          },
          {
            videoID: 'otherVideoId',
            segments: [
              {
                UUID: 'other-1',
                category: 'sponsor',
                actionType: 'skip',
                segment: [10, 20],
              },
            ],
          },
        ]),
        { status: 200 }
      );

    const segs = await fetchSponsorBlockSegments('7n3cZzR0tVE', true, mockOk as typeof fetch);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.category).toBe('chapter');
    expect(segs[1]?.uuid).toBe('seg-1');
  });

  it('strips sponsor cues from transcript while keeping content and chapters', () => {
    const cues: TranscriptCue[] = [
      { startSec: 5, durationSec: 4, text: 'Welcome to AI news' },
      { startSec: 32, durationSec: 10, text: 'Today sponsor is VPN Corp' },
      { startSec: 55, durationSec: 8, text: 'Use code AI20 at checkout' },
      { startSec: 82, durationSec: 5, text: 'Now lets talk about Gemini 5' },
    ];
    const segments: SponsorSegment[] = [
      {
        uuid: 'sp1',
        category: 'sponsor',
        actionType: 'skip',
        startTime: 30,
        endTime: 75,
        source: 'sponsorblock',
      },
      {
        uuid: 'ch1',
        category: 'chapter',
        actionType: 'chapter',
        startTime: 0,
        endTime: 30,
        description: 'Intro',
        source: 'sponsorblock',
      },
    ];

    const res = stripSponsorSegmentsFromTranscript(cues, segments);
    expect(res.removedCueCount).toBe(2);
    expect(res.removedDurationSec).toBe(45);
    expect(res.cleanedCues.map((c) => c.text)).toEqual([
      'Welcome to AI news',
      'Now lets talk about Gemini 5',
    ]);
  });

  it('extracts SponsorBlock chapters with proper end times', () => {
    const segments: SponsorSegment[] = [
      {
        uuid: 'c1',
        category: 'chapter',
        actionType: 'chapter',
        startTime: 0,
        endTime: 0,
        description: 'Intro',
        source: 'sponsorblock',
      },
      {
        uuid: 'c2',
        category: 'chapter',
        actionType: 'chapter',
        startTime: 90,
        endTime: 90,
        description: 'GLM 5.4',
        source: 'sponsorblock',
      },
    ];
    const chapters = extractSponsorBlockChapters(segments, 300);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.endTime).toBe(90);
    expect(chapters[1]?.endTime).toBe(300);
  });
});
