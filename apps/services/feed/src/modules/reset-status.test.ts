import { describe, expect, it } from 'vitest';
import { RESET_STATUS_KEY } from '@xitter/config';
import type { ResetStatus } from '@xitter/api-contracts';
import { ValkeyResetStatus } from './reset-status.js';

const sample: ResetStatus = {
  job: 'xitter-reset',
  startedAt: '2026-08-21T00:00:00.000Z',
  finishedAt: '2026-08-21T00:00:42.000Z',
  durationMs: 42_000,
  success: true,
  reseeded: true,
  fingerprint: 'a'.repeat(64),
  steps: [{ name: 'flush-valkey', ok: true, durationMs: 12 }],
};

function fakeConnection(raw: string | null) {
  const calls: string[] = [];
  return {
    calls,
    connection: {
      async get(key: string) {
        calls.push(`get:${key}`);
        return raw;
      },
      async quit() {
        calls.push('quit');
      },
    },
  };
}

describe('ValkeyResetStatus', () => {
  it('returns the parsed record from the shared key', async () => {
    const fake = fakeConnection(JSON.stringify(sample));
    const reader = new ValkeyResetStatus('redis://localhost:6379');
    reader.useConnection(fake.connection);
    await expect(reader.latest()).resolves.toEqual(sample);
    expect(fake.calls).toEqual([`get:${RESET_STATUS_KEY}`]);
  });

  it('returns null when no reset has run', async () => {
    const reader = new ValkeyResetStatus('redis://localhost:6379');
    reader.useConnection(fakeConnection(null).connection);
    await expect(reader.latest()).resolves.toBeNull();
  });

  it('degrades to null on a corrupt or unreadable record', async () => {
    const corrupt = new ValkeyResetStatus('redis://localhost:6379');
    corrupt.useConnection(fakeConnection('{not json').connection);
    await expect(corrupt.latest()).resolves.toBeNull();

    const unreachable = new ValkeyResetStatus('redis://localhost:1', async () => {
      throw new Error('connection refused');
    });
    await expect(unreachable.latest()).resolves.toBeNull();
  });
});
