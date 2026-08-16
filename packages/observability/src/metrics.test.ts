import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsServer, type MetricsServer } from './metrics.js';

describe('createMetricsServer', () => {
  let server: MetricsServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('serves Prometheus metrics on /metrics', async () => {
    server = createMetricsServer(0);
    const port = await server.started;

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('nodejs_');
  });

  it('answers liveness probes on /healthz', async () => {
    server = createMetricsServer(0);
    const port = await server.started;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for anything else', async () => {
    server = createMetricsServer(0);
    const port = await server.started;

    const res = await fetch(`http://127.0.0.1:${port}/nope`);

    expect(res.status).toBe(404);
  });
});
