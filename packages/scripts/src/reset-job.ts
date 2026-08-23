#!/usr/bin/env node
// fallow-ignore-file unused-file -- CronJob container entrypoint (image CMD), not imported
/**
 * CronJob container entry (`node dist/reset-job.js [--seed]`): the shared
 * reset flow (reset-flow.ts) with the in-cluster worker control - workers
 * are Knative Services, so quiesce/resume is a minScale patch (0 -> 1)
 * through the Kubernetes API using the job's ServiceAccount (undici
 * dispatcher with the serviceaccount CA - see inClusterContext).
 *
 * Locally the same flow is `npm run reset:live` (reset-flow.ts CLI), where
 * worker control degrades to a liveness warning - see reset-flow.ts.
 */
import { readFile } from 'node:fs/promises';
import { Agent, type Dispatcher } from 'undici';
import { runResetFlow, type ResetReport, type WorkerControl } from './reset-flow.js';

const KNATIVE_WORKERS = ['fanout', 'media-process', 'search-index'] as const;
const MIN_SCALE_ANNOTATION = 'autoscaling.knative.dev/minScale';
// Knative scale-to-zero includes its stability window plus consumer drain;
// 180s proved too tight on dev (pods reached zero AFTER the job had already
// aborted). Overridable for slow clusters.
const QUIESCE_TIMEOUT_MS = Number(process.env.XITTER_RESET_QUIESCE_TIMEOUT_MS ?? 600_000);
// Cold-start (revision rollout + container start) is faster than drain but
// still tens of seconds on this cluster.
const RESUME_TIMEOUT_MS = Number(process.env.XITTER_RESET_RESUME_TIMEOUT_MS ?? 300_000);

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
 * Resume's mirror of waitForScaleToZero: after minScale is back to 1 the
 * worker pods still need seconds-to-a-minute to cold-start (Knative
 * revision rollout). The seed step that follows polls media processing
 * with a ~90s budget - starting that budget while media-process is still
 * scheduling burns it before the first image is ever processed (observed:
 * 'media <id> never became ready' 96s after resume returned 'revisions
 * rolling'). Fail loudly if a worker never comes up.
 */
async function waitForWorkerReadiness(
  ctx: K8sContext,
  log: (message: string) => void,
): Promise<void> {
  const deadline = Date.now() + RESUME_TIMEOUT_MS;
  for (;;) {
    const missing = (
      await Promise.all(
        KNATIVE_WORKERS.map(async (w) => [w, await runningWorkerPods(ctx, w)] as const),
      )
    )
      .filter(([, count]) => count === 0)
      .map(([w]) => w);
    if (missing.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `workers did not resume within ${RESUME_TIMEOUT_MS / 1000}s (${missing.join(', ')} have no pods) - seed would run cold`,
      );
    }
    log(`reset: waiting for ${missing.join(', ')} pod(s) to start...`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
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

async function k8sWorkerControl(log: (message: string) => void): Promise<WorkerControl> {
  const ctx = (await inClusterContext())!;
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
      // New revisions join the reset consumer groups at the new epoch - but
      // the seed step needs media-process actually RUNNING before it starts
      // polling (its ~90s media-readiness budget cannot absorb a cold start).
      await waitForWorkerReadiness(ctx, log);
      log('reset: workers minScale back to 1 (pods running)');
    },
  };
}

const ctx = await inClusterContext();
const workers = ctx ? await k8sWorkerControl(console.log) : undefined;
if (!ctx) {
  console.error('reset-job: not running in a Kubernetes pod (no KUBERNETES_SERVICE_HOST)');
  process.exit(1);
}

try {
  const report: ResetReport = await runResetFlow({
    seed: process.argv.includes('--seed'),
    workers,
  });
  console.log(
    `reset-job: success in ${report.durationMs}ms ` +
      `(reseeded=${report.reseeded}, fingerprint=${report.fingerprint ?? '-'})`,
  );
} catch (err) {
  console.error(`reset-job: FAILED - ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
