import { Client } from '@opensearch-project/opensearch';

/**
 * The 5s requestTimeout is load-bearing (#195): with no elected manager,
 * cluster-state APIs (index create) hold the request open indefinitely, so
 * the boot-time index ensure must reject quickly into its non-fatal catch
 * (degraded serving) rather than hang past the pod's liveness budget and
 * crashloop the service silently.
 */
export function createOpenSearchClient(node: string): Client {
  return new Client({
    node,
    requestTimeout: 5_000,
    // Local + dev-cluster OpenSearch run with the security plugin
    // disabled (infra/docker/compose.yaml, infra/iac deps.tf).
    ssl: { rejectUnauthorized: false },
  });
}
