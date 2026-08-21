import * as Sentry from '@sentry/node';

/**
 * Initialise Sentry for a Node process. No-op unless SENTRY_DSN is set.
 * Distinguishes environments via XITTER_ENV (dev/prod namespaces, local default).
 * The release is the deployed image tag (SENTRY_RELEASE, spec 06) so errors
 * line up with the rollout that produced them.
 */
export function initSentry(serviceName: string): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    serverName: serviceName,
    environment: process.env.XITTER_ENV ?? 'local',
    release: process.env.SENTRY_RELEASE,
    // Demo system: no user PII should ever exist, keep sendDefaultPii off regardless.
    sendDefaultPii: false,
  });
}
