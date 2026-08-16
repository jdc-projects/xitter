/**
 * Infrastructure probe route names (without leading slash), shared by the
 * service bootstrap (prefix exclusion), the auth guard (unauthenticated
 * kubelet access), and the health controller. The Tofu module's probe paths
 * (`infra/iac/modules/xitter-service`) must stay in sync - a rename here
 * without that reintroduces liveness-kill crash loops in-cluster.
 */
export const HEALTH_ROUTES = ['healthz', 'readyz'] as const;
