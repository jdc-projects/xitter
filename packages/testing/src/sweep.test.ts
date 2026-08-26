import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORPHAN_AGE_MS,
  ENV_TEARDOWN_GRACE_MS,
  TEST_RESOURCE_LABEL_PREFIX,
  anySuiteActive,
  createdMs,
  endSuiteActivity,
  ensureSuiteActivity,
  hasTestResourceLabel,
  selectOrphanResources,
} from './sweep.js';

/**
 * The sweep decision logic is the safety net for #47: a bug here deletes a
 * colleague's running suite's containers. These tests pin the contract -
 * label match + age gate + liveness marker - without needing docker.
 */

const NOW = Date.parse('2026-08-26T12:00:00Z');

describe('hasTestResourceLabel', () => {
  it('matches every fixture label', () => {
    for (const label of [
      'xitter.test.postgres',
      'xitter.test.kafka',
      'xitter.test.opensearch',
      'xitter.test.rustfs',
    ]) {
      expect(hasTestResourceLabel({ [label]: 'true' })).toBe(true);
    }
  });

  it('rejects foreign and unlabelled resources', () => {
    expect(hasTestResourceLabel({ 'org.testcontainers': 'true' })).toBe(false);
    expect(hasTestResourceLabel({ 'org.testcontainers.session-id': 'abc' })).toBe(false);
    // Prefix must include the trailing dot - bare "xitter.test" is not ours.
    expect(hasTestResourceLabel({ 'xitter.test': 'true' })).toBe(false);
    expect(hasTestResourceLabel({})).toBe(false);
    expect(hasTestResourceLabel(undefined)).toBe(false);
    expect(hasTestResourceLabel(null)).toBe(false);
  });
});

describe('createdMs', () => {
  it('converts epoch seconds (containers endpoint)', () => {
    expect(createdMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('converts RFC3339 strings (networks/volumes endpoints)', () => {
    expect(createdMs('2026-08-26T11:00:00Z')).toBe(Date.parse('2026-08-26T11:00:00Z'));
  });

  it('returns null for unparseable values (never selectable)', () => {
    expect(createdMs('not-a-date')).toBeNull();
  });
});

describe('selectOrphanResources', () => {
  it('selects labelled resources past the age gate', () => {
    const old = Date.parse('2026-08-26T10:00:00Z') / 1000;
    const resources = [
      { Id: 'a', Created: old, Labels: { 'xitter.test.postgres': 'true' } },
    ];
    expect(selectOrphanResources(resources, NOW, DEFAULT_ORPHAN_AGE_MS).map((r) => r.Id)).toEqual(['a']);
  });

  it("keeps a live suite's younger containers", () => {
    const young = (NOW - 5 * 60_000) / 1000;
    const resources = [
      { Id: 'live', Created: young, Labels: { 'xitter.test.kafka': 'true' } },
    ];
    expect(selectOrphanResources(resources, NOW, DEFAULT_ORPHAN_AGE_MS)).toEqual([]);
  });

  it('never selects unlabelled resources however old', () => {
    const ancient = Date.parse('2020-01-01T00:00:00Z') / 1000;
    const resources = [
      { Id: 'prod-db', Created: ancient, Labels: { 'com.docker.compose.project': 'xitter-local' } },
      { Id: 'no-labels', Created: ancient },
    ];
    expect(selectOrphanResources(resources, NOW, ENV_TEARDOWN_GRACE_MS)).toEqual([]);
  });

  it('selects exactly-at-threshold resources (boundary is inclusive)', () => {
    const exactly = (NOW - ENV_TEARDOWN_GRACE_MS) / 1000;
    const resources = [
      { Id: 'edge', Created: exactly, Labels: { 'xitter.test.rustfs': 'true' } },
    ];
    expect(selectOrphanResources(resources, NOW, ENV_TEARDOWN_GRACE_MS).map((r) => r.Id)).toEqual(['edge']);
  });

  it('skips resources with an unparseable creation time', () => {
    const resources = [
      { Id: 'weird', Created: 'garbage' as unknown as number, Labels: { 'xitter.test.postgres': 'true' } },
    ];
    expect(selectOrphanResources(resources, NOW, ENV_TEARDOWN_GRACE_MS)).toEqual([]);
  });
});

describe('suite activity markers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xitter-sweep-test-'));
    process.env.XITTER_TEST_ACTIVE_DIR = root;
  });

  afterEach(() => {
    endSuiteActivity();
    delete process.env.XITTER_TEST_ACTIVE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    endSuiteActivity();
  });

  it('reports no active suite when no markers exist', () => {
    expect(anySuiteActive()).toBe(false);
  });

  it('detects a fresh marker from a live suite', () => {
    mkdirSync(join(root, '4242'));
    expect(anySuiteActive()).toBe(true);
  });

  it('ignores stale markers (hard-killed runs) and removes them', () => {
    const marker = join(root, '9999');
    mkdirSync(marker);
    const stale = new Date(Date.now() - 5 * 60_000);
    utimesSync(marker, stale, stale);
    expect(anySuiteActive()).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed when the marker root cannot be read', () => {
    const filePath = join(root, 'not-a-dir');
    writeFileSync(filePath, 'x');
    process.env.XITTER_TEST_ACTIVE_DIR = filePath;
    expect(anySuiteActive()).toBe(true);
  });

  it('ensureSuiteActivity marks liveness and endSuiteActivity clears it', () => {
    ensureSuiteActivity();
    const marker = join(root, String(process.pid));
    expect(existsSync(marker)).toBe(true);
    expect(anySuiteActive()).toBe(true);
    endSuiteActivity();
    expect(existsSync(marker)).toBe(false);
    expect(anySuiteActive()).toBe(false);
    // Re-arming works (next suite in the same process).
    ensureSuiteActivity();
    expect(anySuiteActive()).toBe(true);
  });

  it('heartbeats keep a marker fresh past the staleness window', async () => {
    // 15s heartbeat vs 60s staleness: age the marker 45s, then let one
    // heartbeat tick fire and confirm the mtime was bumped (a killed run's
    // marker, by contrast, goes stale and is removed by anySuiteActive).
    vi.useFakeTimers();
    try {
      ensureSuiteActivity();
      const marker = join(root, String(process.pid));
      const aged = new Date(Date.now() - 45_000);
      utimesSync(marker, aged, aged);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(statSync(marker).mtimeMs).toBeGreaterThan(aged.getTime());
      expect(anySuiteActive()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('label constants', () => {
  it('fixture labels share the documented prefix', () => {
    expect(TEST_RESOURCE_LABEL_PREFIX).toBe('xitter.test.');
  });
});
