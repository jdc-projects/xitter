/**
 * Canonical machine-client registry for the demo realm, shared by the realm
 * provisioner (packages/scripts/src/keycloak.ts) and token guards. Receiving
 * services validate audience = their own client id on `internal/*` routes.
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
 * Machine clients outside the service set with the scoped audiences they may
 * call on `internal/*` endpoints: workers hit only the services they feed,
 * the reset job hits everything, the admin tooling client (bruno / scripts /
 * future jobs) hits the five services that own moderation data
 * (docs/specs/architecture/03-service-interfaces.md).
 */
export const WORKER_CLIENTS: readonly { clientId: string; audiences: readonly string[] }[] = [
  { clientId: 'svc-worker-fanout', audiences: ['svc-social', 'svc-posts', 'svc-feed'] },
  { clientId: 'svc-worker-media-process', audiences: ['svc-media'] },
  // search-index feeds the index (svc-search) and resolves author display
  // names for documents via social's bulk profile lookup (#9).
  {
    clientId: 'svc-worker-search-index',
    audiences: ['svc-search', 'svc-social'],
  },
  { clientId: 'svc-reset', audiences: [...SERVICE_CLIENTS] },
  { clientId: 'svc-admin', audiences: [...SERVICE_CLIENTS] },
];

/** Every client allowed to hold internal (M2M) tokens. */
export const INTERNAL_CLIENTS: readonly string[] = [
  ...SERVICE_CLIENTS,
  ...WORKER_CLIENTS.map((client) => client.clientId),
];

export type ServiceClientName = (typeof SERVICE_CLIENTS)[number];
