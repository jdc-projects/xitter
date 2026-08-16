import * as oidc from 'openid-client';
import { webEnv } from '../server-env';

let configPromise: Promise<oidc.Configuration> | undefined;

/**
 * Discovery document for the demo realm's public `web` client, cached for
 * the process lifetime. Server-side only (BFF model - browsers never talk
 * OIDC directly).
 */
export function oidcConfig(): Promise<oidc.Configuration> {
  configPromise ??= (async () => {
    const { keycloakBaseUrl, realm, webClientId } = webEnv();
    const issuer = new URL(`${keycloakBaseUrl.replace(/\/$/, '')}/realms/${realm}`);
    return oidc.discovery(issuer, webClientId);
  })();
  return configPromise;
}

export { oidc };
