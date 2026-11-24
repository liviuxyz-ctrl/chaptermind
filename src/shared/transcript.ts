import type { TranscriptCue } from './types';
import { formatTimestamp } from './chapters';

interface Json3Seg {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

interface Json3Payload {
  events?: Json3Event[];
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function parseJson3Transcript(data: unknown): TranscriptCue[] {
  const payload = data as Json3Payload | null;
  if (!payload || !Array.isArray(payload.events)) {
    return [];
  }

  const cues: TranscriptCue[] = [];
  for (const ev of payload.events) {
    if (!Array.isArray(ev.segs) || ev.segs.length === 0) continue;
    const rawText = ev.segs.map((s) => s.utf8 ?? '').join('');
    const text = decodeHtmlEntities(rawText).replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const startSec = Math.max(0, (ev.tStartMs ?? 0) / 1000);
    const durationSec = Math.max(0, (ev.dDurationMs ?? 2000) / 1000);
    cues.push({ startSec, durationSec, text });
  }

  return cues;
}

export function parseXmlTranscript(xml: string): TranscriptCue[] {
  if (!xml || typeof xml !== 'string') return [];

  const cues: TranscriptCue[] = [];
  // Handles both <text start="1.23" dur="2.34">...</text> and <p t="1230" d="2340">...</p>
  const textTagRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;

  while ((match = textTagRegex.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const startMatch = attrs.match(/\bstart="([^"]+)"/i);
    const durMatch = attrs.match(/\bdur="([^"]+)"/i);

    const startSec = startMatch ? Math.max(0, parseFloat(startMatch[1] ?? '0')) : 0;
    const durationSec = durMatch ? Math.max(0, parseFloat(durMatch[1] ?? '2')) : 2;
    const stripped = inner.replace(/<[^>]+>/g, ' ');
    const text = decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
    if (text) {
      cues.push({ startSec, durationSec, text });
    }
  }

  if (cues.length > 0) return cues;

  // Fallback for timedtext format=srv3 (<p t="ms" d="ms"><s>...</s></p>)
  const pTagRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  while ((match = pTagRegex.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const tMatch = attrs.match(/\bt="(\d+)"/i);
    const dMatch = attrs.match(/\bd="(\d+)"/i);
    if (!tMatch) continue;

    const startSec = Math.max(0, Number(tMatch[1]) / 1000);
    const durationSec = dMatch ? Math.max(0, Number(dMatch[1]) / 1000) : 2;
    const stripped = inner.replace(/<[^>]+>/g, '');
    const text = decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
    if (text) {
      cues.push({ startSec, durationSec, text });
    }
  }

  return cues;
}

export function mergeTranscriptCues(cues: TranscriptCue[], maxBlockSec = 18): TranscriptCue[] {
  if (cues.length === 0) return [];

  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const merged: TranscriptCue[] = [];

  let current: TranscriptCue | null = null;

  for (const cue of sorted) {
    if (!cue.text.trim()) continue;
    if (!current) {
      current = { ...cue };
      continue;
    }

    // Avoid duplicating exact overlapping auto-caption fragments
    if (current.text.endsWith(cue.text) && cue.startSec - current.startSec < 4) {
      continue;
    }

    const span = cue.startSec + cue.durationSec - current.startSec;
    const gap = cue.startSec - (current.startSec + current.durationSec);
    const endsSentence = /[.!?]$/.test(current.text);

    if (span <= maxBlockSec && gap < 3.5 && (!endsSentence || span < 8)) {
      current.text = `${current.text} ${cue.text}`.replace(/\s+/g, ' ').trim();
      current.durationSec = Math.max(
        current.durationSec,
        cue.startSec + cue.durationSec - current.startSec
      );
    } else {
      merged.push(current);
      current = { ...cue };
    }
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

export function formatTranscriptForPrompt(
  cues: TranscriptCue[],
  maxChars = 48000
): { text: string; truncated: boolean } {
  if (cues.length === 0) {
    return { text: '', truncated: false };
  }

  const merged = mergeTranscriptCues(cues, 20);
  const lines = merged.map((cue) => `[${formatTimestamp(cue.startSec)}] ${cue.text}`);
  const full = lines.join('\n');

  if (full.length <= maxChars) {
    return { text: full, truncated: false };
  }

  // Evenly sample lines across the entire video so long videos don't lose the ending
  const targetLines = Math.max(40, Math.floor((lines.length * maxChars) / full.length));
  const step = lines.length / targetLines;
  const sampled: string[] = [];
  let charCount = 0;

  for (let i = 0; i < targetLines; i++) {
    const idx = Math.min(lines.length - 1, Math.floor(i * step));
    const line = lines[idx];
    if (!line) continue;
    if (charCount + line.length + 1 > maxChars) break;
    sampled.push(line);
    charCount += line.length + 1;
  }

  return {
    text: sampled.join('\n'),
    truncated: true,
  };
}
