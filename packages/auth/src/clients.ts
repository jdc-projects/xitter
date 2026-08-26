/**
 * Canonical machine-client registry for the demo realm, shared by the realm
 * provisioner (packages/scripts/src/keycloak.ts), Tofu
 * (infra/iac/environments/{dev,prod}/keycloak.tf - parity pinned by
 * packages/scripts/src/keycloak-parity.test.ts) and token guards. Receiving
 * services validate audience = their own client id on `internal/*` routes,
 * so each client's audiences are EXACTLY the internal APIs it calls (plus a
 * service's own id - its tokens then satisfy its own verifier too).
 */

/** Services (receiver audience) issuing and accepting M2M tokens. */
export const SERVICE_CLIENTS = [
  'svc-social',
  'svc-posts',
  'svc-media',
  'svc-feed',
  'svc-search',
] as const;

/**
 * Audiences each machine client's service-account tokens carry, derived from
 * the actual call graph (the `XITTER_*_URL` cross-service wiring in each
 * app's env schema, not an "any service may call any service" shortcut):
 *   - svc-posts checks social relationships + media assets before accepting
 *     a post (apps/services/posts/src/modules/{relationship,media}-checker.ts);
 *   - svc-feed and svc-search hydrate content through posts/social bulk
 *     lookups (@xitter/service-kit ServiceContentSource, client credentials);
 *   - svc-social and svc-media call no other service;
 *   - workers hit only the services they feed (apps/workers/{fanout,
 *     media-process,search-index}/src/main.ts):
 *     fanout materialises feeds (social + posts + feed), media-process calls
 *     back into media, search-index feeds the index (svc-search) and resolves
 *     author display names via social's bulk profile lookup (#9);
 *   - the reset job reseeds every service's internal endpoint; the admin
 *     tooling client (bruno / scripts / future jobs) hits the five services
 *     that own moderation data (docs/specs/architecture/03-service-interfaces.md).
 * A too-wide entry mints over-privileged tokens; a too-narrow one breaks M2M
 * with 401s - keycloak.ts and keycloak.tf must mint this map verbatim.
 */
export const CLIENT_AUDIENCES: Readonly<Record<string, readonly string[]>> = {
  'svc-social': ['svc-social'],
  'svc-posts': ['svc-posts', 'svc-social', 'svc-media'],
  'svc-media': ['svc-media'],
  'svc-feed': ['svc-feed', 'svc-posts', 'svc-social'],
  'svc-search': ['svc-search', 'svc-posts', 'svc-social'],

  'svc-worker-fanout': ['svc-social', 'svc-posts', 'svc-feed'],
  'svc-worker-media-process': ['svc-media'],
  'svc-worker-search-index': ['svc-search', 'svc-social'],
  'svc-reset': [...SERVICE_CLIENTS],
  'svc-admin': [...SERVICE_CLIENTS],
};

/** Every client allowed to hold internal (M2M) tokens (map insertion order). */
export const INTERNAL_CLIENTS: readonly string[] = Object.keys(CLIENT_AUDIENCES);

/** Machine clients outside the service set (derive: registry is the source). */
export const WORKER_CLIENTS: readonly { clientId: string; audiences: readonly string[] }[] =
  INTERNAL_CLIENTS.filter(
    (clientId) => !(SERVICE_CLIENTS as readonly string[]).includes(clientId),
  ).map((clientId) => ({ clientId, audiences: CLIENT_AUDIENCES[clientId]! }));

export type ServiceClientName = (typeof SERVICE_CLIENTS)[number];
