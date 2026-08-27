import { notFound } from 'next/navigation';

/**
 * Catch-all for URLs no other route claims (#135): living inside the app
 * group means the 404 renders in the authenticated shell via the group's
 * not-found boundary. Required form on purpose - the optional catch-all
 * would also claim `/` from the landing page. Static segments always win
 * route resolution, so `/`, `/about`, `/login`, `/healthz`, `/readyz` and
 * `/api/*` are unaffected; `next`-preserved logins landing here still
 * work - the path exists as far as the redirect cycle is concerned.
 */
export default function UnmatchedRoutePage() {
  notFound();
}
