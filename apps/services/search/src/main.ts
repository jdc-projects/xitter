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
  prefix: 'api/search/v1',
  port: env.PORT,
  module: AppModule,
}).catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
