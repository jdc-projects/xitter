import { describe, expect, it } from 'vitest';
import {
  createServiceMetrics,
  registerCollectGauge,
  type FastifyMetricsInstance,
  type MetricReply,
  type MetricRequest,
  type ServiceMetrics,
} from './service-metrics.js';

/**
 * Minimal Fastify stand-in: records the hooks a plugin registers so tests can
 * drive the request lifecycle directly and assert on exported metric values
 * (outcomes), not plugin internals.
 */
interface Harness {
  metrics: ServiceMetrics;
  respond(url: string | undefined, statusCode: number): Promise<void>;
  /** Drive only onResponse - simulates a reply before onRequest recorded a start. */
  respondWithoutStart(url: string | undefined, statusCode: number): Promise<void>;
  metricsText(): Promise<string>;
}

function harness(serviceName: string): Harness {
  const metrics = createServiceMetrics(serviceName);
  let onRequest:
    ((req: MetricRequest, reply: unknown, next: (err?: Error) => void) => void) | undefined;
  let onResponse:
    ((req: MetricRequest, reply: MetricReply, next: (err?: Error) => void) => void) | undefined;

  const instance: FastifyMetricsInstance = {
    addHook(name, hook) {
      if (name === 'onRequest') onRequest = hook;
      if (name === 'onResponse') onResponse = hook;
      return undefined;
    },
    get(_route, _handler) {
      return undefined;
    },
  };

  metrics.plugin(instance, {}, () => undefined);

  return {
    metrics,
    async respond(url, statusCode) {
      const request: MetricRequest = url === undefined ? {} : { routeOptions: { url } };
      onRequest?.(request, {}, () => undefined);
      onResponse?.(request, { statusCode }, () => undefined);
    },
    async respondWithoutStart(url, statusCode) {
      const request: MetricRequest = url === undefined ? {} : { routeOptions: { url } };
      onResponse?.(request, { statusCode }, () => undefined);
    },
    async metricsText() {
      return metrics.registry.metrics();
    },
  };
}

describe('createServiceMetrics', () => {
  it('counts requests by route and status class', async () => {
    const app = harness('social');
    await app.respond('/api/social/v1/timeline', 200);
    await app.respond('/api/social/v1/timeline', 200);
    await app.respond('/api/social/v1/timeline', 503);

    const text = await app.metricsText();

    expect(text).toContain(
      'xitter_http_requests_total{service="social",route="/api/social/v1/timeline",status_class="2xx"} 2',
    );
    expect(text).toContain(
      'xitter_http_requests_total{service="social",route="/api/social/v1/timeline",status_class="5xx"} 1',
    );
  });

  it('labels unmatched requests without exploding cardinality', async () => {
    const app = harness('posts');
    await app.respond(undefined, 404);

    const text = await app.metricsText();

    expect(text).toContain('route="unmatched"');
    expect(text).toContain('status_class="4xx"');
  });

  it('observes duration seconds in the histogram', async () => {
    const app = harness('feed');
    await app.respond('/api/feed/v1/feed', 200);

    const text = await app.metricsText();

    expect(text).toContain('xitter_http_request_duration_seconds_bucket');
    // Buckets are cumulative, so one observation lands in every bucket incl. +Inf.
    // prom-client exports the le label first, before the metric's own labels.
    expect(text).toMatch(/xitter_http_request_duration_seconds_bucket\{[^}]*le="\+Inf"[^}]*\} 1/);
  });

  it('ignores responses without a recorded start', async () => {
    const app = harness('media');
    // An early reply with no onRequest start recorded must not be counted.
    await app.respondWithoutStart('/api/media/v1/uploads', 200);

    const text = await app.metricsText();

    expect(text).not.toContain('xitter_http_requests_total{service="media"');
  });
});

describe('registerCollectGauge', () => {
  it('exports the collected value on scrape', async () => {
    const app = harness('feed');
    let age = 12.5;
    registerCollectGauge(app.metrics, {
      name: 'xitter_feed_newest_entry_age_seconds',
      help: 'test gauge',
      collect: async () => age,
    });

    let text = await app.metricsText();
    expect(text).toContain('xitter_feed_newest_entry_age_seconds 12.5');

    age = 40;
    text = await app.metricsText();
    expect(text).toContain('xitter_feed_newest_entry_age_seconds 40');
  });

  it('keeps the previous value when the collect returns null', async () => {
    const app = harness('feed');
    let reading: number | null = 5;
    registerCollectGauge(app.metrics, {
      name: 'xitter_feed_newest_entry_age_seconds',
      help: 'test gauge',
      collect: async () => reading,
    });

    await app.metricsText();
    reading = null; // e.g. empty feed table after a reset
    const text = await app.metricsText();

    expect(text).toContain('xitter_feed_newest_entry_age_seconds 5');
  });
});
