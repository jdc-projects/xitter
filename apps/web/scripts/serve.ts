import { spawn } from 'node:child_process';
import { localPort, loadRepoEnv } from '@xitter/config';

loadRepoEnv();
const mode = process.argv[2] ?? 'dev';
const port = String(localPort('web'));

// npm exec resolves next from node_modules/.bin regardless of PATH.
const child = spawn(
  'npm',
  ['exec', '--', 'next', mode === 'start' ? 'start' : 'dev', '--port', port],
  {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  },
);

child.on('exit', (code) => process.exit(code ?? 0));
