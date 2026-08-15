/**
 * Port-driven Next.js launcher: `tsx scripts/serve.ts dev|start`.
 * Reads XITTER_WEB_PORT (with offset applied) from the shared config so every
 * copy of this environment runs on its own port.
 */
import { spawn } from 'node:child_process';
import { localPort, loadRepoEnv } from '@xitter/config';

loadRepoEnv();
const mode = process.argv[2] ?? 'dev';
const port = String(localPort('web'));

const child = spawn('next', [mode === 'start' ? 'start' : 'dev', '--port', port], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

child.on('exit', (code) => process.exit(code ?? 0));
