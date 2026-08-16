#!/usr/bin/env tsx
/**
 * Local dependency lifecycle: `tsx packages/scripts/src/docker.ts up|down|status`.
 * Wraps docker compose with the right project name and env file.
 */
import { down, status, up } from './lib/compose.js';

const command = process.argv[2] ?? 'status';

switch (command) {
  case 'up':
    await up();
    break;
  case 'down':
    await down(process.argv.includes('--volumes'));
    break;
  case 'status':
    await status();
    break;
  default:
    console.error(`Unknown command: ${command}. Use up | down [--volumes] | status.`);
    process.exit(1);
}
