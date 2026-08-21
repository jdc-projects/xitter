/** Reproduce reset-flow's detached worker respawn and verify it survives. */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const child = spawn('npm', ['run', 'start:workers'], {
  cwd: '/private/var/folders/xw/hvzdh8f51v90ngk4snysjwfh0000gn/T/opencode/worktrees/t12-data',
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, XITTER_ENV: 't12', XITTER_PORT_OFFSET: '130' },
});
child.unref();
console.log('spawned pid', child.pid);

await new Promise((resolve) => setTimeout(resolve, 25_000));
try {
  const out = execFileSync('lsof', ['-nP', '-iTCP:9231', '-sTCP:LISTEN'], { encoding: 'utf8' });
  console.log('9231 listening:\n' + out);
} catch {
  console.log('9231 NOT listening');
}
try {
  process.kill(child.pid ?? 0, 0);
  console.log('npm parent alive');
} catch {
  console.log('npm parent dead');
}
