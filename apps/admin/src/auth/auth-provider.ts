import type { AuthProvider } from '@refinedev/core';
import { isAdminRole } from '@xitter/auth';
import { accessTokenRoles, currentUser, userManager } from './session.js';

/**
 * Keycloak-backed auth provider for the admin panel: authorization-code +
 * PKCE against the admin realm (ADR 0006), gated on the admin roles. The
 * API endpoints re-verify the token AND the role server-side (the services'
 * `@Internal({ admin: true })` guard) - this gate is UX, not the security
 * boundary.
 */

export function isAdminToken(roles: string[]): boolean {
  return isAdminRole(roles);
}

export const authProvider: AuthProvider = {
  login: async () => {
    // The redirect leaves the page; success/failure is decided on return.
    await userManager().signinRedirect();
    return { success: true };
  },

  logout: async () => {
    const manager = userManager();
    const user = await manager.getUser();
    await manager.removeUser();
    if (user?.id_token) {
      // Route through Keycloak end-session so the SSO cookie dies too.
      await manager.signoutRedirect({ id_token_hint: user.id_token });
      return { success: true };
    }
    return { success: true, redirectTo: '/login' };
  },

  check: async () => {
    const user = await currentUser();
    if (user && isAdminToken(accessTokenRoles(user))) {
      return { authenticated: true };
    }
    // No session, expired beyond silent renew, or role-less: all "log in
    // again" - a role-less session must never render the panel.
    return { authenticated: false, redirectTo: '/login' };
  },

  onError: async (error) => {
    if ((error as { statusCode?: number })?.statusCode === 401) {
      // Access token expired between renewals: try once silently, else the
      // check() above sends the operator back through login.
      try {
        await userManager().signinSilent();
      } catch {
        return { logout: true, redirectTo: '/login' };
      }
    }
    return {};
  },

  getIdentity: async () => {
    const user = await currentUser();
    if (!user) return null;
    return { id: user.profile.sub, name: user.profile.preferred_username ?? 'admin' };
  },

  getPermissions: async () => {
    const user = await currentUser();
    return user ? accessTokenRoles(user) : [];
  },
};
