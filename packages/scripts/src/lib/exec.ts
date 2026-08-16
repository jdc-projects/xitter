import { spawn } from 'node:child_process';
import { findRepoRoot } from '@xitter/config';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Print full output; defaults to inheriting stdio. */
  capture?: boolean;
}

/** Run a command, inheriting stdio; rejects on non-zero exit. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? findRepoRoot(),
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stderr = '';
    if (options.capture) {
      child.stdout?.on('data', (d) => process.stdout.write(d));
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stderr}`));
    });
  });
}

/** Run a command capturing stdout (trimmed). */
export function capture(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? findRepoRoot(),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stderr}`));
    });
  });
}
