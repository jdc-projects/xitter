import type { Access } from 'payload';

/** `?draft=true` arrives from REST as a string and from GraphQL as a boolean. */
function wantsDrafts(req: { query?: Record<string, unknown> }): boolean {
  const draft = req.query?.draft;
  return draft === true || draft === 'true';
}

/**
 * Site-content access (spec 04 + 07):
 *
 * - Anonymous (web SSR) reads: published docs only, enforced with a where
 *   constraint - a never-published doc's latest version lives in the main
 *   table with `_status: 'draft'`, and Payload's plain find does not filter
 *   it out. Constraining the query closes that leak for good.
 * - Authenticated CMS users (app-admin via the Keycloak bridge) see
 *   everything, including drafts (`?draft=true`).
 * - Mutations require an authenticated CMS user.
 */
export const siteContentAccess = {
  read: ({ req }) => {
    if (wantsDrafts(req)) return Boolean(req.user);
    return req.user ? true : { _status: { equals: 'published' } };
  },
  create: ({ req }) => Boolean(req.user),
  update: ({ req }) => Boolean(req.user),
  delete: ({ req }) => Boolean(req.user),
} satisfies Record<'read' | 'create' | 'update' | 'delete', Access>;
