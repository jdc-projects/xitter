/**
 * Boots the posts service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
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
  PORT: z.coerce.number().int().positive().default(localPort('posts')),
  KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
  DEMO_REALM: z.string().min(1).default('xitter-demo'),
  DATABASE_URL: z.string().min(1).default(serviceDbUrl('posts')),
  KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
});

const logger = createLogger({ service: 'posts' });

const env = parseEnv(envSchema);
const tracing = initTracing('posts');
initSentry('posts');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  app.setGlobalPrefix('api/posts/v1');
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  logger.info(`listening on :${env.PORT}`);
}

process.once('SIGTERM', () => void tracing.shutdown());

bootstrap().catch((err: unknown) => {
  logger.error(err);
  process.exitCode = 1;
});
