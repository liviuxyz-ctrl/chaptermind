import type { ActivityLogEntry } from './types';

export function appendActivityLog(
  existing: ActivityLogEntry[],
  entry: Omit<ActivityLogEntry, 'id' | 'ts'> & { ts?: number },
  maxEntries = 120
): ActivityLogEntry[] {
  const ts = entry.ts ?? Date.now();
  const nextItem: ActivityLogEntry = {
    id: `${ts}-${Math.random().toString(36).slice(2, 7)}`,
    ts,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    ...(entry.videoId ? { videoId: entry.videoId } : {}),
  };
  return [nextItem, ...existing].slice(0, Math.max(1, maxEntries));
}

export function formatLogTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatActivityLogsText(logs: ActivityLogEntry[]): string {
  return logs
    .map((entry) => {
      const time = formatLogTimestamp(entry.ts);
      const vidSuffix = entry.videoId ? ` (${entry.videoId})` : '';
      return `[${time}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${vidSuffix}`;
    })
    .join('\n');
}
