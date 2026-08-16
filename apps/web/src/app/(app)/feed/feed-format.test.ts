import { describe, expect, it } from 'vitest';
import { formatFeedTimestamp } from '@xitter/ui';

const NOW = '2026-08-15T12:00:00Z';

describe('feed timestamp format (shared with @xitter/ui suite)', () => {
  it('relative and rounded to the most significant figure under 24h', () => {
    expect(formatFeedTimestamp('2026-08-15T10:40:00Z', NOW)).toBe('1h');
    expect(formatFeedTimestamp('2026-08-15T11:20:00Z', NOW)).toBe('40m');
  });

  it('absolute after 24h', () => {
    expect(formatFeedTimestamp('2026-08-14T12:00:00Z', NOW)).toBe('14 Aug 2026 12:00');
  });
});
