/**
 * Baked-at-build IdP coordinates (see vite.config.ts): env-driven via
 * @xitter/config in the Node build context - never hardcoded ports.
 */
declare const __XITTER_KEYCLOAK_URL__: string;
declare const __XITTER_ADMIN_REALM__: string;

export const adminOidcConfig = {
  keycloakUrl: __XITTER_KEYCLOAK_URL__,
  realm: __XITTER_ADMIN_REALM__,
  clientId: 'admin-panel',
} as const;
