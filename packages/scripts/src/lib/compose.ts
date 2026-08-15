import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, loadRepoEnv } from '@xitter/config';
import { run, capture } from './exec.js';

const COMPOSE_FILE = join(findRepoRoot(), 'infra', 'docker', 'compose.yaml');

/** Compose project name isolates every environment copy (containers, volumes, networks). */
export function composeProject(): string {
  return `xitter-${process.env.XITTER_ENV ?? 'local'}`;
}

function composeArgs(): string[] {
  // --env-file: compose's default .env lookup is the compose file's directory
  // (infra/docker), so point it at the repo root explicitly when present - port
  // overrides and XITTER_ENV isolation must reach interpolation. Compose's own
  // defaults cover a missing file.
  const args = ['compose', '--file', COMPOSE_FILE];
  const rootEnv = join(findRepoRoot(), '.env');
  if (existsSync(rootEnv)) args.push('--env-file', rootEnv);
  args.push('--project-name', composeProject());
  return args;
}

export async function up(detach = true): Promise<void> {
  loadRepoEnv();
  await run('docker', [...composeArgs(), 'up', '--wait', ...(detach ? ['--detach'] : [])]);
}

export async function down(volumes = false): Promise<void> {
  loadRepoEnv();
  await run('docker', [...composeArgs(), 'down', ...(volumes ? ['--volumes'] : [])]);
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
