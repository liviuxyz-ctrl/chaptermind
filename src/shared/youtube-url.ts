/**
 * Helpers for extracting canonical YouTube video IDs from watch, shorts, share,
 * embed, and live URLs.
 */
export function extractYouTubeVideoId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, 'https://www.youtube.com');
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return isValidVideoId(id) ? id : null;
    }

    if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (isValidVideoId(v)) return v;

      const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (match && isValidVideoId(match[1])) {
        return match[1];
      }
    }
  } catch {
    const rawMatch = rawUrl.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
    if (rawMatch && isValidVideoId(rawMatch[1])) return rawMatch[1];
  }
  return null;
}

function isValidVideoId(id: string | null | undefined): id is string {
  return Boolean(id && /^[A-Za-z0-9_-]{11}$/.test(id));
}

/**
 * Extracts unique canonical 11-char YouTube video IDs from whitespace/comma/newline separated
 * URLs or raw video IDs, preserving input order.
 */
export function extractAllYouTubeVideoIds(input: string): string[] {
  if (!input) return [];
  const tokens = input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    const id = isValidVideoId(token) ? token : extractYouTubeVideoId(token);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
