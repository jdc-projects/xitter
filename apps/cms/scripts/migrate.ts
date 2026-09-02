// fallow-ignore-file unused-file -- bundled into the image by
// scripts/bundle-migrations.mjs (Dockerfile), not imported
/**
 * Headless Payload migration runner - the deployed schema mechanism.
 *
 * `payload migrate` (the CLI) needs the TS config, tsx and a resolvable
 * node_modules, none of which exist in the Next standalone runtime image:
 * production builds bundle payload into the server chunks (withPayload only
 * externalizes it in dev), so scripts/bundle-migrations.mjs compiles the
 * config, the committed migrations and this runner into ONE self-contained
 * .next/migrate/migrate.mjs. The k8s migrate init container runs it before
 * every (re)start (migrate_command in infra/iac/environments/{dev,prod}),
 * mirroring the prisma services' `npx prisma migrate deploy`.
 *
 * Migration names are the source-file basenames - exactly what
 * `payload migrate` records - so local CLI runs and deployed runs share one
 * payload_migrations ledger.
 */
import payload from 'payload';
import type { MigrationData, SanitizedConfig } from 'payload';
import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-postgres';

/**
 * A migration entry as exported from src/migrations/index.ts (maintained by
 * `payload migrate:create`) - the same shape the CLI's readMigrationFiles
 * builds, so both paths write one payload_migrations ledger.
 */
export interface BundledMigration {
  name: string;
  up: (args: MigrateUpArgs) => Promise<void>;
  down: (args: MigrateDownArgs) => Promise<void>;
}

// Belt to the adapter's own guard (@payloadcms/db-postgres connect): even
// outside production this process must never dev-push the schema - deployed
// environments get their schema from migrations only (payload.config.ts
// disables push there; this covers local prod-like runs of the bundle).
process.env.PAYLOAD_MIGRATING = 'true';

export async function runMigrations(options: {
  config: SanitizedConfig;
  migrations: BundledMigration[];
}): Promise<void> {
  const migrations = options.migrations.map((migration) => {
    if (typeof migration.up !== 'function' || typeof migration.down !== 'function') {
      throw new Error(`Migration ${migration.name} does not export up() and down()`);
    }
    return migration as MigrationData & {
      up: (args: unknown) => Promise<void>;
      down: (args: unknown) => Promise<void>;
    };
  });
  if (migrations.length === 0) {
    // The deployed schema exists only through migrations - an empty set
    // would boot the cms straight into the missing-tables 500s.
    throw new Error('No Payload migrations found - the cms schema would never be created');
  }

  // Barebones instance, exactly like the CLI's migrate bin: no init hooks.
  // The bundled pino cannot spawn its pretty-print transport worker
  // (thread-stream's worker file does not survive bundling); an
  // instantiated logger is used as-is (payload getLogger), so route logs to
  // the console.
  options.config.logger = console as unknown as NonNullable<SanitizedConfig['logger']>;
  await payload.init({ config: options.config, disableOnInit: true });

  // Passing the files explicitly (not via migrationDir) keeps the runner
  // independent of process.cwd() - the init container starts in /app.
  await payload.db.migrate({ migrations });
  await payload.destroy();
}
