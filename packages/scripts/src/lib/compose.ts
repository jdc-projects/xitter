import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findRepoRoot, loadRepoEnv, localPort, type PortName } from '@xitter/config';
import {
  DEFAULT_ORPHAN_AGE_MS,
  ENV_TEARDOWN_GRACE_MS,
  anySuiteActive,
  sweepOrphanedTestResources,
} from '@xitter/testing/sweep';
import { run, capture } from './exec.js';

const COMPOSE_FILE = join(findRepoRoot(), 'infra', 'docker', 'compose.yaml');
// Docker Desktop resolves host.docker.internal natively; on Linux the edge
// needs the host-gateway mapping, which Desktop's daemon rejects.
const LINUX_OVERRIDE = join(findRepoRoot(), 'infra', 'docker', 'compose.linux.yaml');

/** Ports compose interpolates and injects into the edge (traefik) container. */
const COMPOSE_PORTS: PortName[] = [
  'edge',
  'web',
  'cms',
  'admin',
  'social',
  'posts',
  'media',
  'feed',
  'search',
  'postgres',
  'kafka',
  'opensearch',
  'rustfs',
  'valkey',
  'keycloak',
];

/** Compose project name isolates every environment copy (containers, volumes, networks). */
export function composeProject(): string {
  return `xitter-${process.env.XITTER_ENV ?? 'local'}`;
}

function composeFiles(): string[] {
  return process.platform === 'linux' && existsSync(LINUX_OVERRIDE)
    ? [COMPOSE_FILE, LINUX_OVERRIDE]
    : [COMPOSE_FILE];
}

/**
 * Compose cannot compute default+XITTER_PORT_OFFSET itself, and .env-file vars
 * beat the passing environment, so a generated env file (listed last - later
 * files win) carries resolved explicit ports. This makes offset-only parallel
 * copies shift published ports AND the edge's upstream targets together.
 */
function resolvedEnvFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xitter-compose-'));
  const lines = COMPOSE_PORTS.map(
    (name) => `XITTER_${name.replace(/([A-Z])/g, '_$1').toUpperCase()}_PORT=${localPort(name)}`,
  );
  const file = join(dir, 'resolved.env');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Remove the generated env file + its temp dir on exit or interrupt. */
function cleanupResolvedEnv(file: string): void {
  rmSync(dirname(file), { recursive: true, force: true });
}

function composeArgs(): string[] {
  // --env-file order matters: repo .env first (non-port defaults), resolved
  // ports last (later files win), so offsets reach interpolation deterministically.
  const args = ['compose'];
  for (const file of composeFiles()) args.push('--file', file);
  const rootEnv = join(findRepoRoot(), '.env');
  if (existsSync(rootEnv)) args.push('--env-file', rootEnv);
  const resolved = resolvedEnvFile();
  args.push('--env-file', resolved);
  args.push('--project-name', composeProject());
  // Docker reads env files at command start; remove the temp dir on any exit
  // path (SIGINT doesn't fire 'exit' without an explicit handler).
  process.once('exit', () => cleanupResolvedEnv(resolved));
  process.once('SIGINT', () => {
    cleanupResolvedEnv(resolved);
    process.exit(130);
  });
  return args;
}

export async function up(detach = true): Promise<void> {
  loadRepoEnv();
  await run('docker', [...composeArgs(), 'up', '--wait', ...(detach ? ['--detach'] : [])]);
}

export async function down(volumes = false): Promise<void> {
  loadRepoEnv();
  await run('docker', [...composeArgs(), 'down', ...(volumes ? ['--volumes'] : [])]);
  await sweepOrphanedTestContainers();
}

/**
 * #47: interrupted test runs leak labelled testcontainers until some later
 * run sweeps them. deps:down is the natural "clean the environment" moment,
 * so sweep here too. Normally nothing of ours is running and a 60s grace
 * suffices; when a live suite is detected (fresh activity marker from
 * @xitter/testing) fall back to the conservative 30-minute gate rather than
 * skipping - cleanup still happens, just never mid-suite. Label-scoped:
 * compose resources and anything unlabelled are never touched.
 */
async function sweepOrphanedTestContainers(): Promise<void> {
  const suiteActive = anySuiteActive();
  const minAgeMs = suiteActive ? DEFAULT_ORPHAN_AGE_MS : ENV_TEARDOWN_GRACE_MS;
  try {
    const swept = await sweepOrphanedTestResources({ minAgeMs });
    const total = swept.containers + swept.networks + swept.volumes;
    if (total > 0) {
      console.log(
        `deps:down removed ${total} orphaned test resource(s) (${suiteActive ? 'conservative' : 'env-teardown'} age gate)`,
      );
    }
  } catch (err) {
    console.warn(
      `deps:down: test orphan sweep skipped (${err instanceof Error ? err.message : err})`,
    );
  }
}

export async function status(): Promise<void> {
  loadRepoEnv();
  await run('docker', [...composeArgs(), 'ps']);
}

export async function isRunning(): Promise<boolean> {
  loadRepoEnv();
  const out = await capture('docker', [
    ...composeArgs(),
    'ps',
    '--services',
    '--filter',
    'status=running',
  ]);
  return out.length > 0;
}
