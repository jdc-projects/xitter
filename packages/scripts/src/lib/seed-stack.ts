/**
 * Seed once the app stack is reachable: `npm run reset:reseed` (and the
 * e2e stack wrapper) need the corpus applied only after services (and, for
 * derived stores, the workers) are back from a dependency teardown. Waits
 * politely; never starts anything itself.
 */
import { localPort } from '@xitter/config';
import { checkPort } from './port.js';

const SERVICE_PORTS = ['social', 'posts', 'media', 'feed', 'search'].map((name) =>
  localPort(name as 'social'),
);
const WORKER_PORTS = [
  localPort('fanoutMetrics'),
  localPort('mediaProcessMetrics'),
  localPort('searchIndexMetrics'),
];

/** True when every xitter app port answers (services + workers). */
async function stackReady(): Promise<boolean> {
  const checks = [...SERVICE_PORTS, ...WORKER_PORTS].map((port) => checkPort(port));
  return (await Promise.all(checks)).every(Boolean);
}

async function waitForStack(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await stackReady())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return true;
}

/**
 * Seed after waiting for the stack. Returns the seed report, or null when
 * the stack did not come up (caller decides whether that is fatal).
 */
export async function seedWhenStackReady(
  timeoutMs = 240_000,
): Promise<{ fingerprint: string; skipped: boolean } | null> {
  if (!(await waitForStack(timeoutMs))) {
    console.log(
      'seed: no app stack detected - start one (npm run dev / npm run start) and run npm run seed',
    );
    return null;
  }
  const { runSeed } = await import('../seed.js');
  const report = await runSeed();
  console.log(
    report.skipped
      ? 'seed: corpus already present (verified)'
      : `seed: applied corpus ${report.fingerprint.slice(0, 12)}`,
  );
  return { fingerprint: report.fingerprint, skipped: report.skipped };
}
