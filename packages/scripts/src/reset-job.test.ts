import { describe, expect, it } from 'vitest';
import type { ResetReport, ServiceControls } from './reset-flow.js';
import { parseResetJobArgs, runResetJob, type ResetJobDeps } from './reset-job.js';

/**
 * The container entry dispatches ONE image over two workloads with very
 * different blast radii: the nightly full reset (wipes every store) and the
 * deploy-path ensure-users job (idempotent realm upsert). These contracts
 * pin the split: exact flag parsing (a typo must never fall through to the
 * full reset), per-mode delegation, and that the Kubernetes-backed HPA
 * stabilization (#98) is wired into the reset mode ONLY - all without a
 * cluster.
 */

const fakeServices: ServiceControls = {
  async stabilize() {
    return ['social', 'posts', 'media', 'feed', 'search'];
  },
  async restore() {
    return ['social', 'posts', 'media', 'feed', 'search'];
  },
};

function fakeReport(): ResetReport {
  return {
    job: 'xitter-reset-test',
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    durationMs: 1000,
    success: true,
    reseeded: false,
    fingerprint: null,
    steps: [],
    metrics: [],
  };
}

interface Harness extends ResetJobDeps {
  calls: string[];
  seedFlagSeen: boolean[];
  servicesSeen: ServiceControls[];
}

function harness(overrides: Partial<ResetJobDeps> = {}): Harness {
  const calls: string[] = [];
  const seedFlagSeen: boolean[] = [];
  const servicesSeen: ServiceControls[] = [];
  const h: Harness = {
    calls,
    seedFlagSeen,
    servicesSeen,
    async ensureUsers() {
      calls.push('ensure-users');
      return [{ username: 'demo1' }, { username: 'demo2' }];
    },
    async serviceControls() {
      calls.push('service-controls');
      return fakeServices;
    },
    async resetFlow(options) {
      calls.push('reset-flow');
      seedFlagSeen.push(options.seed);
      servicesSeen.push(options.services);
      return fakeReport();
    },
  };
  return { ...h, ...overrides };
}

describe('parseResetJobArgs', () => {
  it('defaults to the full reset without seeding', () => {
    expect(parseResetJobArgs([])).toEqual({ mode: 'reset', seed: false });
  });

  it('maps --seed onto the reset mode', () => {
    expect(parseResetJobArgs(['--seed'])).toEqual({ mode: 'reset', seed: true });
  });

  it('maps --ensure-users onto its own mode', () => {
    expect(parseResetJobArgs(['--ensure-users'])).toEqual({ mode: 'ensure-users', seed: false });
  });

  it('rejects unknown flags (never fall through to the destructive reset)', () => {
    expect(() => parseResetJobArgs(['--ensure-user'])).toThrow(/unknown argument/);
    expect(() => parseResetJobArgs(['--force'])).toThrow(/unknown argument/);
  });

  it('rejects --seed combined with --ensure-users', () => {
    expect(() => parseResetJobArgs(['--ensure-users', '--seed'])).toThrow(/--seed/);
  });
});

describe('runResetJob', () => {
  it('ensure-users delegates to the realm-init step only - no cluster, no reset flow', async () => {
    const h = harness();
    const summary = await runResetJob({ mode: 'ensure-users', seed: false }, h);

    expect(h.calls).toEqual(['ensure-users']);
    expect(summary).toContain('2 demo user(s)');
    expect(summary).toContain('demo1..demo2');
  });

  it('reset mode resolves the service controls, injects them into the flow and forwards the seed flag', async () => {
    const h = harness();
    const summary = await runResetJob({ mode: 'reset', seed: true }, h);

    expect(h.calls).toEqual(['service-controls', 'reset-flow']);
    expect(h.seedFlagSeen).toEqual([true]);
    expect(h.servicesSeen).toEqual([fakeServices]);
    expect(summary).toMatch(/^reset-job: success in \d+ms/);
  });

  it('propagates service-control failures as the job failure (fail loud, no silent skip)', async () => {
    const h = harness({
      async serviceControls() {
        h.calls.push('service-controls');
        throw new Error('k8s horizontalpodautoscalers -> 403');
      },
    });
    await expect(runResetJob({ mode: 'reset', seed: false }, h)).rejects.toThrow(/403/);
    // The failure is the job's own: the reset flow never started.
    expect(h.calls).toEqual(['service-controls']);
  });

  it('propagates reset-flow failures as the job failure', async () => {
    const h = harness({
      async resetFlow() {
        throw new Error('workers did not acknowledge reset epoch');
      },
    });
    await expect(runResetJob({ mode: 'reset', seed: false }, h)).rejects.toThrow(
      /acknowledge reset epoch/,
    );
  });

  it('ensure-users mode never touches the reset flow even if reset deps are wired', async () => {
    const h = harness({
      async ensureUsers() {
        h.calls.push('ensure-users');
        return [{ username: 'demo1' }];
      },
    });
    await runResetJob({ mode: 'ensure-users', seed: false }, h);
    expect(h.calls).toEqual(['ensure-users']);
  });
});
