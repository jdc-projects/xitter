import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HEALTH_ROUTES } from '@xitter/config';
import { createLogger } from '@xitter/observability';
import { AuthGuard } from './auth.guard.js';
import { ErrorEnvelopeFilter } from './error.filter.js';

export interface ApiServiceOptions {
  /** Service name for logging/tracing identity. */
  service: string;
  /** Versioned public prefix, e.g. `api/social/v1`. */
  prefix: string;
  port: number;
  module: Type<unknown>;
}

/**
 * Shared API-service bootstrap: one well-tested startup path for every
 * service (fastify adapter, versioned prefix with root-level health probes,
 * global auth guard + error envelope, graceful shutdown).
 */
export async function bootstrapApiService(options: ApiServiceOptions): Promise<void> {
  const logger = createLogger({ service: options.service });

  const app = await NestFactory.create<NestFastifyApplication>(
    options.module,
    new FastifyAdapter({ trustProxy: true }),
  );

  // Health probes are infrastructure-facing, not public API - they sit at
  // the root, outside the versioned prefix.
  app.setGlobalPrefix(options.prefix, { exclude: [...HEALTH_ROUTES] });
  app.useGlobalGuards(app.get(AuthGuard));
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableShutdownHooks();

  await app.listen(options.port, '0.0.0.0');
  logger.info(`listening on :${options.port}`);
}
