/**
 * Boots the feed service: tracing, Sentry, Fastify/Nest app, the websocket
 * gateway (upgrades share the API port) and graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import { bootstrapApiService, USER_VERIFIER } from '@xitter/auth-nest';
import { createLogger, initSentry, initTracing, registerCollectGauge } from '@xitter/observability';
import { AppModule } from './app.module.js';
import { env } from './env.js';
import { FeedGateway, FEED_WS_PATH } from './modules/feed.gateway.js';
import { FeedRepository } from './modules/feed.repository.js';

const logger = createLogger({ service: 'feed' });

const tracing = initTracing('feed');
initSentry('feed');

let gateway: FeedGateway | undefined;

process.once('SIGTERM', () => {
  void (async () => {
    await gateway?.close().catch(() => undefined);
    await tracing.shutdown();
  })();
});

bootstrapApiService({
  service: 'feed',
  // Service-level prefix: the public controller adds its `v1` segment,
  // internal routes sit at /api/feed/internal/... without a version
  // (spec 03). The ws route lives under the public prefix.
  prefix: 'api/feed',
  port: env.PORT,
  module: AppModule,
  // Feed-freshness platform metric (spec 06, #12): age of the newest
  // materialised entry, read from the DB on every scrape.
  configureMetrics: (app, metrics) => {
    const repository = app.get(FeedRepository);
    registerCollectGauge(metrics, {
      name: 'xitter_feed_newest_entry_age_seconds',
      help: 'Age of the newest materialised feed entry across all users',
      collect: async () => {
        const newestAt = await repository.newestPostCreatedAt();
        return newestAt ? Math.max(0, (Date.now() - newestAt.getTime()) / 1000) : null;
      },
    });
  },
})
  .then((app) => {
    // ws shares the API port: the gateway takes over upgrades on its path
    // and re-validates the connect token itself (spec 03 ws contract).
    gateway = new FeedGateway({
      server: app.getHttpServer(),
      path: FEED_WS_PATH,
      redisUrl: env.VALKEY_URL,
      verifier: app.get(USER_VERIFIER),
    });
    gateway.startPinging();
    logger.info(`ws gateway on ${FEED_WS_PATH}`);
  })
  .catch((err: unknown) => {
    logger.error(err);
    process.exitCode = 1;
  });
