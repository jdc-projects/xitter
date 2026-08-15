import { createServer } from 'node:http';
import client from 'prom-client';

export interface MetricsServer {
  registry: client.Registry;
  /** Resolves when the /metrics listener is listening. */
  started: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Minimal Prometheus scrape endpoint for workers (services expose /metrics via
 * their HTTP stack instead). One registry per process.
 */
export function createMetricsServer(port: number): MetricsServer {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((metrics) => {
          res.writeHead(200, { 'content-type': registry.contentType });
          res.end(metrics);
        })
        .catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const started = new Promise<void>((resolve) => server.listen(port, () => resolve()));
  return {
    registry,
    started,
    stop: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
