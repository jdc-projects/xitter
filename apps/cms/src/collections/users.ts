import type { CollectionConfig } from 'payload';
import { createKeycloakStrategy } from '@/auth/keycloak-strategy';

/**
 * CMS admin users, bridged to the Keycloak admin realm (spec 07):
 *
 * - Browsers log in via the OIDC code flow (apps/cms/src/app/(auth)); the
 *   callback mints a standard Payload session for the mapped user.
 * - Machines (web draft-preview fetch, content promotion) present a Keycloak
 *   access token as a Bearer header; the custom strategy below validates it
 *   and maps it to the same user docs.
 *
 * There is no signup and no usable password login: user docs are created by
 * the OIDC callback / keycloak strategy only, so Payload's password fields
 * are never set and the (middleware-bypassed) login form always fails.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email', defaultColumns: ['email', 'sub', 'roles'] },
  auth: {
    depth: 0,
    strategies: [createKeycloakStrategy()],
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
