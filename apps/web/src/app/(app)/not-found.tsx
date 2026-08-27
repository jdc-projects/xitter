import { NotFoundContent } from '@/components/not-found-content';

/**
 * App-group 404 boundary (#135): notFound() from any (app) surface -
 * deleted or malformed posts/profiles, and the unmatched-route catch-all -
 * renders here, inside the authenticated shell, so a signed-in visitor
 * keeps the header nav, search and logout instead of being dumped out of
 * the app chrome. The layout renders the frame without user bits for
 * signed-out visitors, who simply get the 404 (no login redirect for a
 * URL that does not exist).
 */
export default function AppNotFoundPage() {
  return <NotFoundContent />;
}
