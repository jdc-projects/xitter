/**
 * Boots the social service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import { bootstrapApiService } from '@xitter/auth-nest';
import { createLogger, initSentry, initTracing } from '@xitter/observability';
import { AppModule } from './app.module.js';
import { env } from './env.js';

const logger = createLogger({ service: 'social' });

const tracing = initTracing('social');
initSentry('social');

process.once('SIGTERM', () => void tracing.shutdown());

bootstrapApiService({
  service: 'social',
  // Service-level prefix: public controllers add their `v1` segment, internal
  // routes sit at /api/social/internal/... without a version (spec 03).
  prefix: 'api/social',
  port: env.PORT,
  module: AppModule,
}).catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
