/**
 * Boots the posts service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import { bootstrapApiService } from '@xitter/auth-nest';
import { createLogger, initSentry, initTracing } from '@xitter/observability';
import { AppModule } from './app.module.js';
import { env } from './env.js';

const logger = createLogger({ service: 'posts' });

const tracing = initTracing('posts');
initSentry('posts');

process.once('SIGTERM', () => void tracing.shutdown());

bootstrapApiService({
  service: 'posts',
  // Service-level prefix: public controllers add their `v1` segment, internal
  // routes sit at /api/posts/internal/... without a version (spec 03).
  prefix: 'api/posts',
  port: env.PORT,
  module: AppModule,
}).catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
