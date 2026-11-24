import { describe, expect, it } from 'vitest';
import {
  base64ToUtf8,
  fetchKnowledgeBaseFromGithub,
  parseGithubRepo,
  pushKnowledgeBaseToGithub,
  utf8ToBase64,
} from '../src/shared/github-sync';
import { DEFAULT_SETTINGS, type KnowledgeEntry } from '../src/shared/types';

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    videoId: 'vid123',
    url: 'https://www.youtube.com/watch?v=vid123',
    title: 'Gemini 5 & Coding Agents 🚀',
    channelName: 'AI News',
    channelUrl: '',
    durationSec: 600,
    savedAt: 1000,
    updatedAt: 2000,
    aiProviderUsed: 'openai:gpt-5-mini',
    tldr: 'Covers Gemini 5 and coding agents.',
    chapters: [{ id: 'c1', title: 'Intro', startTime: 0, endTime: 120, source: 'ai' }],
    aiSponsors: [],
    sponsorBlockCount: 1,
    sponsorTimeStrippedSec: 40,
    keyTakeaways: [{ text: 'Fast coding', timestampSec: 50 }],
    entities: [{ name: 'Gemini 5', type: 'model', note: 'Frontier LLM', timestampSec: 30 }],
    tags: ['ai-news'],
    cleanedTranscript: [],
    ...overrides,
  };
}

describe('GitHub Knowledge Base Sync', () => {
  it('encodes and decodes UTF-8 strings with emojis safely', () => {
    const raw = 'Hello 世界 🚀 — ChapterMind!';
    expect(base64ToUtf8(utf8ToBase64(raw))).toBe(raw);
  });

  it('parses owner/repo and full GitHub URLs', () => {
    expect(parseGithubRepo('liviuxyz-ctrl/chaptermind-kb')).toEqual({
      owner: 'liviuxyz-ctrl',
      repo: 'chaptermind-kb',
    });
    expect(parseGithubRepo('https://github.com/liviuxyz-ctrl/chaptermind-kb.git')).toEqual({
      owner: 'liviuxyz-ctrl',
      repo: 'chaptermind-kb',
    });
  });

  it('pushes JSON, Markdown, and index.json to GitHub and skips unchanged files', async () => {
    const remoteFiles = new Map<string, { sha: string; content: string }>();

    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const match = u.match(/\/contents\/([^?]+)/);
      const filePath = decodeURIComponent(match?.[1] || '');
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'GET') {
        const hit = remoteFiles.get(filePath);
        if (!hit) return new Response('Not Found', { status: 404 });
        return new Response(
          JSON.stringify({ sha: hit.sha, encoding: 'base64', content: utf8ToBase64(hit.content) }),
          { status: 200 }
        );
      }

      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { content: string; sha?: string };
        remoteFiles.set(filePath, {
          sha: `sha-${remoteFiles.size + 1}`,
          content: base64ToUtf8(body.content),
        });
        return new Response(JSON.stringify({ content: { path: filePath } }), { status: 201 });
      }

      return new Response('Method Not Allowed', { status: 405 });
    };

    const settings = {
      ...DEFAULT_SETTINGS,
      githubRepo: 'user/kb',
      githubBranch: 'main',
      githubFolder: 'knowledge-base',
      githubToken: 'ghp_test',
    };
    const entry = makeEntry();

    const first = await pushKnowledgeBaseToGithub(settings, [entry], mockFetch as typeof fetch);
    expect(first.pushedFiles).toBe(3); // json + md + index.json
    expect(first.skippedFiles).toBe(0);
    expect(remoteFiles.has('knowledge-base/videos/vid123.json')).toBe(true);
    expect(remoteFiles.has('knowledge-base/index.json')).toBe(true);

    // Second push with identical entry skips json and md (index.json updates timestamp)
    const second = await pushKnowledgeBaseToGithub(settings, [entry], mockFetch as typeof fetch);
    expect(second.skippedFiles).toBe(2);
    expect(second.pushedFiles).toBe(1);
  });

  it('fetches new or newer entries and remote interests from GitHub', async () => {
    const remoteNew = makeEntry({ videoId: 'newVid', updatedAt: 5000 });
    const remoteOlder = makeEntry({ videoId: 'oldVid', updatedAt: 1000 });
    const localOlder = makeEntry({ videoId: 'oldVid', updatedAt: 3000 });

    const files = new Map<string, string>([
      [
        'knowledge-base/index.json',
        JSON.stringify({
          version: 1,
          updatedAt: 5000,
          topicsIgnore: ['crypto'],
          topicsCare: ['coding agents'],
          videos: [
            { videoId: 'newVid', title: remoteNew.title, channelName: 'AI', updatedAt: 5000 },
            { videoId: 'oldVid', title: remoteOlder.title, channelName: 'AI', updatedAt: 1000 },
          ],
        }),
      ],
      ['knowledge-base/videos/newVid.json', JSON.stringify(remoteNew)],
      ['knowledge-base/videos/oldVid.json', JSON.stringify(remoteOlder)],
    ]);

    const mockFetch = async (url: RequestInfo | URL) => {
      const match = String(url).match(/\/contents\/([^?]+)/);
      const filePath = decodeURIComponent(match?.[1] || '');
      const content = files.get(filePath);
      if (!content) return new Response('Not Found', { status: 404 });
      return new Response(
        JSON.stringify({ sha: 's1', encoding: 'base64', content: utf8ToBase64(content) }),
        { status: 200 }
      );
    };

    const res = await fetchKnowledgeBaseFromGithub(
      {
        ...DEFAULT_SETTINGS,
        githubRepo: 'user/kb',
        githubBranch: 'main',
        githubFolder: 'knowledge-base',
        githubToken: '',
      },
      [localOlder],
      mockFetch as typeof fetch
    );

    expect(res.totalRemote).toBe(2);
    expect(res.fetchedCount).toBe(1);
    expect(res.entriesToSave[0]?.videoId).toBe('newVid');
    expect(res.remoteInterests?.topicsIgnore).toEqual(['crypto']);
  });
});
