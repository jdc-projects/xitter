import { envBool, envString, localUrl, valkeyUrl } from '@xitter/config';

/**
 * Server-side web env. Everything is env-driven (@xitter/config); the browser
 * never sees these values except the Cap site key, which is public.
 */
export function webEnv() {
  return {
    /** Origin browsers use to reach this app - login flows go through it. */
    appBaseUrl: envString('XITTER_WEB_BASE_URL', localUrl('edge')),
    keycloakBaseUrl: envString('XITTER_KEYCLOAK_URL', localUrl('keycloak')),
    realm: envString('XITTER_DEMO_REALM', 'xitter-demo'),
    /** Public OIDC client in the demo realm. */
    webClientId: envString('XITTER_WEB_CLIENT_ID', 'web'),
    valkeyUrl: envString('XITTER_VALKEY_URL', valkeyUrl()),
    cap: {
      enabled: envBool('XITTER_CAP_ENABLED', false),
      siteUrl: envString('XITTER_CAP_SITE_URL', 'https://cap.jd-chapman.dev'),
      verifyUrl: envString('XITTER_CAP_VERIFY_URL', 'https://cap.jd-chapman.dev'),
      siteKey: envString('XITTER_CAP_SITE_KEY', ''),
      secretKey: envString('XITTER_CAP_SECRET_KEY', ''),
    },
  };
}

export const SESSION_COOKIE = 'xitter_sid';
/** Mirrors the realm's ssoSessionMaxLifespan (12h). */
export const SESSION_TTL_SECONDS = 43_200;
