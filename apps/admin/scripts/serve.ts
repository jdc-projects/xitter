/**
 * Port-driven admin panel launcher: `tsx scripts/serve.ts dev|preview`.
 */
import { spawn } from 'node:child_process';
import { localPort, loadRepoEnv } from '@xitter/config';

loadRepoEnv();
const mode = process.argv[2] ?? 'dev';
const port = String(localPort('admin'));

const args =
  mode === 'dev' ? ['--port', port, '--strictPort'] : ['preview', '--port', port, '--strictPort'];

// Invoked via npm scripts, so node_modules/.bin is already on PATH.
const child = spawn('vite', args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
