import { envBool, envString, localUrl, valkeyUrl } from '@xitter/config';

/**
 * Server-side web env. Everything is env-driven (@xitter/config); the browser
 * never sees these values except the Cap site key, which is public.
 */
export function webEnv() {
  const cap = {
    enabled: envBool('XITTER_CAP_ENABLED', false),
    // No hardcoded URL fallback (AGENTS.md) - the hosted Cap instance is
    // documented in .env.example and must come from env when captcha is on.
    siteUrl: envString('XITTER_CAP_SITE_URL', ''),
    verifyUrl: envString('XITTER_CAP_VERIFY_URL', ''),
    siteKey: envString('XITTER_CAP_SITE_KEY', ''),
    secretKey: envString('XITTER_CAP_SECRET_KEY', ''),
  };
  // Half-configured captcha bricks login while the UI claims captcha is
  // off - a fail-fast config error is easier to diagnose.
  if (cap.enabled && !(cap.siteUrl && cap.verifyUrl && cap.siteKey && cap.secretKey)) {
    throw new Error(
      'XITTER_CAP_ENABLED=true requires XITTER_CAP_SITE_URL, XITTER_CAP_VERIFY_URL, ' +
        'XITTER_CAP_SITE_KEY and XITTER_CAP_SECRET_KEY to be set',
    );
  }
  // Deployed environments (tofu sets XITTER_CAP_REQUIRED) must not boot
  // without bot protection: a silently-disabled captcha looks exactly like
  // a working login page, and that is how dev ran unprotected for days.
  // Local/ephemeral stacks never set the flag - captcha stays optional
  // there (offset copies legitimately run without it).
  const capRequired = envBool('XITTER_CAP_REQUIRED', false);
  if (capRequired && !cap.enabled) {
    throw new Error(
      'XITTER_CAP_REQUIRED=true but captcha is not enabled - deployed environments ' +
        'must have bot protection configured (spec 02 §3.2): set XITTER_CAP_ENABLED ' +
        'with all four XITTER_CAP_* values',
    );
  }
  return {
    /** Origin browsers use to reach this app - login flows go through it. */
    appBaseUrl: envString('XITTER_WEB_BASE_URL', localUrl('edge')),
    keycloakBaseUrl: envString('XITTER_KEYCLOAK_URL', localUrl('keycloak')),
    realm: envString('XITTER_DEMO_REALM', 'xitter-demo'),
    /** Public OIDC client in the demo realm. */
    webClientId: envString('XITTER_WEB_CLIENT_ID', 'web'),
    valkeyUrl: envString('XITTER_VALKEY_URL', valkeyUrl()),
    cap: {
      ...cap,
      // @cap.js/widget POSTs to `<data-cap-api-endpoint>/challenge` and
      // `/redeem` and never sends the site key separately (it does not read
      // a data-cap-site-key attribute), so the endpoint MUST be
      // `<instance>/<siteKey>` - the Cap Standalone contract
      // (https://trycap.dev/guide/widget.html) and the only path shape the
      // homelab edge routes for cap.jd-chapman.dev. A bare origin POSTs to
      // `/challenge`, which the edge rejects (401 from the OIDC default
      // backend). Composed here so the client bundle receives a ready URL;
      // XITTER_CAP_SITE_URL stays the bare instance origin in tofu/.env.
      widgetEndpoint: cap.enabled ? `${cap.siteUrl.replace(/\/+$/, '')}/${cap.siteKey}` : '',
    },
  };
}

export const SESSION_COOKIE = 'xitter_sid';
/**
 * Cookie/session TTL - mirrors the realm's ssoSessionMaxLifespan (12h).
 * Keep in sync with ssoSessionMaxLifespan in packages/scripts/src/keycloak.ts.
 */
export const SESSION_TTL_SECONDS = 43_200;
