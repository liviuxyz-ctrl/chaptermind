import type { KbSearchResult, KnowledgeEntry } from './types';
import { formatTimestamp } from './chapters';

const DB_NAME = 'chaptermind_kb';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

function openKbDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open Knowledge Base IndexedDB'));
  });
}

export async function getAllEntries(): Promise<KnowledgeEntry[]> {
  const db = await openKbDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as KnowledgeEntry[]) || [];
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getEntry(videoId: string): Promise<KnowledgeEntry | null> {
  if (!videoId) return null;
  const db = await openKbDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(videoId);
    req.onsuccess = () => resolve((req.result as KnowledgeEntry | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function putEntry(entry: KnowledgeEntry): Promise<void> {
  const db = await openKbDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteEntry(videoId: string): Promise<void> {
  const db = await openKbDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(videoId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllEntries(): Promise<void> {
  const db = await openKbDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.+#_-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export function searchKnowledgeBase(
  entries: KnowledgeEntry[],
  query: string,
  entityTypeFilter = 'all'
): KbSearchResult[] {
  const filteredByEntity =
    entityTypeFilter && entityTypeFilter !== 'all'
      ? entries.filter((entry) => entry.entities.some((e) => e.type === entityTypeFilter))
      : entries;

  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return filteredByEntity.map((entry) => ({
      entry,
      score: 1,
      bestTimestampSec: entry.chapters[0]?.startTime ?? 0,
      matchSnippet: entry.tldr || entry.channelName,
    }));
  }

  const tokens = tokenizeQuery(trimmed);
  const results: KbSearchResult[] = [];

  for (const entry of filteredByEntity) {
    let score = 0;
    let bestTimestampSec = 0;
    let bestFieldScore = -1;
    let matchSnippet = entry.tldr;

    const considerMatch = (fieldScore: number, ts: number, snippet: string) => {
      score += fieldScore;
      if (fieldScore > bestFieldScore) {
        bestFieldScore = fieldScore;
        bestTimestampSec = ts;
        matchSnippet = snippet;
      }
    };

    const titleLower = entry.title.toLowerCase();
    if (titleLower.includes(trimmed)) {
      considerMatch(15, 0, entry.title);
    } else {
      for (const tok of tokens) {
        if (titleLower.includes(tok)) considerMatch(5, 0, entry.title);
      }
    }

    for (const tag of entry.tags) {
      if (tag.toLowerCase().includes(trimmed) || tokens.some((t) => tag.toLowerCase().includes(t))) {
        considerMatch(4, 0, `#${tag}`);
      }
    }

    for (const ent of entry.entities) {
      const hay = `${ent.name} ${ent.note}`.toLowerCase();
      if (hay.includes(trimmed)) {
        considerMatch(14, ent.timestampSec, `${ent.name}: ${ent.note}`);
      } else {
        const hits = tokens.filter((t) => hay.includes(t)).length;
        if (hits > 0) {
          considerMatch(hits * 6, ent.timestampSec, `${ent.name}: ${ent.note}`);
        }
      }
    }

    for (const ch of entry.chapters) {
      const hay = `${ch.title} ${ch.summary ?? ''}`.toLowerCase();
      if (hay.includes(trimmed)) {
        considerMatch(12, ch.startTime, ch.title);
      } else {
        const hits = tokens.filter((t) => hay.includes(t)).length;
        if (hits > 0) {
          considerMatch(hits * 5, ch.startTime, ch.title);
        }
      }
    }

    for (const tk of entry.keyTakeaways) {
      const hay = tk.text.toLowerCase();
      if (hay.includes(trimmed)) {
        considerMatch(11, tk.timestampSec, tk.text);
      } else {
        const hits = tokens.filter((t) => hay.includes(t)).length;
        if (hits > 0) {
          considerMatch(hits * 4, tk.timestampSec, tk.text);
        }
      }
    }

    if (entry.tldr.toLowerCase().includes(trimmed)) {
      considerMatch(8, 0, entry.tldr);
    }

    for (const cue of entry.cleanedTranscript) {
      const hay = cue.text.toLowerCase();
      if (hay.includes(trimmed)) {
        considerMatch(6, cue.startSec, cue.text);
        break;
      }
      if (tokens.length > 0 && tokens.every((t) => hay.includes(t))) {
        considerMatch(5, cue.startSec, cue.text);
        break;
      }
    }

    if (score > 0) {
      results.push({
        entry,
        score,
        bestTimestampSec,
        matchSnippet,
      });
    }
  }

  results.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
  return results;
}

function ytTimestampUrl(videoId: string, sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `https://youtu.be/${videoId}?t=${s}`;
}

export function exportEntryToMarkdown(entry: KnowledgeEntry): string {
  const tagsYaml = entry.tags.map((t) => `  - ${t}`).join('\n');
  const dateStr = new Date(entry.savedAt || Date.now()).toISOString().slice(0, 10);

  const lines: string[] = [
    '---',
    `video_id: "${entry.videoId}"`,
    `title: "${entry.title.replace(/"/g, '\\"')}"`,
    `channel: "${entry.channelName.replace(/"/g, '\\"')}"`,
    `url: "https://youtu.be/${entry.videoId}"`,
    `duration: "${formatTimestamp(entry.durationSec)}"`,
    `sponsor_stripped_sec: ${entry.sponsorTimeStrippedSec}`,
    `saved_date: "${dateStr}"`,
    `ai_provider: "${entry.aiProviderUsed}"`,
    'tags:',
    tagsYaml || '  - youtube-ai',
    '---',
    '',
    `# ${entry.title}`,
    '',
    `> **Channel:** ${entry.channelName} | **Watch:** https://youtu.be/${entry.videoId} | **SponsorBlock Stripped:** ${entry.sponsorTimeStrippedSec}s`,
    '',
    '## TL;DR',
    entry.tldr || '_No summary generated._',
    '',
  ];

  if (entry.chapters.length > 0) {
    lines.push('## Chapters');
    for (const ch of entry.chapters) {
      const ts = formatTimestamp(ch.startTime);
      const link = ytTimestampUrl(entry.videoId, ch.startTime);
      const summary = ch.summary ? ` — ${ch.summary}` : '';
      lines.push(`- [${ts}](${link}) **${ch.title}**${summary}`);
    }
    lines.push('');
  }

  if (entry.keyTakeaways.length > 0) {
    lines.push('## Key Takeaways');
    for (const tk of entry.keyTakeaways) {
      const ts = formatTimestamp(tk.timestampSec);
      const link = ytTimestampUrl(entry.videoId, tk.timestampSec);
      lines.push(`- [${ts}](${link}) ${tk.text}`);
    }
    lines.push('');
  }

  if (entry.entities.length > 0) {
    lines.push('## Models, Tools & Concepts');
    for (const ent of entry.entities) {
      const ts = formatTimestamp(ent.timestampSec);
      const link = ytTimestampUrl(entry.videoId, ent.timestampSec);
      lines.push(`- **${ent.name}** (\`${ent.type}\`, [${ts}](${link})): ${ent.note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function exportAllToMarkdown(entries: KnowledgeEntry[]): string {
  return entries.map((e) => exportEntryToMarkdown(e)).join('\n\n---\n\n');
}
