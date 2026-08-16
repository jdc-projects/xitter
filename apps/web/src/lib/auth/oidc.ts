import * as oidc from 'openid-client';
import { webEnv } from '../server-env';

let configPromise: Promise<oidc.Configuration> | undefined;

/**
 * Discovery document for the demo realm's public `web` client, cached for
 * the process lifetime. Server-side only (BFF model - browsers never talk
 * OIDC directly). `allowInsecureRequests` permits requests to plain-http
 * issuer endpoints (local Keycloak); it is enabled only when the configured
 * issuer is itself http, so a deployed https issuer still requires TLS.
 */
export function oidcConfig(): Promise<oidc.Configuration> {
  configPromise ??= (async () => {
    const { keycloakBaseUrl, realm, webClientId } = webEnv();
    const issuer = new URL(`${keycloakBaseUrl.replace(/\/$/, '')}/realms/${realm}`);
    const insecure = issuer.protocol === 'http:';
    return oidc.discovery(issuer, webClientId, undefined, undefined, {
      ...(insecure ? { execute: [oidc.allowInsecureRequests] } : {}),
    });
  })();
  return configPromise;
}

export { oidc };
