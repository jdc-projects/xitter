#!/usr/bin/env node
/**
 * Container entry of the xitter-reset image (`node dist/reset-job.js [...]`),
 * serving two Tofu-provisioned workloads:
 *
 *  - default (`[--seed]`, the nightly CronJob): the shared reset flow
 *    (reset-flow.ts) with the in-cluster worker control - workers are
 *    Knative Services, so quiesce/resume is a minScale patch (0 -> 1)
 *    through the Kubernetes API using the job's ServiceAccount (undici
 *    dispatcher with the serviceaccount CA - see inClusterContext).
 *  - `--ensure-users` (the deploy-path Job): ONLY the flow's realm-init
 *    step (`initDemoRealm`) - guarantees the 10 demo users exist after any
 *    realm (re)creation without wiping data or touching workers (#67).
 *    Needs no Kubernetes API access.
 *
 * Locally the same flow is `npm run reset:live` (reset-flow.ts CLI), where
 * worker control degrades to a liveness warning - see reset-flow.ts.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, type Dispatcher } from 'undici';
import { runResetFlow, type ResetReport, type WorkerControl } from './reset-flow.js';

const KNATIVE_WORKERS = ['fanout', 'media-process', 'search-index'] as const;
const MIN_SCALE_ANNOTATION = 'autoscaling.knative.dev/minScale';
// Knative scale-to-zero includes its stability window plus consumer drain;
// 180s proved too tight on dev (pods reached zero AFTER the job had already
// aborted). Overridable for slow clusters.
const QUIESCE_TIMEOUT_MS = Number(process.env.XITTER_RESET_QUIESCE_TIMEOUT_MS ?? 600_000);

interface K8sContext {
  server: string;
  token: string;
  ca: Buffer;
  namespace: string;
  dispatcher: Dispatcher;
}

async function inClusterContext(): Promise<K8sContext | null> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) return null;
  const [token, namespace] = await Promise.all([
    readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
    readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8'),
  ]);
  const ca = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  return {
    server: `https://${host}:${port}`,
    token: token.trim(),
    ca,
    namespace: namespace.trim(),
    // The API server's certificate chains to the cluster CA; global fetch
    // (undici) does not read the serviceaccount CA, so every request fails
    // TLS verification ("fetch failed"). The dispatcher is the only way to
    // give undici a custom CA.
    dispatcher: new Agent({ connect: { ca } }),
  };
}

function parseK8sResponse(res: Response, body: string, method: string, path: string): unknown {
  if (!res.ok) {
    throw new Error(`k8s ${method} ${path} -> ${res.status}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

async function k8sRequest(ctx: K8sContext, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${ctx.server}${path}`, {
    ...init,
    // Node's global fetch is undici's and honours a per-request dispatcher
    // (the DOM RequestInit type just doesn't know about it).
    dispatcher: ctx.dispatcher,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      ...(init.headers ?? {}),
    },
  } as RequestInit);
  return parseK8sResponse(res, await res.text(), init.method ?? 'GET', path);
}

function setMinScale(ctx: K8sContext, worker: string, value: '0' | '1'): Promise<unknown> {
  return k8sRequest(
    ctx,
    // fieldManager names this job as the patcher in the object's
    // managedFields (a bare merge-patch registers as "node" - the fetch
    // user-agent - which reads like a system actor in audits).
    `/apis/serving.knative.dev/v1/namespaces/${ctx.namespace}/services/${worker}?fieldManager=xitter-reset`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({
        spec: { template: { metadata: { annotations: { [MIN_SCALE_ANNOTATION]: value } } } },
      }),
    },
  );
}

async function runningWorkerPods(ctx: K8sContext, worker: string): Promise<number> {
  const selector = `app.kubernetes.io/name=${worker},app.kubernetes.io/instance=${
    process.env.XITTER_ENV ?? 'dev'
  }`;
  const list = (await k8sRequest(
    ctx,
    `/api/v1/namespaces/${ctx.namespace}/pods?labelSelector=${encodeURIComponent(selector)}`,
  )) as { items?: Array<{ status?: { phase?: string } }> };
  return (list.items ?? []).filter(
    (pod) => pod.status?.phase === 'Running' || pod.status?.phase === 'Pending',
  ).length;
}

async function totalWorkerPods(ctx: K8sContext): Promise<number> {
  const counts = await Promise.all(KNATIVE_WORKERS.map((w) => runningWorkerPods(ctx, w)));
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Fail loudly if pods linger: wiping stores under a live worker risks
 * half-processed events - the timeout aborts before any store is wiped.
 */
async function waitForScaleToZero(ctx: K8sContext, log: (message: string) => void): Promise<void> {
  const deadline = Date.now() + QUIESCE_TIMEOUT_MS;
  for (;;) {
    const total = await totalWorkerPods(ctx);
    if (total === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `workers did not scale to zero within ${QUIESCE_TIMEOUT_MS / 1000}s (${total} pods left) - aborting before any store is wiped`,
      );
    }
    log(`reset: waiting for ${total} worker pod(s) to exit...`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function k8sWorkerControl(
  ctx: K8sContext,
  log: (message: string) => void,
): Promise<WorkerControl> {
  return {
    async quiesce() {
      for (const worker of KNATIVE_WORKERS) {
        await setMinScale(ctx, worker, '0');
      }
      await waitForScaleToZero(ctx, log);
    },
    async resume() {
      for (const worker of KNATIVE_WORKERS) {
        await setMinScale(ctx, worker, '1');
      }
      // New revisions join the reset consumer groups at the new epoch; no
      // need to block the reset on their readiness.
      log('reset: workers minScale back to 1 (revisions rolling)');
    },
  };
}

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
  /** In-cluster worker control; unavailable outside a Kubernetes pod. */
  workerControl(): Promise<WorkerControl>;
  resetFlow(options: { seed: boolean; workers: WorkerControl }): Promise<ResetReport>;
}

/** Runs one mode and returns the success summary line. */
export async function runResetJob(args: ResetJobArgs, deps: ResetJobDeps): Promise<string> {
  if (args.mode === 'ensure-users') {
    const users = await deps.ensureUsers();
    const first = users.at(0)?.username ?? '-';
    const last = users.at(-1)?.username ?? '-';
    return `ensure-users: ${users.length} demo user(s) present (${first}..${last})`;
  }
  const workers = await deps.workerControl();
  const report = await deps.resetFlow({ seed: args.seed, workers });
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
    async workerControl() {
      const ctx = await inClusterContext();
      if (!ctx) {
        throw new Error('full reset requires a Kubernetes pod (no KUBERNETES_SERVICE_HOST)');
      }
      return k8sWorkerControl(ctx, console.log);
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
