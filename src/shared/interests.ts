import type { Chapter, ChapterRelevance, ExtensionSettings } from './types';

const SEMANTIC_ALIASES: Record<string, string[]> = {
  'image models': [
    'image model',
    'image generation',
    'text-to-image',
    'text to image',
    'image editing',
    'midjourney',
    'flux',
    'dall-e',
    'dalle',
    'stable diffusion',
    'imagen',
    'ideogram',
    'nano banana',
    'recraft',
    'seedream',
    'gpt-image',
  ],
  'ai art': [
    'ai art',
    'image generation',
    'midjourney',
    'flux',
    'stable diffusion',
    'illustrations',
    'photorealism',
  ],
  'video generation': [
    'video generation',
    'text-to-video',
    'text to video',
    'ai video',
    'sora',
    'veo',
    'runway',
    'kling',
    'pika',
    'luma',
    'hailuo',
    'wan 2',
  ],
  'useless small models': [
    'small model',
    'tiny model',
    'edge model',
    'on-device model',
    '0.5b',
    '1b model',
    '1.5b',
    '2b model',
    '3b model',
    'mini model',
    'nano model',
  ],
  'small models': [
    'small model',
    'tiny model',
    'edge model',
    'on-device',
    '1b',
    '2b',
    '3b',
  ],
  crypto: ['crypto', 'web3', 'nft', 'blockchain', 'tokenomics', 'memecoin'],
  'voice / audio': ['tts', 'text-to-speech', 'voice clone', 'elevenlabs', 'music generation', 'suno', 'udio'],
  hardware: ['gpu', 'chip', 'tpu', 'nvidia stock', 'earnings', 'datacenter'],
  robotics: ['humanoid', 'robot', 'optimus', 'figure ai'],
};

function expandTerms(topic: string): string[] {
  const norm = topic.trim().toLowerCase();
  if (!norm) return [];
  const terms = new Set<string>([norm]);

  if (norm.endsWith('s') && norm.length > 4) {
    terms.add(norm.slice(0, -1));
  }

  for (const [key, aliases] of Object.entries(SEMANTIC_ALIASES)) {
    if (norm === key || norm.includes(key) || key.includes(norm)) {
      for (const a of aliases) terms.add(a);
    }
  }
  return Array.from(terms);
}

function buildChapterHaystack(chapter: Chapter): string {
  return [
    chapter.title,
    chapter.summary ?? '',
    chapter.relevanceReason ?? '',
    ...(chapter.topicTags ?? []),
  ]
    .join(' ')
    .toLowerCase();
}

function findMatchingTopic(haystack: string, topics: string[]): string | null {
  for (const topic of topics) {
    const clean = topic.trim();
    if (!clean) continue;
    const expanded = expandTerms(clean);
    if (expanded.some((term) => term.length >= 2 && haystack.includes(term))) {
      return clean;
    }
  }
  return null;
}

export interface ChapterRelevanceEval {
  relevance: ChapterRelevance;
  reason?: string;
  matchedTopic?: string;
  matchedSource?: 'allow' | 'ignore' | 'care' | 'ai';
}

export function evaluateChapterRelevance(
  chapter: Chapter,
  settings: Pick<ExtensionSettings, 'topicsIgnore' | 'topicsCare'> & { topicsAllow?: string[] }
): ChapterRelevanceEval {
  const haystack = buildChapterHaystack(chapter);

  // 1. Explicit allow-list override lets the user un-ignore a single chapter
  const matchedAllow = findMatchingTopic(haystack, settings.topicsAllow ?? []);
  if (matchedAllow) {
    const matchedCare = findMatchingTopic(haystack, settings.topicsCare ?? []);
    if (matchedCare) {
      return {
        relevance: 'must_watch',
        reason: `Matches interest: ${matchedCare}`,
        matchedTopic: matchedCare,
        matchedSource: 'care',
      };
    }
    return {
      relevance: 'normal',
      matchedTopic: matchedAllow,
      matchedSource: 'allow',
    };
  }

  // 2. User's "Don't Care" ignore topics
  const matchedIgnore = findMatchingTopic(haystack, settings.topicsIgnore ?? []);
  if (matchedIgnore) {
    return {
      relevance: 'skip',
      reason: `Ignored topic: ${matchedIgnore}`,
      matchedTopic: matchedIgnore,
      matchedSource: 'ignore',
    };
  }

  // 3. Explicit "Care About" topics
  const matchedCare = findMatchingTopic(haystack, settings.topicsCare ?? []);
  if (matchedCare) {
    return {
      relevance: 'must_watch',
      reason: `Matches interest: ${matchedCare}`,
      matchedTopic: matchedCare,
      matchedSource: 'care',
    };
  }

  // 4. Fallback to AI judgment
  if (chapter.relevance === 'skip' || chapter.relevance === 'must_watch') {
    return {
      relevance: chapter.relevance,
      reason: chapter.relevanceReason,
      matchedSource: 'ai',
    };
  }

  return {
    relevance: 'normal',
    reason: chapter.relevanceReason,
  };
}

