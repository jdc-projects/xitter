import client from 'prom-client';

/**
 * RED metrics for API services (spec 06): request rate, error rate and
 * duration histogram, labelled by service, route template and status class,
 * served on GET /metrics alongside the app port.
 *
 * The plugin is structurally typed so this package keeps no fastify
 * dependency - it is registered by @xitter/auth-nest's shared bootstrap, and
 * by tests that drive the hooks directly.
 */
export interface ServiceMetrics {
  registry: client.Registry;
  /**
   * Fastify plugin: records per-request counters/histograms and serves
   * GET /metrics from the same registry.
   */
  plugin: (instance: FastifyMetricsInstance, opts: unknown, done: (err?: Error) => void) => void;
}

export interface MetricRequest {
  routeOptions?: { url?: string | undefined };
}

export interface MetricReply {
  statusCode: number;
}

type HookNext = (err?: Error) => void;

interface ReplySender {
  header(name: string, value: string): unknown;
  send(body: string): unknown;
}

export interface FastifyMetricsInstance {
  addHook(
    name: 'onRequest',
    hook: (request: MetricRequest, reply: unknown, next: HookNext) => void,
  ): unknown;
  addHook(
    name: 'onResponse',
    hook: (request: MetricRequest, reply: MetricReply, next: HookNext) => void,
  ): unknown;
  get(route: string, handler: (request: unknown, reply: ReplySender) => Promise<void>): unknown;
}

/** Buckets resolve the 500ms API SLO and the 2s page SLO (spec 06 alerts). */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];

export function createServiceMetrics(serviceName: string): ServiceMetrics {
  const registry = new client.Registry();

  const requests = new client.Counter({
    name: 'xitter_http_requests_total',
    help: 'Total HTTP requests handled by this service',
    labelNames: ['service', 'route', 'status_class'],
    registers: [registry],
  });

  const duration = new client.Histogram({
    name: 'xitter_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['service', 'route', 'status_class'],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  // onRequest → onResponse spans the whole Fastify lifecycle (routing,
  // guards, handlers, serialization). WeakMap keeps per-request state out of
  // the request object.
  const startedAt = new WeakMap<object, bigint>();

  const plugin = (
    instance: FastifyMetricsInstance,
    _opts: unknown,
    done: (err?: Error) => void,
  ) => {
    instance.addHook('onRequest', (request, _reply, next) => {
      startedAt.set(request, process.hrtime.bigint());
      next();
    });

    instance.addHook('onResponse', (request, reply, next) => {
      const start = startedAt.get(request);
      startedAt.delete(request);
      if (start !== undefined) {
        // Unmatched requests (404 before routing) have no route template -
        // a fixed label keeps cardinality bounded.
        const route = request.routeOptions?.url ?? 'unmatched';
        const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
        const labels = { service: serviceName, route, status_class: statusClass };
        requests.inc(labels);
        duration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
      }
      next();
    });

    instance.get('/metrics', async (_request, reply) => {
      reply.header('content-type', registry.contentType);
      reply.send(await registry.metrics());
    });

    done();
  };

  return { registry, plugin };
}

/**
 * Gauge filled on scrape via an async collect callback (spec 06 platform
 * metrics - e.g. feed freshness reads the newest entry age from its DB).
 * A null reading leaves the previous value exported rather than reporting a
 * fake zero; the series simply stays at its last observation.
 */
export function registerCollectGauge(
  metrics: ServiceMetrics,
  options: {
    name: string;
    help: string;
    collect(): Promise<number | null>;
  },
): void {
  const gauge = new client.Gauge({
    name: options.name,
    help: options.help,
    registers: [metrics.registry],
    // prom-client runs this on every /metrics scrape.
    collect: async () => {
      const value = await options.collect();
      if (value !== null) gauge.set(value);
    },
  });
}
