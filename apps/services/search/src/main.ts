/**
 * Boots the search service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import { bootstrapApiService } from '@xitter/auth-nest';
import { createLogger, initSentry, initTracing } from '@xitter/observability';
import { AppModule } from './app.module.js';
import { env } from './env.js';

const logger = createLogger({ service: 'search' });

const tracing = initTracing('search');
initSentry('search');

process.once('SIGTERM', () => void tracing.shutdown());

bootstrapApiService({
  service: 'search',
  // Service-level prefix: public controllers add their `v1` segment, internal
  // routes (admin health, reseed) stay unversioned under api/search (spec 03).
  prefix: 'api/search',
  port: env.PORT,
  module: AppModule,
}).catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
