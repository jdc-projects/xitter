#!/usr/bin/env node
// fallow-ignore-file unused-file -- CronJob container entrypoint (image CMD), not imported
/**
 * CronJob container entry (`node dist/reset-job.js [--seed]`): the shared
 * reset flow (reset-flow.ts) with the in-cluster worker control - workers
 * are Knative Services, so quiesce/resume is a minScale patch (0 -> 1)
 * through the Kubernetes API using the job's ServiceAccount. No extra
 * client dependency: plain fetch against kubernetes.default.svc.
 *
 * Locally the same flow is `npm run reset:live` (reset-flow.ts CLI), where
 * worker control degrades to a liveness warning - see reset-flow.ts.
 */
import { readFile } from 'node:fs/promises';
import { runResetFlow, type ResetReport, type WorkerControl } from './reset-flow.js';

const KNATIVE_WORKERS = ['fanout', 'media-process', 'search-index'] as const;
const MIN_SCALE_ANNOTATION = 'autoscaling.knative.dev/minScale';
const QUIESCE_TIMEOUT_MS = 180_000;

interface K8sContext {
  server: string;
  token: string;
  ca: Buffer;
  namespace: string;
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
  };
}

function parseK8sResponse(res: Response, body: string, method: string, path: string): unknown {
  if (!res.ok) {
    throw new Error(`k8s ${method} ${path} -> ${res.status}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

async function k8sRequest(
  ctx: K8sContext,
  path: string,
  init: RequestInit & { ca?: Buffer } = {},
): Promise<unknown> {
  const res = await fetch(`${ctx.server}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      ...(init.headers ?? {}),
    },
  });
  return parseK8sResponse(res, await res.text(), init.method ?? 'GET', path);
}

function setMinScale(ctx: K8sContext, worker: string, value: '0' | '1'): Promise<unknown> {
  return k8sRequest(
    ctx,
    `/apis/serving.knative.dev/v1/namespaces/${ctx.namespace}/services/${worker}`,
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
      // New revisions join the reset consumer groups at the new epoch; no
      // need to block the reset on their readiness.
      log('reset: workers minScale back to 1 (revisions rolling)');
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
