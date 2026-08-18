import * as oidc from 'openid-client';
import { env } from '../env';

let configPromise: Promise<oidc.Configuration> | undefined;

/**
 * Discovery document for the confidential `cms` client in the admin realm
 * (locally `xitter-local-admin`, in-cluster the homelab primary realm).
 * `allowInsecureRequests` only when the issuer itself is plain http, matching
 * the web app's OIDC helper.
 */
export function cmsOidcConfig(): Promise<oidc.Configuration> {
  configPromise ??= (async () => {
    const issuer = new URL(
      `${env.KEYCLOAK_BASE_URL.replace(/\/$/, '')}/realms/${env.ADMIN_REALM}`,
    );
    const insecure = issuer.protocol === 'http:';
    return oidc.discovery(issuer, env.CMS_CLIENT_ID, env.CMS_CLIENT_SECRET, undefined, {
      ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
    });
  })();
  return configPromise;
}

/**
 * Browser-facing origin of this app. Behind the (local or cluster) edge the
 * forwarded headers carry the public host; direct access falls back to the
 * request's own URL.
 */
export function publicOrigin(requestUrl: string, headers: Headers): string {
  const own = new URL(requestUrl);
  const proto = headers.get('x-forwarded-proto') ?? own.protocol.replace(':', '');
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? own.host;
  return `${proto}://${host}`;
}

/** Callback URL for the code flow, derived from the incoming request origin. */
export function callbackUrl(requestUrl: string, headers: Headers): string {
  return `${publicOrigin(requestUrl, headers)}/cms/auth/oidc/callback`;
}

export { oidc };
