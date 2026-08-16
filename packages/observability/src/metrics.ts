import { createServer } from 'node:http';
import client from 'prom-client';

export interface MetricsServer {
  registry: client.Registry;
  /** Resolves with the bound port when the listener is up (useful for port 0). */
  started: Promise<number>;
  stop(): Promise<void>;
}

/**
 * Minimal Prometheus scrape endpoint for workers (services expose /metrics via
 * their HTTP stack instead). One registry per process. Also answers /healthz
 * liveness probes - the listener being up means the process is alive.
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
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const started = new Promise<number>((resolve) =>
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    }),
  );
  return {
    registry,
    started,
    stop: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
