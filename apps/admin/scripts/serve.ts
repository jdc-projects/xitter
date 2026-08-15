/**
 * Port-driven admin panel launcher: `tsx scripts/serve.ts dev|preview`.
 */
import { spawn } from 'node:child_process';
import { localPort, loadRepoEnv } from '@xitter/config';

loadRepoEnv();
const mode = process.argv[2] ?? 'dev';
const port = String(localPort('admin'));

const args =
  mode === 'dev'
    ? ['exec', '--', 'vite', '--port', port, '--strictPort']
    : ['exec', '--', 'vite', 'preview', '--port', port, '--strictPort'];

const child = spawn('npm', args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
