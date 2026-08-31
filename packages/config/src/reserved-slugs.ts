/**
 * Top-level URL segments already claimed by the web app or the edge in
 * front of it (#215). CMS pages render at `/<slug>` through a dynamic
 * route, so a page must never take one of these: Next resolves static
 * segments ahead of dynamic ones, so the page would be unreachable (and
 * the segment could later grow routes the page would silently shadow).
 *
 * The CMS rejects reserved slugs at create time and the web route treats
 * them as never-CMS - both sides share this one list. Extend it whenever a
 * root-level route or an edge-routed sibling app is added.
 */
export const RESERVED_WEB_SLUGS: readonly string[] = [
  // Public marketing roots (apps/web/src/app/*)
  'about',
  'login',
  // Authenticated app roots (apps/web/src/app/(app)/*)
  'feed',
  'post',
  'profile',
  'search',
  'bookmarks',
  // Web API routes and the edge-routed service APIs (infra/proxy routes.yml)
  'api',
  // Edge-routed sibling apps (infra/proxy routes.yml)
  'media',
  'cms',
  'admin',
  // Probes
  'healthz',
  'readyz',
];

/** True when `slug` collides with a fixed top-level route segment. */
export function isReservedWebSlug(slug: string): boolean {
  return RESERVED_WEB_SLUGS.includes(slug);
}
