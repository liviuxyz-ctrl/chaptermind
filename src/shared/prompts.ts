import type {
  AiAnalysisResult,
  Chapter,
  DetectedSponsor,
  KnowledgeEntity,
  KnowledgeEntry,
  KnowledgeTakeaway,
  VideoMetadata,
} from './types';
import { formatTimestamp, parseTimestamp } from './chapters';

export interface InterestProfileInput {
  topicsCare: string[];
  topicsIgnore: string[];
}

export function buildVideoAnalysisPrompt(
  meta: VideoMetadata,
  cleanedTranscriptText: string,
  existingChapters: Chapter[],
  sponsorBlockCount: number,
  interests?: InterestProfileInput
): string {
  const existingChapStr =
    existingChapters.length > 0
      ? existingChapters
          .map((c) => `- [${formatTimestamp(c.startTime)}] ${c.title}`)
          .join('\n')
      : 'None';

  const careList = interests?.topicsCare?.length
    ? interests.topicsCare.join(', ')
    : 'frontier LLMs, coding agents, reasoning models, developer tools';
  const ignoreList = interests?.topicsIgnore?.length
    ? interests.topicsIgnore.join(', ')
    : 'None specified';

  return `You are ChapterMind, an expert AI video analyst building a personal AI knowledge base and fast-skip chapter navigator.

Analyze the YouTube video below using ONLY the provided metadata and transcript (SponsorBlock already stripped ${sponsorBlockCount} known sponsor/ad segments).

VIDEO METADATA:
- Video ID: ${meta.videoId}
- Title: ${meta.title}
- Channel: ${meta.channelName}
- Duration: ${formatTimestamp(meta.durationSec)} (${meta.durationSec}s)

VIEWER INTEREST PROFILE (VERY IMPORTANT):
- Topics the viewer CARES ABOUT (mark chapter "relevance": "must_watch"): ${careList}
- Topics the viewer DOES NOT CARE ABOUT and wants AUTO-SKIPPED (mark chapter "relevance": "skip" with a short "relevanceReason"): ${ignoreList}
- Everything else: mark "relevance": "normal".

EXISTING YOUTUBE CHAPTERS (for reference only — improve/split vague ones into crisp topic chapters):
${existingChapStr}

TRANSCRIPT (timestamped [MM:SS] or [H:MM:SS]):
${cleanedTranscriptText}

INSTRUCTIONS:
1. Create crisp, scannable TOPIC CHAPTERS so the viewer can skip directly to each AI news item, model release, benchmark, tool demo, or core concept. Never invent timestamps outside 0..${meta.durationSec}.
2. Tag EVERY chapter with \`relevance\` ("must_watch" | "normal" | "skip"), \`relevanceReason\`, and 1-3 short \`topicTags\` (e.g. ["image models", "nano banana"] or ["coding agents"]).
3. Detect any remaining sponsor reads, paid promos, self-promos, or "like & subscribe" filler that SponsorBlock missed in \`detectedSponsors\`. If none, return \`[]\`.
4. Extract high-signal \`keyTakeaways\` with exact \`timestampSec\`.
5. Extract \`entities\` (AI models, tools, GitHub repos, papers, companies, concepts) with \`type\` one of: "model" | "tool" | "repo" | "paper" | "company" | "concept".
6. Return ONLY a valid JSON object inside a \`\`\`json code fence matching this exact schema (no trailing commas, no comments):

\`\`\`json
{
  "tldr": "2-3 sentence high-signal summary of the video.",
  "chapters": [
    {
      "title": "Short clickable chapter title",
      "startSec": 0,
      "endSec": 95,
      "summary": "One crisp sentence describing what is covered here.",
      "relevance": "must_watch",
      "relevanceReason": "Covers coding agents",
      "topicTags": ["coding agents"]
    }
  ],
  "detectedSponsors": [
    {
      "startSec": 120,
      "endSec": 175,
      "category": "sponsor",
      "reason": "Brief explanation (e.g. NordVPN ad read)"
    }
  ],
  "keyTakeaways": [
    {
      "text": "Concrete insight, benchmark, or release detail",
      "timestampSec": 45
    }
  ],
  "entities": [
    {
      "name": "Entity Name",
      "type": "model",
      "note": "Why it was mentioned in this video",
      "timestampSec": 60
    }
  ],
  "tags": ["ai-news", "llm"]
}
\`\`\``;
}

function extractJsonCandidate(rawText: string): string {
  const trimmed = rawText.trim();
  // 1. Prefer explicit ```json ... ``` fenced block
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence?.[1]) {
    return jsonFence[1].trim();
  }

  // 2. Any ``` ... ``` fenced block
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence?.[1]) {
    return anyFence[1].trim();
  }

  // 3. First balanced-looking { ... } object
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function clampSec(val: unknown, durationSec: number): number {
  const parsed =
    typeof val === 'number' || typeof val === 'string' ? parseTimestamp(val) : null;
  if (parsed === null) return 0;
  if (durationSec > 0) {
    return Math.max(0, Math.min(durationSec, parsed));
  }
  return Math.max(0, parsed);
}

