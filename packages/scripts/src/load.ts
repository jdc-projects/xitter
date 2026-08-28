#!/usr/bin/env tsx
/**
 * Artillery load-suite runner: feed-flow.yml (API) then browser-flow.yml
 * (Playwright engine) against the local prod-like stack, or a deployed
 * environment when E2E_BASE_URL is set. Ports resolve through
 * @xitter/config so offset worktree stacks work; Artillery's own
 * `ensure` budgets exit non-zero on breach and this wrapper propagates
 * the exit code, so `npm run test:load` actually gates (#158).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadRepoEnv, localUrl } from '@xitter/config';

loadRepoEnv();

const edge = process.env.E2E_BASE_URL ?? localUrl('edge');
const keycloak = process.env.XITTER_KEYCLOAK_URL ?? localUrl('keycloak');
const suiteDir = join('tests', 'artillery');
const flows = ['feed-flow.yml', 'browser-flow.yml'] as const;

for (const flow of flows) {
  console.log(`\n=== load suite: ${flow} -> ${edge} ===`);
  const code = await new Promise<number>((resolve, reject) => {
    // E2E_BASE_URL is what the configs' bare `$processEnvironment` target
    // lookup reads; XITTER_KEYCLOAK_URL feeds the processors' token grants.
    const child = spawn(
      'npx',
      ['artillery', 'run', join(suiteDir, flow)],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_BASE_URL: edge,
          XITTER_KEYCLOAK_URL: keycloak,
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    console.error(`load suite: ${flow} failed (exit ${code}) - budgets breached or run errored`);
    process.exit(code);
  }
}

console.log('\nload suite: all flows within budgets');
