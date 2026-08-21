#!/usr/bin/env tsx
/**
 * Playwright e2e webServer command: `npm run start` + deterministic seed.
 *
 * The suite assumes a seeded, lived-in environment (spec testing 02), so the
 * stack wrapper starts the built apps like the default webServer does, waits
 * for services AND workers (media processing + fanout must be live before
 * the corpus lands), applies the seed (idempotent - an already-seeded stack
 * verifies and skips), then idles until Playwright terminates it.
 */
import { spawn } from 'node:child_process';
import { localPort } from '@xitter/config';
import { seedWhenStackReady, stackReady } from './lib/seed-stack.js';

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

// Playwright probes the web port; hold off on seeding until the whole
// stack (services + workers) is answering.
const seeded = (async () => {
  const webUp = await waitForWeb(300_000);
  if (!webUp) return;
  await seedWhenStackReady(300_000);
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
console.log('e2e stack: ready (seeded when possible) - idling until Playwright stops us');

// Keep the process alive; the child owns stdio.
setInterval(() => {
  if (!shuttingDown && stack.exitCode !== null) process.exit(stack.exitCode ?? 0);
}, 1_000);