export function parseAiAnalysisResponse(
  rawText: string,
  videoDurationSec: number
): AiAnalysisResult {
  const candidate = extractJsonCandidate(rawText);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Could not parse AI response as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI response JSON must be an object.');
  }

  const tldr = typeof parsed.tldr === 'string' ? parsed.tldr.trim() : '';

  const validRelevance = new Set(['must_watch', 'normal', 'skip']);
  const rawChapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const normalizedChapters = rawChapters
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
    .map((c, idx) => {
      const startSec = clampSec(c.startSec ?? c.start ?? c.timestamp, videoDurationSec);
      const rawEnd = c.endSec ?? c.end;
      const endSec =
        rawEnd !== undefined ? clampSec(rawEnd, videoDurationSec) : startSec;
      const title =
        typeof c.title === 'string' && c.title.trim()
          ? c.title.trim()
          : `Chapter ${idx + 1}`;
      const summary = typeof c.summary === 'string' ? c.summary.trim() : undefined;
      const relStr = typeof c.relevance === 'string' ? c.relevance.toLowerCase().trim() : 'normal';
      const relevance = (
        validRelevance.has(relStr) ? relStr : 'normal'
      ) as 'must_watch' | 'normal' | 'skip';
      const relevanceReason =
        typeof c.relevanceReason === 'string' && c.relevanceReason.trim()
          ? c.relevanceReason.trim()
          : undefined;
      const topicTags = Array.isArray(c.topicTags)
        ? c.topicTags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      return { title, startSec, endSec, summary, relevance, relevanceReason, topicTags };
    })
    .sort((a, b) => a.startSec - b.startSec);

  const chapters = normalizedChapters.map((ch, idx) => {
    const next = normalizedChapters[idx + 1];
    let endSec = ch.endSec;
    if (endSec <= ch.startSec) {
      endSec = next ? next.startSec : Math.max(ch.startSec, videoDurationSec);
    }
    return {
      ...ch,
      endSec: Math.max(ch.startSec, endSec),
    };
  });

  const validSponsorCategories = new Set([
    'sponsor',
    'selfpromo',
    'interaction',
    'intro',
    'outro',
    'filler',
  ]);
  const rawSponsors = Array.isArray(parsed.detectedSponsors) ? parsed.detectedSponsors : [];
  const detectedSponsors: DetectedSponsor[] = rawSponsors
    .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
    .map((s) => {
      const startSec = clampSec(s.startSec ?? s.start, videoDurationSec);
      const endSec = clampSec(s.endSec ?? s.end, videoDurationSec);
      const catStr = typeof s.category === 'string' ? s.category : 'sponsor';
      const category = (
        validSponsorCategories.has(catStr) ? catStr : 'sponsor'
      ) as DetectedSponsor['category'];
      const reason = typeof s.reason === 'string' ? s.reason.trim() : 'AI-detected promo';
      return { startSec, endSec, category, reason };
    })
    .filter((s) => s.endSec > s.startSec + 2);

  const rawTakeaways = Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [];
  const keyTakeaways: KnowledgeTakeaway[] = rawTakeaways
    .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
    .map((t) => ({
      text: typeof t.text === 'string' ? t.text.trim() : '',
      timestampSec: clampSec(t.timestampSec ?? t.timestamp, videoDurationSec),
    }))
    .filter((t) => t.text.length > 0);

  const validEntityTypes = new Set(['model', 'tool', 'repo', 'paper', 'company', 'concept']);
  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const entities: KnowledgeEntity[] = rawEntities
    .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
    .map((e) => {
      const typeStr = typeof e.type === 'string' ? e.type.toLowerCase() : 'concept';
      return {
        name: typeof e.name === 'string' ? e.name.trim() : '',
        type: (validEntityTypes.has(typeStr) ? typeStr : 'concept') as KnowledgeEntity['type'],
        note: typeof e.note === 'string' ? e.note.trim() : '',
        timestampSec: clampSec(e.timestampSec ?? e.timestamp, videoDurationSec),
      };
    })
    .filter((e) => e.name.length > 0);

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    : [];

  return {
    tldr,
    chapters,
    detectedSponsors,
    keyTakeaways,
    entities,
    tags,
  };
}

export function buildKbQuestionPrompt(
  question: string,
  matchedEntries: KnowledgeEntry[]
): string {
  const contextBlocks = matchedEntries.map((entry, idx) => {
    const chLines = entry.chapters
      .slice(0, 12)
      .map((c) => `  - [${formatTimestamp(c.startTime)}] ${c.title}${c.summary ? `: ${c.summary}` : ''}`)
      .join('\n');
    const tkLines = entry.keyTakeaways
      .slice(0, 10)
      .map((t) => `  - [${formatTimestamp(t.timestampSec)}] ${t.text}`)
      .join('\n');
    const entLines = entry.entities
      .slice(0, 12)
      .map((e) => `  - ${e.name} (${e.type}) @ ${formatTimestamp(e.timestampSec)}: ${e.note}`)
      .join('\n');

    return `### Video ${idx + 1}: ${entry.title}
Channel: ${entry.channelName}
URL: https://youtu.be/${entry.videoId}
TL;DR: ${entry.tldr}
Chapters:
${chLines || '  (none)'}
Key Takeaways:
${tkLines || '  (none)'}
Entities:
${entLines || '  (none)'}`;
  });

  return `You are answering a question from the user's personal YouTube AI Video Knowledge Base.
Answer clearly and concisely using ONLY the saved video notes below. Whenever referencing a point, cite the video title and exact timestamp in the format [Video Title @ MM:SS].

USER QUESTION:
${question}

KNOWLEDGE BASE SOURCES:
${contextBlocks.join('\n\n')}`;
}
