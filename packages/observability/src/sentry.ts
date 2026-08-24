import * as Sentry from '@sentry/node';

/**
 * Initialise Sentry for a Node process. No-op unless SENTRY_DSN is set.
 * All workloads report into ONE Sentry project (spec 06): the environment
 * (SENTRY_ENVIRONMENT, falling back to XITTER_ENV - dev/prod namespaces,
 * local default) separates the streams, and the `service` tag keeps
 * per-workload filtering. The release is the deployed image tag
 * (SENTRY_RELEASE, spec 06) so errors line up with the rollout that
 * produced them.
 */
export function initSentry(serviceName: string): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    serverName: serviceName,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.XITTER_ENV ?? 'local',
    release: process.env.SENTRY_RELEASE,
    initialScope: { tags: { service: serviceName } },
    // Demo system: no user PII should ever exist, keep sendDefaultPii off regardless.
    sendDefaultPii: false,
  });
}
