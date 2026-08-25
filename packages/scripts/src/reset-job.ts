#!/usr/bin/env node
/**
 * Container entry of the xitter-reset image (`node dist/reset-job.js [...]`),
 * serving two Tofu-provisioned workloads:
 *
 *  - default (`[--seed]`, the nightly CronJob): the shared reset flow
 *    (reset-flow.ts) plus the in-cluster HPA stabilization (#98): the
 *    flow suspends the five API-service HPAs and pins their Deployments
 *    at 2 ready replicas for the wipe+seed window (the seed's burst used
 *    to trip the HPAs mid-run; the joining pod served 503s), restoring
 *    them after the seed. Workers still pause THEMSELVES on the Valkey
 *    epoch (ADR 0010) - the only Kubernetes API use is HPA/deployment
 *    scaling, scoped by the reset Role (reset.tf).
 *  - `--ensure-users` (the deploy-path Job): ONLY the flow's realm-init
 *    step (`initDemoRealm`) - guarantees the 10 demo users exist after any
 *    realm (re)creation without wiping data or touching workers (#67).
 *    Needs no Kubernetes API access.
 *
 * Locally the same flow is `npm run reset:live` (reset-flow.ts CLI):
 * KUBERNETES_SERVICE_HOST is absent, so HPA stabilization degrades to a
 * warned skip - there are no HPAs on the local stack.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, type Dispatcher } from 'undici';
import { envInt } from '@xitter/config';
import {
  API_SERVICES,
  runResetFlow,
  type ResetReport,
  type ServiceControls,
} from './reset-flow.js';

// ---------------------------------------------------------------------------
// Kubernetes client (HPA/deployment scaling ONLY - #98). This is NOT the
// #81-era worker quiesce: workers still pause themselves on the epoch
// (ADR 0010); nothing here touches Knative services, minScale or worker
// pods. Kept thin and typed on purpose - there is no cluster in CI, so
// this half is exercised only by the nightly job itself.
// ---------------------------------------------------------------------------

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
  const [token, podNamespace] = await Promise.all([
    readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
    readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8'),
  ]);
  const ca = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  return {
    server: `https://${host}:${port}`,
    token: token.trim(),
    ca,
    // Tofu sets XITTER_RESET_NAMESPACE on the CronJob; the mounted
    // namespace file is the fallback (identical value in practice).
    namespace: (process.env.XITTER_RESET_NAMESPACE ?? podNamespace).trim(),
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

/**
 * HPA suspend toggle (autoscaling/v2). `false` patches the field to null -
 * a JSON merge-patch REMOVES it, converging the object on Tofu's desired
 * state (the module does not manage `suspend`), so no drift survives the
 * night.
 */
function setHpaSuspend(ctx: K8sContext, service: string, suspend: boolean): Promise<unknown> {
  return k8sRequest(
    ctx,
    // fieldManager names this job as the patcher in the object's
    // managedFields (a bare merge-patch registers as "node" - the fetch
    // user-agent - which reads like a system actor in audits).
    `/apis/autoscaling/v2/namespaces/${ctx.namespace}/horizontalpodautoscalers/${service}?fieldManager=xitter-reset`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { suspend: suspend ? true : null } }),
    },
  );
}

function scaleDeployment(ctx: K8sContext, service: string, replicas: number): Promise<unknown> {
  return k8sRequest(
    ctx,
    // The scale subresource, not the Deployment itself: the Role grants
    // patch on deployments/scale only, so the job can move replica counts
    // but never touch pod templates or anything else a Deployment owns.
    `/apis/apps/v1/namespaces/${ctx.namespace}/deployments/${service}/scale?fieldManager=xitter-reset`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { replicas } }),
    },
  );
}

async function readyReplicas(ctx: K8sContext, service: string): Promise<number> {
  const deployment = (await k8sRequest(
    ctx,
    `/apis/apps/v1/namespaces/${ctx.namespace}/deployments/${service}`,
  )) as { status?: { readyReplicas?: number } };
  return deployment.status?.readyReplicas ?? 0;
}

/**
 * Fail-loud readiness wait (#98): "two ready pods" must mean
 * status.readyReplicas, never pods that merely exist - the whole point of
 * the stabilization is that the seed must not race a joining pod's boot.
 */
async function waitForReadyReplicas(
  ctx: K8sContext,
  service: string,
  want: number,
  exactly: boolean,
  log: (message: string) => void,
): Promise<void> {
  const timeoutMs = envInt('XITTER_RESET_SCALE_TIMEOUT_MS', 300_000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await readyReplicas(ctx, service);
    if (exactly ? ready === want : ready >= want) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${service} did not report ${exactly ? 'exactly' : 'at least'} ${want} ready replicas ` +
          `within ${Math.round(timeoutMs / 1000)}s (${ready} ready) - aborting the reset`,
      );
    }
    log(`reset: ${service} at ${ready} ready replicas, waiting for ${want}...`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** The ServiceControls the CronJob injects (see reset-flow.ts, #98). */
function k8sServiceControls(
  ctx: K8sContext,
  log: (message: string) => void,
): ServiceControls {
  return {
    async stabilize() {
      // Suspend every HPA BEFORE touching replicas: an active HPA fights
      // a manual scale patch; a suspended one holds the scale frozen.
      for (const service of API_SERVICES) {
        await setHpaSuspend(ctx, service, true);
      }
      // Pin 2 replicas - the churn-proof count: the burst is absorbed by a
      // second pod that is ALREADY ready, and the join (image pull,
      // prisma-migrate init, Nest boot) happens here, up front, instead of
      // mid-seed.
      await Promise.all(API_SERVICES.map((service) => scaleDeployment(ctx, service, 2)));
      await Promise.all(
        API_SERVICES.map((service) => waitForReadyReplicas(ctx, service, 2, false, log)),
      );
      return [...API_SERVICES];
    },
    async restore() {
      // Scale down while STILL suspended so the floor is already 1 at the
      // moment the HPA wakes; unsuspending first would let it re-recommend
      // 2 from stale seed-burst metrics and fight the patch.
      await Promise.all(API_SERVICES.map((service) => scaleDeployment(ctx, service, 1)));
      await Promise.all(
        API_SERVICES.map((service) => waitForReadyReplicas(ctx, service, 1, true, log)),
      );
      for (const service of API_SERVICES) {
        await setHpaSuspend(ctx, service, false);
      }
      return [...API_SERVICES];
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
  /**
   * HPA stabilization for the full reset (#98): the Kubernetes-backed
   * control in-cluster, the flow's inert no-op outside it.
   */
  serviceControls(): Promise<ServiceControls>;
  resetFlow(options: { seed: boolean; services: ServiceControls }): Promise<ResetReport>;
}

/** Runs one mode and returns the success summary line. */
export async function runResetJob(args: ResetJobArgs, deps: ResetJobDeps): Promise<string> {
  if (args.mode === 'ensure-users') {
    const users = await deps.ensureUsers();
    const first = users.at(0)?.username ?? '-';
    const last = users.at(-1)?.username ?? '-';
    return `ensure-users: ${users.length} demo user(s) present (${first}..${last})`;
  }
  const services = await deps.serviceControls();
  const report = await deps.resetFlow({ seed: args.seed, services });
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
    async serviceControls() {
      const ctx = await inClusterContext();
      if (ctx) return k8sServiceControls(ctx, console.log);
      console.warn(
        'reset-job: KUBERNETES_SERVICE_HOST unset - running without HPA stabilization (expected on the local stack)',
      );
      const { inertServiceControls } = await import('./reset-flow.js');
      return inertServiceControls(console.log);
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
