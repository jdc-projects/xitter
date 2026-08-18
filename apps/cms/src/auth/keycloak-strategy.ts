import { createTokenVerifier, type AuthContext, type TokenVerifier } from '@xitter/auth';
import type { AuthStrategy, AuthStrategyResult, Payload } from 'payload';
import { env } from '../env';

/** Spec 07: the CMS is gated on the app-admin realm role. */
export const CMS_ADMIN_ROLE = 'app-admin';

export function adminRealmIssuer(): string {
  return `${env.KEYCLOAK_BASE_URL.replace(/\/$/, '')}/realms/${env.ADMIN_REALM}`;
}

/**
 * Machine auth strategy: a Keycloak access token from the admin realm,
 * presented as `Authorization: Bearer <token>`, authenticates as the mapped
 * Payload user. Used by the web app's draft-preview fetch and the content
 * promotion export. Browser sessions use Payload's own cookie instead, so
 * this strategy deliberately ignores cookies entirely.
 */
export function createKeycloakStrategy(injected?: TokenVerifier): AuthStrategy {
  const verifier =
    injected ??
    createTokenVerifier({
      issuer: adminRealmIssuer(),
      // Machine tokens carry no fixed audience constraint; identity is the
      // client id (azp) + the app-admin realm role check below.
    });

  return {
    name: 'keycloak',
    authenticate: async ({ headers, payload }) => {
      const authorization = headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) return { user: null };
      try {
        const auth = await verifier.verify(authorization.slice('Bearer '.length));
        if (!auth.roles.includes(CMS_ADMIN_ROLE)) return { user: null };
        const user = await findOrCreateAdminUser(payload, auth);
        return { user };
      } catch {
        // Invalid/expired token: not authenticated, not an error.
        return { user: null };
      }
    },
  };
}

/**
 * Map a verified Keycloak identity onto a users doc (keyed by `sub`).
 * Shared with the OIDC callback so browsers and machines share one identity
 * mapping. Never logs the token.
 */
export async function findOrCreateAdminUser(payload: Payload, auth: AuthContext) {
  const existing = await payload.find({
    collection: 'users',
    where: { sub: { equals: auth.subject } },
    limit: 1,
    pagination: false,
    overrideAccess: true,
    depth: 0,
  });
  const email = `${auth.username}@sso.xitter.local`;
  const roles = auth.roles.filter((role) => role === CMS_ADMIN_ROLE);

  const found = existing.docs[0];
  if (found) {
    const typed = found as { id: number; email?: string; roles?: string[] };
    if (typed.email !== email || JSON.stringify(typed.roles ?? []) !== JSON.stringify(roles)) {
      await payload.update({
        collection: 'users',
        id: typed.id,
        data: { email, roles },
        overrideAccess: true,
      });
    }
  } else {
    await payload.create({
      collection: 'users',
      data: { email, sub: auth.subject, roles },
      overrideAccess: true,
    });
  }

  const user = await payload.find({
    collection: 'users',
    where: { sub: { equals: auth.subject } },
    limit: 1,
    pagination: false,
    overrideAccess: true,
    depth: 0,
  });
  const doc = user.docs[0] as { id: number; email: string };
  return { ...doc, collection: 'users', _strategy: 'keycloak' } as NonNullable<
    AuthStrategyResult['user']
  >;
}
