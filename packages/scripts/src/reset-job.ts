#!/usr/bin/env node
/**
 * Container entry of the xitter-reset image (`node dist/reset-job.js [...]`),
 * serving two Tofu-provisioned workloads:
 *
 *  - default (`[--seed]`, the nightly CronJob): the shared reset flow
 *    (reset-flow.ts). Workers pause THEMSELVES on the reset epoch held in
 *    Valkey (packages/events createResetEpochGate) - nothing is scaled, so
 *    this job needs no Kubernetes API access at all.
 *  - `--ensure-users` (the deploy-path Job): ONLY the flow's realm-init
 *    step (`initDemoRealm`) - guarantees the 10 demo users exist after any
 *    realm (re)creation without wiping data or touching workers (#67).
 *    Needs no Kubernetes API access either.
 *
 * Locally the same flow is `npm run reset:live` (reset-flow.ts CLI) against
 * the local stack's Valkey.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResetFlow, type ResetReport } from './reset-flow.js';

// ---------------------------------------------------------------------------
// CLI: modes, arg parsing, dispatch (unit-tested without a cluster)
// ---------------------------------------------------------------------------

export type ResetJobMode = 'reset' | 'ensure-users';

export interface ResetJobArgs {
  mode: ResetJobMode;
  seed: boolean;
}

/**
 * Strict on purpose: the same entrypoint serves the destructive full reset,
 * so a mistyped flag must fail fast instead of silently falling through to
 * it (e.g. `--ensure-user` wiping the environment on a deploy).
 */
export function parseResetJobArgs(argv: readonly string[]): ResetJobArgs {
  const unknown = argv.filter((arg) => arg !== '--seed' && arg !== '--ensure-users');
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument(s): ${unknown.join(', ')} - supported: --seed, --ensure-users`,
    );
  }
  const seed = argv.includes('--seed');
  if (seed && argv.includes('--ensure-users')) {
    throw new Error(
      '--seed applies to the full reset only - the ensure-users job never seeds content',
    );
  }
  return { mode: argv.includes('--ensure-users') ? 'ensure-users' : 'reset', seed };
}

/** Environment-dependent halves of the entrypoint, injectable for tests. */
export interface ResetJobDeps {
  /** The reset flow's realm-init step (shared with `reset:live`). */
  ensureUsers(): Promise<Array<{ username: string }>>;
  resetFlow(options: { seed: boolean }): Promise<ResetReport>;
}

/** Runs one mode and returns the success summary line. */
export async function runResetJob(args: ResetJobArgs, deps: ResetJobDeps): Promise<string> {
  if (args.mode === 'ensure-users') {
    const users = await deps.ensureUsers();
    const first = users.at(0)?.username ?? '-';
    const last = users.at(-1)?.username ?? '-';
    return `ensure-users: ${users.length} demo user(s) present (${first}..${last})`;
  }
  const report = await deps.resetFlow({ seed: args.seed });
  return (
    `reset-job: success in ${report.durationMs}ms ` +
    `(reseeded=${report.reseeded}, fingerprint=${report.fingerprint ?? '-'})`
  );
}

function defaultDeps(): ResetJobDeps {
  return {
    async ensureUsers() {
      const { defaultRealmControl } = await import('./reset-flow.js');
      return defaultRealmControl().init();
    },
    async resetFlow(options) {
      return runResetFlow(options);
    },
  };
}

// Only dispatch when run as the entry file (the image CMD): tests import
// this module and must not trigger either mode.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await runResetJob(parseResetJobArgs(process.argv.slice(2)), defaultDeps()));
  } catch (err) {
    console.error(`reset-job: FAILED - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
