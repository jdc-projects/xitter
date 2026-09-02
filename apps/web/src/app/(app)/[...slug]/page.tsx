// fallow-ignore-file dynamic-segment-name-conflict -- fallow's matcher
// treats a matched-name single + catch-all pair ([slug] + [...slug]) as a
// name conflict; verified NOT one on Next 16.3.1: `next build` passes, the
// standalone server serves every route class correctly (fixed 200s, single
// unknown -> public 404 frame, deep unknown -> app-shell 404 - #223), and
// the cms/not-found e2e specs drive both branches green. Remove this
// suppression if fallow's matcher learns matched-name pairs.
import { notFound } from 'next/navigation';

/**
 * Catch-all for URLs no other route claims (#135): living inside the app
 * group means the 404 renders in the authenticated shell via the group's
 * not-found boundary. Required form on purpose - the optional catch-all
 * would also claim `/` from the landing page. Static segments always win
 * route resolution, so `/`, `/about`, `/login`, `/healthz`, `/readyz` and
 * `/api/*` are unaffected; `next`-preserved logins landing here still
 * work - the path exists as far as the redirect cycle is concerned.
 *
 * Named [...slug] to pair with the root-level CMS [slug] route: Next
 * requires consistent dynamic-segment names at one level, and a mismatch
 * ([...rest] vs [slug]) passes `next build` but crashes the route at
 * runtime - fallow's dynamic-segment check caught exactly that (#223).
 */
export default function UnmatchedRoutePage() {
  notFound();
}
