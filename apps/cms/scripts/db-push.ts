/**
 * Push the Payload schema to the configured Postgres (local parity with the
 * NestJS services' `db:push`). Payload only auto-pushes outside production,
 * and local prod-like runs (`npm run start`) boot with NODE_ENV=production,
 * so this script initialises Payload headlessly in development mode purely
 * to run the schema push, then exits.
 */
import { loadRepoEnv } from '@xitter/config';

loadRepoEnv();

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  env['NODE_ENV'] = 'development';

  const { getPayload } = await import('payload');
  const { default: config } = await import('../src/payload.config.js');

  const payload = await getPayload({ config });
  process.stdout.write('cms schema pushed\n');
  await payload.destroy();
  process.exit(0);
}

void main();
