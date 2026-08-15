/**
 * Port-driven CMS launcher: `tsx scripts/serve.ts dev|start`.
 */
import { spawn } from 'node:child_process';
import { localPort, loadRepoEnv } from '@xitter/config';

loadRepoEnv();
const mode = process.argv[2] ?? 'dev';
const port = String(localPort('cms'));

const child = spawn('next', [mode === 'start' ? 'start' : 'dev', '--port', port], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

child.on('exit', (code) => process.exit(code ?? 0));
