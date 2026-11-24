import { describe, expect, it } from 'vitest';
import { extractAllYouTubeVideoIds, extractYouTubeVideoId } from '../src/shared/youtube-url';

describe('YouTube URL and multi-video ID extraction', () => {
  it('extracts IDs from single watch, short, share, embed, and live URLs', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe(
      'dQw4w9WgXcQ'
    );
    expect(extractYouTubeVideoId('https://youtu.be/7n3cZzR0tVE?si=abc')).toBe('7n3cZzR0tVE');
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/JhZB3spnulY')).toBe('JhZB3spnulY');
    expect(extractYouTubeVideoId('https://www.youtube.com/live/gEJ26rECifc?feature=share')).toBe(
      'gEJ26rECifc'
    );
    expect(extractYouTubeVideoId('https://www.youtube.com/@AILABS')).toBeNull();
  });

  it('parses and deduplicates multiple newline/comma/space separated URLs and raw IDs', () => {
    const input = `
      https://www.youtube.com/watch?v=7n3cZzR0tVE&t=12s,
      https://youtu.be/gEJ26rECifc
      JhZB3spnulY
      https://www.youtube.com/shorts/7n3cZzR0tVE
      https://www.youtube.com/feed/subscriptions
    `;
    expect(extractAllYouTubeVideoIds(input)).toEqual([
      '7n3cZzR0tVE',
      'gEJ26rECifc',
      'JhZB3spnulY',
    ]);
  });
});
