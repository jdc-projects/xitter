/**
 * Baked-at-build IdP coordinates (see vite.config.ts): env-driven via
 * @xitter/config in the Node build context - never hardcoded ports.
 */
declare const __XITTER_KEYCLOAK_URL__: string;
declare const __XITTER_ADMIN_REALM__: string;
declare const __XITTER_ADMIN_CLIENT_ID__: string;

export const adminOidcConfig = {
  keycloakUrl: __XITTER_KEYCLOAK_URL__,
  realm: __XITTER_ADMIN_REALM__,
  // Default `admin-panel` = the local bootstrap's client; deploys bake
  // `xitter-<env>-admin-spa` (env-distinct ids in the shared primary realm).
  clientId: __XITTER_ADMIN_CLIENT_ID__,
} as const;

/**
 * The path the panel is served under, through the edge (/admin route, not
 * stripped) and directly off the dev server (vite base). react-router's
 * basename, the OIDC redirect URIs, and the vite base must agree - one
 * constant keeps them in lockstep.
 */
export const adminBasePath = '/admin';
