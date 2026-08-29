import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findRepoRoot, loadRepoEnv, localPort, type PortName } from '@xitter/config';
import {
  anySuiteActive,
  environmentTeardownSweepOptions,
  sweepOrphanedTestResources,
  type SweepResult,
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
  await sweepStaleSiblingStacks();
  await run('docker', [...composeArgs(), 'up', '--wait', ...(detach ? ['--detach'] : [])]);
}

export async function down(volumes = false): Promise<void> {
  loadRepoEnv();
  await run('docker', [...composeArgs(), 'down', ...(volumes ? ['--volumes'] : [])]);
  await sweepOrphanedTestContainers();
}

/**
 * #175: parallel worker stacks crashed the host once already - a killed
 * session's compose project keeps its containers (no teardown ran) and the
 * next boot adds a full stack on top. deps:up self-heals: any OTHER
 * xitter-* project whose containers run but whose edge port is dead is
 * abandoned, and is removed (volumes included) before this one boots.
 * Best-effort - a sweep failure never blocks the boot.
 */
async function sweepStaleSiblingStacks(): Promise<void> {
  const { partitionStacks, downProject } = await import('./stack-sweep.js');
  try {
    const { stale } = await partitionStacks(composeProject());
    for (const project of stale) {
      console.log(
        `deps:up: removing stale stack ${project.name} (containers running past the grace window, edge serves only Bad Gateway - a killed session left it behind)`,
      );
      await downProject(project.name, COMPOSE_FILE).catch((err: unknown) =>
        console.warn(
          `deps:up: could not remove ${project.name} (${err instanceof Error ? err.message : err})`,
        ),
      );
    }
  } catch (err) {
    console.warn(
      `deps:up: stale-stack sweep skipped (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * #47: interrupted test runs leak labelled testcontainers until some later
 * run sweeps them. deps:down is the natural "clean the environment" moment,
 * so sweep here too (policy + rationale in @xitter/testing sweep.ts:
 * environmentTeardownSweepOptions). Label-scoped throughout - compose
 * resources and anything unlabelled are never touched.
 */
async function sweepOrphanedTestContainers(): Promise<void> {
  try {
    const swept = await sweepOrphanedTestResources(
      environmentTeardownSweepOptions(anySuiteActive()),
    );
    logSweptResources(swept);
  } catch (err) {
    console.warn(
      `deps:down: test orphan sweep skipped (${err instanceof Error ? err.message : err})`,
    );
  }
}

function logSweptResources(swept: SweepResult): void {
  const total = swept.containers + swept.networks + swept.volumes;
  if (total > 0) {
    console.log(`deps:down removed ${total} orphaned test resource(s)`);
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
