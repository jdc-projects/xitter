/**
 * Push the Payload schema to the configured Postgres (local parity with the
 * NestJS services' `db:push`). Payload only auto-pushes outside production,
 * and local prod-like runs (`npm run start`) boot with NODE_ENV=production,
 * so this script initialises Payload headlessly in development mode purely
 * to run the schema push, then exits.
 *
 * Also seeds the sentinel admin user (random password, never usable): its
 * only job is to occupy the users table so Payload's always-mounted
 * /first-register endpoint stays permanently closed - anonymous
 * first-admin takeover is otherwise possible whenever the table is empty.
 */
import { randomBytes } from 'node:crypto';
import { loadRepoEnv } from '@xitter/config';

loadRepoEnv();

const SENTINEL_EMAIL = 'sentinel@sso.xitter.local';

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  env['NODE_ENV'] = 'development';

  const { getPayload } = await import('payload');
  const { default: config } = await import('../src/payload.config.js');

  const payload = await getPayload({ config });

  const existing = await payload.find({
    collection: 'users',
    limit: 1,
    pagination: false,
    overrideAccess: true,
    depth: 0,
  });
  if (existing.docs.length === 0) {
    await payload.create({
      collection: 'users',
      data: {
        email: SENTINEL_EMAIL,
        password: randomBytes(32).toString('hex'),
      },
      overrideAccess: true,
    });
    process.stdout.write('cms sentinel user seeded\n');
  }

  process.stdout.write('cms schema pushed\n');
  await payload.destroy();
  process.exit(0);
}

void main();
