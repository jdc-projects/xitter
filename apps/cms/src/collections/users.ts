import type { CollectionConfig } from 'payload';
import { createKeycloakStrategy } from '@/auth/keycloak-strategy';

/**
 * CMS admin users, bridged to the Keycloak admin realm (spec 07):
 *
 * - Browsers log in via the OIDC code flow (apps/cms/src/app/(auth)); the
 *   callback mints a standard Payload session cookie for the mapped user.
 * - Machines (web draft-preview fetch, content promotion) present a Keycloak
 *   access token as a Bearer header; the custom strategy below validates it
 *   and maps it to the same user docs.
 *
 * No usable password login exists: user docs are created only by the
 * Keycloak bridge with a random, never-communicated password (Payload
 * requires one on auth collections), and the proxy sends /admin/login to
 * Keycloak instead of Payload's local login form.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email', defaultColumns: ['email', 'sub', 'roles'] },
  auth: {
    depth: 0,
    strategies: [createKeycloakStrategy()],
    // Payload mounts /first-register on every auth collection; with
    // overrideAccess it would let an anonymous caller create the first
    // admin whenever the users table is empty (fresh stack, or nightly
    // after truncation until reseed). Closed two ways: the sentinel user
    // seeded by scripts/db-push.ts (its empty-table check then refuses)
    // and the beforeOperation hook below.
  },
  hooks: {
    beforeOperation: [
      // Belt to the sentinel user's braces: refuse the registerFirstUser
      // operation outright (Payload mounts /first-register on every auth
      // collection regardless of disableSignup; hooks see it as 'create',
      // but its args lack our bridge's sub/roles shape - the sentinel user
      // makes the endpoint refuse anyway via its empty-table check).
      ({ args }) => {
        const data = (args as { data?: Record<string, unknown> }).data;
        if (
          data &&
          !('sub' in data) &&
          typeof data.email === 'string' &&
          'password' in data &&
          !('roles' in data)
        ) {
          // Only the registerFirstUser path can reach a users create
          // without a sub (the Keycloak bridge always sets one).
          throw new Error('first-user registration is disabled');
        }
      },
    ],
  },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    // Keycloak subject - the join key between tokens and Payload user docs.
    { name: 'sub', type: 'text', unique: true, admin: { readOnly: true } },
    // Realm roles mirrored at login time (informational; the strategy
    // re-validates the role on every machine request).
    { name: 'roles', type: 'text', hasMany: true, admin: { readOnly: true } },
  ],
};
