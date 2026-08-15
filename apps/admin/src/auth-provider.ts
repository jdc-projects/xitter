import type { AuthProvider } from "@refinedev/core";

/**
 * Keycloak-backed auth provider for the admin panel.
 *
 * Skeleton: the full OIDC code-flow (PKCE), token refresh, and the role check
 * ("only system or app admin may log in") land with the admin auth feature
 * ticket. Login state is kept in localStorage for the demo.
 */

const ADMIN_ROLES = ["system-admin", "app-admin"];

export const authProvider: AuthProvider = {
  login: async () => ({ success: false, error: new Error("Not implemented yet - see admin auth ticket") }),
  logout: async () => {
    localStorage.removeItem("xitter-admin");
    return { success: true };
  },
  check: async () =>
    localStorage.getItem("xitter-admin") ? { authenticated: true } : { authenticated: false },
  onError: async () => ({}),
  getIdentity: async () => null,
};

/** Pure role gate, exported for tests - the real provider derives roles from the token. */
export function isAdminRole(roles: string[]): boolean {
  return roles.some((role) => ADMIN_ROLES.includes(role));
}
