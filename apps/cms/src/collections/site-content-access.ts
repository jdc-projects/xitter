import type { Access } from 'payload';

/** `?draft=true` arrives from REST as a string and from GraphQL as a boolean. */
function wantsDrafts(req: { query?: Record<string, unknown> }): boolean {
  const draft = req.query?.draft;
  return draft === true || draft === 'true';
}

/**
 * Site-content access (spec 04 + 07):
 *
 * - Published content is world-readable - the web app fetches it without a
 *   session during SSR.
 * - Drafts and every mutation require an authenticated CMS user (an
 *   app-admin via the Keycloak bridge). With open read access Payload would
 *   otherwise serve drafts publicly on `?draft=true`.
 */
export const siteContentAccess = {
  read: ({ req }) => (wantsDrafts(req) ? Boolean(req.user) : true),
  create: ({ req }) => Boolean(req.user),
  update: ({ req }) => Boolean(req.user),
  delete: ({ req }) => Boolean(req.user),
} satisfies Record<'read' | 'create' | 'update' | 'delete', Access>;
