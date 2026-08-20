import { UserManager, type User } from 'oidc-client-ts';
import { adminBasePath, adminOidcConfig } from '../env.js';

/**
 * OIDC session for the admin panel: authorization-code + PKCE against the
 * admin realm (ADR 0006), via oidc-client-ts - the same flow the web app's
 * BFF performs server-side, done client-side here because the panel is a
 * static SPA with no server runtime to hold a secret.
 */

export const callbackPath = '/callback';
export const loginPath = '/login';

function origin(): string {
  // Runtime, not baked: the same build serves through the edge (/admin) and
  // directly off the dev server port.
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function createUserManager(): UserManager {
  const base = `${adminOidcConfig.keycloakUrl.replace(/\/$/, '')}/realms/${adminOidcConfig.realm}`;
  return new UserManager({
    authority: base,
    client_id: adminOidcConfig.clientId,
    redirect_uri: `${origin()}${adminBasePath}${callbackPath}`,
    post_logout_redirect_uri: `${origin()}${adminBasePath}`,
    response_type: 'code',
    scope: 'openid profile',
    automaticSilentRenew: true,
    // default userStore = sessionStorage: the admin session dies with the
    // tab rather than persisting in localStorage.
  });
}

let manager: UserManager | undefined;

/** Lazily-shared manager (tests inject a double via set UserManager). */
export function userManager(): UserManager {
  manager ??= createUserManager();
  return manager;
}

/** Test seam. */
export function setUserManager(replacement: UserManager | undefined): void {
  manager = replacement;
}

/** Realm roles from the ACCESS token payload (server re-verifies; UI gating only). */
export function accessTokenRoles(user: User | null): string[] {
  if (!user?.access_token) return [];
  try {
    const payload = JSON.parse(
      atob(user.access_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { realm_access?: { roles?: string[] } };
    return payload.realm_access?.roles ?? [];
  } catch {
    return [];
  }
}

/** Current session, skipping expired tokens (silent renew handles refresh). */
export async function currentUser(): Promise<User | null> {
  const user = await userManager().getUser();
  if (!user) return null;
  if (user.expired) {
    try {
      return await userManager().signinSilent();
    } catch {
      await userManager().removeUser();
      return null;
    }
  }
  return user;
}

export async function getAccessToken(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('No admin session');
  return user.access_token;
}
