import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HEALTH_ROUTES } from '@xitter/config';
import { createLogger, createServiceMetrics, type ServiceMetrics } from '@xitter/observability';
import { AuthGuard } from './auth.guard.js';
import { ErrorEnvelopeFilter } from './error.filter.js';

export interface ApiServiceOptions {
  /** Service name for logging/tracing identity. */
  service: string;
  /**
   * Public API prefix, e.g. `api/social`. Controllers own their version
   * segment (`v1`, per spec 03) so internal routes can sit at
   * `/api/{service}/internal/...` without a version.
   */
  prefix: string;
  port: number;
  module: Type<unknown>;
  /**
   * Optional per-service metric registration (spec 06 platform metrics),
   * e.g. feed's freshness gauge. Runs after Nest init (the app is
   * injectable) and before listen, against the service's shared registry.
   */
  configureMetrics?: (app: NestFastifyApplication, metrics: ServiceMetrics) => void | Promise<void>;
}

/**
 * Shared API-service bootstrap: one well-tested startup path for every
 * service (fastify adapter, public prefix with root-level health probes,
 * global auth guard + error envelope, RED metrics on /metrics, graceful
 * shutdown). Returns the application so callers can reach the underlying HTTP
 * server (e.g. the feed service attaches its websocket upgrade handler to it).
 */
export async function bootstrapApiService(
  options: ApiServiceOptions,
): Promise<NestFastifyApplication> {
  const logger = createLogger({ service: options.service });

  const app = await NestFactory.create<NestFastifyApplication>(
    options.module,
    new FastifyAdapter({ trustProxy: true }),
  );

  // Health probes are infrastructure-facing, not public API - they sit at
  // the root, outside the public prefix.
  app.setGlobalPrefix(options.prefix, { exclude: [...HEALTH_ROUTES] });
  app.useGlobalGuards(app.get(AuthGuard));
  app.useGlobalFilters(new ErrorEnvelopeFilter());

  // RED metrics + GET /metrics on the app port (spec 06). Invoked against
  // the ROOT Fastify instance, not via register(): a plain (non
  // fastify-plugin) function registers into an encapsulated child context
  // whose hooks never run for Nest's root-context routes - the metrics
  // would only ever see Prometheus's own /metrics scrapes. It still never
  // passes through the Nest guard pipeline, which is what keeps /metrics
  // scrapeable without credentials.
  const metrics = createServiceMetrics(options.service);
  await options.configureMetrics?.(app, metrics);
  const fastifyRoot = app.getHttpAdapter().getInstance() as unknown as Parameters<
    typeof metrics.plugin
  >[0];
  metrics.plugin(fastifyRoot, {}, () => undefined);

  app.enableShutdownHooks();

  await app.listen(options.port, '0.0.0.0');
  logger.info(`listening on :${options.port}`);
  return app;
}
