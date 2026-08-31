import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetStatus } from '@xitter/api-contracts';

// The data module is the seam: the fetch path (token, transport, parse)
// stays out of scope - see data/health.test.ts for the boundary behaviour.
vi.mock('../data/health.js', () => ({ fetchResetStatus: vi.fn() }));

const { fetchResetStatus } = await import('../data/health.js');
const { ResetStatusTile, formatDuration, relativeTime, utcTimestamp } =
  await import('./reset-status-tile.js');

const record: ResetStatus = {
  job: 'xitter-reset',
  startedAt: '2026-08-30T00:30:00.000Z',
  finishedAt: '2026-08-30T00:30:42.000Z',
  durationMs: 42_000,
  success: true,
  reseeded: true,
  fingerprint: 'ab12cd34ef56'.repeat(6),
  steps: [],
};

describe('ResetStatusTile', () => {
  beforeEach(() => {
    vi.mocked(fetchResetStatus).mockReset();
  });

  it('renders the record: outcome, timing, fingerprint', async () => {
    vi.mocked(fetchResetStatus).mockResolvedValue(record);
    render(<ResetStatusTile />);

    expect(await screen.findByTestId('reset-status-record')).toBeTruthy();
    expect(screen.getByTestId('reset-status-outcome').textContent).toBe('success');
    expect(screen.getByTestId('reset-status-fingerprint').textContent).toBe('ab12cd34ef56');
    // Full fingerprint rides along for copy/inspect.
    expect(screen.getByTestId('reset-status-fingerprint').getAttribute('title')).toBe(
      record.fingerprint,
    );
    expect(screen.getByTestId('reset-status-duration').textContent).toBe('42s');
    // Absolute wall-clock next to the relative age (the relative half is
    // time-of-run dependent; utcTimestamp has its own coverage below).
    expect(screen.getByTestId('reset-status-time').textContent).toContain('2026-08-30 00:30 UTC');
    expect(fetchResetStatus).toHaveBeenCalledTimes(1);
  });

  it('badges a failed run as failed, not success', async () => {
    vi.mocked(fetchResetStatus).mockResolvedValue({
      ...record,
      success: false,
      reseeded: false,
      fingerprint: null,
    });
    render(<ResetStatusTile />);

    expect(await screen.findByTestId('reset-status-record')).toBeTruthy();
    expect(screen.getByTestId('reset-status-outcome').textContent).toBe('failed');
    // A wipe without reseed has no fingerprint - an honest em dash, not a
    // fake value.
    expect(screen.queryByTestId('reset-status-fingerprint')).toBeNull();
  });

  it('renders a clean empty state when no reset has run (null)', async () => {
    vi.mocked(fetchResetStatus).mockResolvedValue(null);
    render(<ResetStatusTile />);

    expect(await screen.findByTestId('reset-status-empty')).toBeTruthy();
    expect(screen.getByTestId('reset-status-empty').textContent).toContain('No reset recorded yet');
  });

  it('surfaces a fetch failure as an unavailable state, not a crash', async () => {
    vi.mocked(fetchResetStatus).mockRejectedValue(new Error('boom'));
    render(<ResetStatusTile />);

    expect(await screen.findByTestId('reset-status-error')).toBeTruthy();
  });

  it('refetches when the dashboard refresh bumps the key', async () => {
    vi.mocked(fetchResetStatus).mockResolvedValue(record);
    const { rerender } = render(<ResetStatusTile />);
    await screen.findByTestId('reset-status-record');

    rerender(<ResetStatusTile refreshKey={1} />);

    await screen.findByTestId('reset-status-record');
    expect(fetchResetStatus).toHaveBeenCalledTimes(2);
  });
});

describe('reset-status formatting helpers', () => {
  const NOW = Date.parse('2026-08-31T12:00:00.000Z');

  it('relativeTime picks the natural unit', () => {
    const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1_000).toISOString();
    expect(relativeTime(at(0), NOW)).toBe('now');
    expect(relativeTime(at(30), NOW)).toBe('30 seconds ago');
    // Node builds differ in CLDR (a/1 minute) - pin the unit, not the article.
    expect(relativeTime(at(90), NOW)).toMatch(/^(a|1) minute ago$/);
    expect(relativeTime(at(3_600), NOW)).toMatch(/^(an|1) hour ago$/);
    expect(relativeTime(at(2 * 86_400), NOW)).toBe('2 days ago');
  });

  it('formatDuration stays readable across the realistic range', () => {
    expect(formatDuration(9_400)).toBe('9.4s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(123_400)).toBe('2m 3s');
  });

  it('utcTimestamp renders a stable UTC wall-clock string', () => {
    expect(utcTimestamp('2026-08-30T00:30:42.000Z')).toBe('2026-08-30 00:30 UTC');
  });
});
