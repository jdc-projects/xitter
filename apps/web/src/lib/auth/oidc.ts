import * as oidc from 'openid-client';
import { webEnv } from '../server-env';

let configPromise: Promise<oidc.Configuration> | undefined;

/**
 * Discovery document for the demo realm's public `web` client, cached for
 * the process lifetime. Server-side only (BFF model - browsers never talk
 * OIDC directly). Local Keycloak is plain HTTP, which openid-client blocks
 * by default (private-use OAuth protections) - allowed there only, so a
 * misconfigured deployed issuer still fails closed.
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
