import { describe, expect, it } from 'vitest';
import {
  exportEntryToMarkdown,
  getActiveEntries,
  getExpiredTrashIds,
  getTrashedEntries,
  searchKnowledgeBase,
} from '../src/shared/kb-storage';
import type { KnowledgeEntry } from '../src/shared/types';

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    videoId: 'v1',
    url: 'https://www.youtube.com/watch?v=v1',
    title: 'Sample Video',
    channelName: 'Channel',
    channelUrl: '',
    durationSec: 300,
    savedAt: 1000,
    updatedAt: 2000,
    aiProviderUsed: 'gemini:gemini-2.5-flash',
    tldr: 'Summary text',
    chapters: [],
    aiSponsors: [],
    sponsorBlockCount: 0,
    sponsorTimeStrippedSec: 0,
    keyTakeaways: [],
    entities: [],
    tags: [],
    cleanedTranscript: [],
    ...overrides,
  };
}

describe('Library Categories and 30-day Recycle Bin', () => {
  it('separates active vs trashed entries and detects expired >30d trash items', () => {
    const now = 100 * 86_400_000;
    const active = makeEntry({ videoId: 'a1', category: 'Work' });
    const recentTrash = makeEntry({ videoId: 't-recent', trashedAt: now - 5 * 86_400_000 });
    const oldTrash = makeEntry({ videoId: 't-old', trashedAt: now - 31 * 86_400_000 });

    const all = [active, recentTrash, oldTrash];
    expect(getActiveEntries(all).map((e) => e.videoId)).toEqual(['a1']);
    expect(getTrashedEntries(all).map((e) => e.videoId)).toEqual(['t-recent', 't-old']);
    expect(getExpiredTrashIds(all, 30, now)).toEqual(['t-old']);
  });

  it('filters Knowledge Base search by category (including uncategorized) and exports YAML category', () => {
    const workEntry = makeEntry({ videoId: 'w1', title: 'Kubernetes Tuning', category: 'Work' });
    const aiEntry = makeEntry({ videoId: 'ai1', title: 'Claude Agents', category: 'AI & Tech' });
    const uncatEntry = makeEntry({ videoId: 'u1', title: 'Misc Notes' });

    const list = [workEntry, aiEntry, uncatEntry];
    expect(searchKnowledgeBase(list, '', 'all', 'Work').map((r) => r.entry.videoId)).toEqual(['w1']);
    expect(
      searchKnowledgeBase(list, '', 'all', 'uncategorized').map((r) => r.entry.videoId)
    ).toEqual(['u1']);
    expect(searchKnowledgeBase(list, 'claude', 'all', 'Work')).toHaveLength(0);

    const md = exportEntryToMarkdown(workEntry);
    expect(md).toContain('category: "Work"');
  });
});
