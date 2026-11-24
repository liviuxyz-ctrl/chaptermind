import { describe, expect, it } from 'vitest';
import {
  addUniqueTopic,
  evaluateChapterRelevance,
  extractTopicFromChapter,
  removeTopic,
} from '../src/shared/interests';
import { buildVideoAnalysisPrompt, parseAiAnalysisResponse } from '../src/shared/prompts';
import type { Chapter, VideoMetadata } from '../src/shared/types';

describe('Interest filter and Don’t Care chapter skipping', () => {
  it('matches semantic aliases for ignored AI topics like image and video models', () => {
    const imgChapter: Chapter = {
      id: 'c1',
      title: 'Nano Banana Pro 2 Previews',
      startTime: 600,
      endTime: 720,
      source: 'ai',
      summary: 'New text-to-image generation model demo',
    };
    const res = evaluateChapterRelevance(imgChapter, {
      topicsIgnore: ['image models', 'video generation'],
      topicsCare: ['frontier LLMs'],
    });
    expect(res.relevance).toBe('skip');
    expect(res.reason).toContain('image models');

    const vidChapter: Chapter = {
      id: 'c2',
      title: 'Sora 2 vs Veo Comparison',
      startTime: 720,
      endTime: 840,
      source: 'youtube',
    };
    const vidRes = evaluateChapterRelevance(vidChapter, {
      topicsIgnore: ['image models', 'video generation'],
      topicsCare: [],
    });
    expect(vidRes.relevance).toBe('skip');
  });

  it('matches custom user-added ignore topics and prioritizes ignore over care', () => {
    const smallChapter: Chapter = {
      id: 'c3',
      title: 'Tiny 1.5B Edge Model Release',
      startTime: 100,
      endTime: 200,
      source: 'ai',
      relevance: 'must_watch',
    };
    const res = evaluateChapterRelevance(smallChapter, {
      topicsIgnore: ['useless small models'],
      topicsCare: ['tiny'],
    });
    expect(res.relevance).toBe('skip');
  });

  it('highlights chapters matching topicsCare and extracts clean topics', () => {
    const careChapter: Chapter = {
      id: 'c4',
      title: 'GLM 5.4 Coding Agent Benchmarks',
      startTime: 350,
      endTime: 500,
      source: 'ai',
    };
    const res = evaluateChapterRelevance(careChapter, {
      topicsIgnore: ['image models'],
      topicsCare: ['coding agents'],
    });
    expect(res.relevance).toBe('must_watch');
    expect(extractTopicFromChapter(careChapter)).toContain('GLM 5.4');

    const updated = addUniqueTopic(['image models'], 'IMAGE MODELS');
    expect(updated).toEqual(['image models']);
    expect(removeTopic(['image models', 'crypto'], 'crypto')).toEqual(['image models']);
  });

  it('embeds viewer interests in prompt and parses AI relevance fields', () => {
    const meta: VideoMetadata = {
      videoId: 'v1',
      url: 'https://www.youtube.com/watch?v=v1',
      title: 'AI News',
      channelName: 'AI',
      channelUrl: '',
      durationSec: 500,
      description: '',
    };
    const prompt = buildVideoAnalysisPrompt(meta, '[0:00] Intro', [], 0, {
      topicsCare: ['coding agents'],
      topicsIgnore: ['image models', 'useless small models'],
    });
    expect(prompt).toContain('VIEWER INTEREST PROFILE');
    expect(prompt).toContain('image models, useless small models');

    const parsed = parseAiAnalysisResponse(
      JSON.stringify({
        tldr: 'Summary',
        chapters: [
          {
            title: 'Flux 2 Demo',
            startSec: 100,
            endSec: 200,
            relevance: 'skip',
            relevanceReason: 'Image generation model',
            topicTags: ['image models', 'flux'],
          },
        ],
        detectedSponsors: [],
        keyTakeaways: [],
        entities: [],
        tags: [],
      }),
      500
    );
    expect(parsed.chapters[0]?.relevance).toBe('skip');
    expect(parsed.chapters[0]?.relevanceReason).toBe('Image generation model');
    expect(parsed.chapters[0]?.topicTags).toEqual(['image models', 'flux']);
  });
});
