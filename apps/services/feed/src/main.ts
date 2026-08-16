/**
 * Boots the feed service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthGuard, ErrorEnvelopeFilter } from '@xitter/auth-nest';
import { AppModule } from './app.module.js';
import { env } from './env.js';
import { createLogger, initSentry, initTracing } from '@xitter/observability';

const logger = createLogger({ service: 'feed' });

const tracing = initTracing('feed');
initSentry('feed');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  app.setGlobalPrefix('api/feed/v1');
  app.useGlobalGuards(app.get(AuthGuard));
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  logger.info(`listening on :${env.PORT}`);
}

process.once('SIGTERM', () => void tracing.shutdown());

bootstrap().catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