export function extractTopicFromChapter(chapter: Chapter): string {
  const tag = chapter.topicTags?.find((t) => t.trim().length >= 2);
  if (tag) return tag.trim();

  const cleaned = chapter.title
    .replace(/\([^)]*\)/g, '')
    .replace(/^(intro|summary|update|news|more on|implications?:)\s*/i, '')
    .trim();
  return (cleaned || chapter.title).slice(0, 40).trim();
}

export function addUniqueTopic(list: string[], topic: string): string[] {
  const clean = topic.trim();
  if (!clean) return [...list];
  const lower = clean.toLowerCase();
  if (list.some((item) => item.trim().toLowerCase() === lower)) {
    return [...list];
  }
  return [...list, clean];
}

export function removeTopic(list: string[], topic: string): string[] {
  const lower = topic.trim().toLowerCase();
  return list.filter((item) => item.trim().toLowerCase() !== lower);
}

export function toggleChapterIgnore(
  chapter: Chapter,
  settings: Pick<ExtensionSettings, 'topicsIgnore' | 'topicsCare'> & { topicsAllow?: string[] }
): {
  action: 'ignored' | 'unignored';
  topic: string;
  topicsIgnore: string[];
  topicsCare: string[];
  topicsAllow: string[];
} {
  const evalRes = evaluateChapterRelevance(chapter, settings);
  const extracted = extractTopicFromChapter(chapter);
  const allowList = settings.topicsAllow ?? [];

  if (evalRes.relevance === 'skip') {
    let nextIgnore = [...settings.topicsIgnore];
    let nextAllow = [...allowList];

    // If the matched ignore topic is specific to this chapter (not a broad preset), remove it;
    // otherwise keep broad category rules intact and allow-override this chapter.
    if (
      evalRes.matchedTopic &&
      (evalRes.matchedTopic.toLowerCase() === extracted.toLowerCase() ||
        chapter.title.toLowerCase().includes(evalRes.matchedTopic.toLowerCase()))
    ) {
      nextIgnore = removeTopic(nextIgnore, evalRes.matchedTopic);
    } else {
      nextAllow = addUniqueTopic(nextAllow, extracted);
    }

    return {
      action: 'unignored',
      topic: evalRes.matchedTopic || extracted,
      topicsIgnore: nextIgnore,
      topicsCare: [...settings.topicsCare],
      topicsAllow: nextAllow,
    };
  }

  return {
    action: 'ignored',
    topic: extracted,
    topicsIgnore: addUniqueTopic(settings.topicsIgnore, extracted),
    topicsCare: removeTopic(settings.topicsCare, extracted),
    topicsAllow: removeTopic(allowList, extracted),
  };
}

export function toggleChapterCare(
  chapter: Chapter,
  settings: Pick<ExtensionSettings, 'topicsIgnore' | 'topicsCare'> & { topicsAllow?: string[] }
): {
  action: 'cared' | 'cleared';
  topic: string;
  topicsCare: string[];
  topicsIgnore: string[];
  topicsAllow: string[];
} {
  const evalRes = evaluateChapterRelevance(chapter, settings);
  const extracted = extractTopicFromChapter(chapter);
  const allowList = settings.topicsAllow ?? [];

  if (evalRes.relevance === 'must_watch') {
    const target = evalRes.matchedTopic || extracted;
    return {
      action: 'cleared',
      topic: target,
      topicsCare: removeTopic(settings.topicsCare, target),
      topicsIgnore: [...settings.topicsIgnore],
      topicsAllow: [...allowList],
    };
  }

  return {
    action: 'cared',
    topic: extracted,
    topicsCare: addUniqueTopic(settings.topicsCare, extracted),
    topicsIgnore: removeTopic(settings.topicsIgnore, extracted),
    topicsAllow: addUniqueTopic(allowList, extracted),
  };
}
