/**
 * Boots the search service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { kafkaBrokers, localPort, localUrl, parseEnv, serviceDbUrl } from '@xitter/config';
import { z } from 'zod';
import { createLogger, initSentry, initTracing } from '@xitter/observability';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(localPort('search')),
  KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
  DEMO_REALM: z.string().min(1).default('xitter-demo'),
  DATABASE_URL: z.string().min(1).default(serviceDbUrl('search')),
  KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
});

const logger = createLogger({ service: 'search' });

const env = parseEnv(envSchema);
const tracing = initTracing('search');
initSentry('search');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  // Health probes are infrastructure-facing, not public API - they sit at the
  // root, outside the versioned prefix.
  app.setGlobalPrefix('api/search/v1', { exclude: ['healthz', 'readyz'] });
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  logger.info(`listening on :${env.PORT}`);
}

process.once('SIGTERM', () => void tracing.shutdown());

bootstrap().catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
