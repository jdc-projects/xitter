/**
 * Port-driven admin panel launcher: `tsx scripts/serve.ts dev|preview`.
 */
import { spawn } from 'node:child_process';
import { localPort, loadRepoEnv } from '@xitter/config';

loadRepoEnv();
const mode = process.argv[2] ?? 'dev';
const port = String(localPort('admin'));

// --host: vite binds localhost (::1) only by default, which the edge proxy
// (host.docker.internal) cannot reach - the panel must be fronted by it.
const args = ['--host', '--port', port, '--strictPort'];
if (mode !== 'dev') args.unshift('preview');

// Invoked via npm scripts, so node_modules/.bin is already on PATH.
const child = spawn('vite', args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
