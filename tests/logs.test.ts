import { describe, expect, it } from 'vitest';
import { appendActivityLog, formatActivityLogsText } from '../src/shared/logs';
import type { ActivityLogEntry } from '../src/shared/types';

describe('Activity Logs ring buffer and formatter', () => {
  it('prepends newest entries and enforces maxEntries cap', () => {
    let logs: ActivityLogEntry[] = [];
    for (let i = 1; i <= 125; i++) {
      logs = appendActivityLog(
        logs,
        {
          level: i % 2 === 0 ? 'success' : 'info',
          scope: 'queue',
          message: `Event #${i}`,
          videoId: `vid-${i}`,
          ts: 1_700_000_000_000 + i * 1000,
        },
        120
      );
    }

    expect(logs).toHaveLength(120);
    expect(logs[0]?.message).toBe('Event #125');
    expect(logs[0]?.videoId).toBe('vid-125');
    expect(logs[119]?.message).toBe('Event #6');
  });

  it('formats log lines cleanly with level, scope, message, and videoId', () => {
    const sample = appendActivityLog([], {
      level: 'error',
      scope: 'github',
      message: 'Auto-push skipped: HTTP 409',
      videoId: '7n3cZzR0tVE',
      ts: new Date(2026, 10, 25, 9, 40, 12).getTime(),
    });

    const formatted = formatActivityLogsText(sample);
    expect(formatted).toBe(
      '[09:40:12] [ERROR] [github] Auto-push skipped: HTTP 409 (7n3cZzR0tVE)'
    );
  });
});
