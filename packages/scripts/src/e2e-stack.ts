#!/usr/bin/env tsx
/**
 * Playwright e2e webServer command: `npm run start` + deterministic seed.
 *
 * The suite assumes a seeded, lived-in environment (spec testing 02), so the
 * stack wrapper starts the built apps like the default webServer does, waits
 * for services AND workers (media processing + fanout must be live before
 * the corpus lands), applies the seed (idempotent - an already-seeded stack
 * verifies and skips), then idles until Playwright terminates it.
 *
 * Readiness is signalled on the stackProbe port ONLY after the seed step
 * resolves. Gating on the web port instead lets Playwright start tests
 * while the seed still waits for the workers; test logins then bootstrap
 * stub profiles that trip the seeder's partial-corpus guard (observed:
 * "environment holds a partial corpus" on a freshly wiped stack).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { localPort } from '@xitter/config';
import { seedWhenStackReady } from './lib/seed-stack.js';

const WEB_PORT = localPort('web');

const stack = spawn('npm', ['run', 'start'], {
  stdio: 'inherit',
  env: { ...process.env },
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // turbo forwards signals to its children; give them a graceful beat.
  stack.kill('SIGTERM');
  setTimeout(() => {
    stack.kill('SIGKILL');
    process.exit(0);
  }, 10_000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
stack.once('exit', (code) => {
  if (!shuttingDown) process.exit(code ?? 0);
});

// Playwright probes the stackProbe port; hold off on seeding until the whole
// stack (services + workers) is answering, and hold the port closed until
// the corpus has landed (or was verified) so no test can beat the seed.
// A seed failure is fatal and loud: exit non-zero so Playwright fails fast
// instead of idling to its 300s probe timeout.
const seeded = (async () => {
  const webUp = await waitForWeb(300_000);
  if (!webUp) return;
  try {
    await seedWhenStackReady(300_000);
  } catch (err) {
    console.error('e2e stack: seed failed - see error above; refusing to signal ready');
    shutdown();
    process.exitCode = 1;
    throw err;
  }
})();

async function waitForWeb(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await stackReadyWeb())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return true;
}

async function stackReadyWeb(): Promise<boolean> {
  const { checkPort } = await import('./lib/port.js');
  return checkPort(WEB_PORT);
}

await seeded;

// Seed resolved - now (and only now) tell Playwright the suite may start.
const probe = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('e2e stack: seeded\n');
});
probe.once('error', (err) => {
  console.error(`e2e stack: stackProbe port unavailable: ${err}`);
  process.exit(1);
});
probe.listen(localPort('stackProbe'), 'localhost', () => {
  console.log('e2e stack: ready (seeded) - idling until Playwright stops us');
});

// Keep the process alive; the child owns stdio.
setInterval(() => {
  if (!shuttingDown && stack.exitCode !== null) process.exit(stack.exitCode ?? 0);
}, 1_000);
