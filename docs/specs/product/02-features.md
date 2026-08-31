# Features

Acceptance-style catalogue of every user-facing feature area. "Must" = required for the feature to be considered done. System behaviour is the desired end-state, not the current state; data plumbing details live in [../data/01-storage-model.md](../data/01-storage-model.md) and [../data/03-data-lifecycle.md](../data/03-data-lifecycle.md).

## 1. Landing page

| #   | Acceptance criteria                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Public (unauthenticated). Serves as the site's front door: the gradient wordmark and a one-line, code-owned value prop — the how-it-works content lives on the About page (#153).                                                                                                                     |
| 1.2 | Shows an **unmissable reset notice**: all data is wiped nightly (default 00:30 UTC).                                                                                                                                                                                                                  |
| 1.3 | Links to the About page (which includes the FAQ section).                                                                                                                                                                                                                                             |
| 1.4 | Provides a clear path to login. No user-generated content is visible.                                                                                                                                                                                                                                 |
| 1.5 | Renders the shared **public header** (brand → home, About, Log in — or the signed-in visitor's handle and a _Back to the feed_ link when a session resolves); nav links mark the current page (`aria-current`). The authenticated shell renders its own nav instead and links back to the About page. |
| 1.6 | Carries the demo: hero treatment of the gradient wordmark with the one-line value prop in larger type; the line links to About.                                                                                                                                                                       |
| 1.7 | Shows a **demo-credentials entry point** (accounts + password, public by design) that links to login.                                                                                                                                                                                                 |

## 2. About page

| #   | Acceptance criteria                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | Public. Always referred to as the "About page" in UI copy (it contains an FAQ section but is never called a "FAQ page").                                                                                                                                     |
| 2.2 | Explains what xitter is, why it exists, and how it works (microservices demo) — as **CMS-managed sections** moved from the landing intro (#153): ordered, live-previewable, with a code fallback; section slugs double as anchors (`#what`, `#why`, `#how`). |
| 2.3 | Documents the data reset, including the schedule (nightly, default 00:30 UTC) and that reseed may restore a fixed corpus.                                                                                                                                    |
| 2.4 | Lists demo credentials (`demo1`..`demo10` / `DemoPass123!`).                                                                                                                                                                                                 |
| 2.5 | Contains an FAQ section with entries managed in the CMS, plus code-owned entries for product facts (e.g. what unauthenticated visitors can see).                                                                                                             |     |
| 2.6 | Carries the PII warning: do not enter personal or sensitive data.                                                                                                                                                                                            |
| 2.7 | Reachable from the public header; carries no self-referential links (the reset notice's read-more link is suppressed on the About page itself).                                                                                                              |
| 2.8 | Renders the **under-the-hood stack strip** (moved from the landing, #153) — what the platform is and runs on (web app, services, workers, stores, IaC). Facts live in code; the CMS sections stay the editable prose.                                        |

## 3. Auth

| #   | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Login with demo accounts only. No signup, no password change, no account management.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3.2 | Login form is protected by a Cap.js proof-of-work challenge (not an image captcha); user-facing copy describes it as a quick verification that runs in the browser, and the `error=challenge` param drives the failure message. Deployed environments (tofu-managed) treat it as mandatory: web refuses to boot without it (`XITTER_CAP_REQUIRED`), so a misconfigured deploy fails loudly instead of serving an unprotected login form. Local/ephemeral stacks run without it — no copy renders for the disabled widget. |
| 3.3 | Unauthenticated visitors can only reach landing + About; any user-generated content (feeds, profiles, posts) requires login.                                                                                                                                                                                                                                                                                                                                                                                              |
| 3.4 | Logout works from anywhere in the app and returns the visitor to the landing page.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3.5 | Invalid credentials show a generic error without revealing whether username or password failed.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3.6 | A signed-in visitor opening `/login` is redirected straight to the sanitized intended destination (default `/feed`) instead of the form; switching accounts goes through logout (end-session) first.                                                                                                                                                                                                                                                                                                                      |
| 3.7 | The login page renders the shared **public header** (signed-out variant - a live session is redirected before render), so navigation parity holds across every public page.                                                                                                                                                                                                                                                                                                                                               |

## 4. Posts

| #   | Acceptance criteria                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Create a post with **required** text of 1–512 characters and **optional** images.                                                                                                                                                                                                                              |
| 4.2 | Images: png, jpeg, webp, gif; ≤5 MB each; ≤4 per post. Over-limit is rejected with a clear message.                                                                                                                                                                                                            |
| 4.3 | Every post shows its author and an accurate timestamp.                                                                                                                                                                                                                                                         |
| 4.4 | Timestamps in lists use relative format when <24 h old, **rounded to the most significant figure** (e.g. `1h`, not `1h 20m`; `5m`; `2d` boundary per feed rules below); absolute `D MMM YYYY HH:mm` when ≥24 h old.                                                                                            |
| 4.5 | Authors can delete their own posts; deleted posts (and their media) disappear from feeds, profiles, threads, and search.                                                                                                                                                                                       |
| 4.6 | Validation errors (empty text, >512 chars, too many/too large images) never lose the user's draft.                                                                                                                                                                                                             |
| 4.7 | X-style keyboard: **Enter posts** (attachments upload first); **Shift+Enter inserts a newline**.                                                                                                                                                                                                               |
| 4.8 | Each staged image offers an optional alt-text field (shown after picking, ≤200 chars, trimmed non-empty or absent) with a nudge that descriptive alt helps screen-reader users. Rendered images use the stored alt text, falling back to a generic description when none was supplied (legacy posts included). |

## 5. Feed

| #   | Acceptance criteria                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Shows only posts from followed accounts plus the user's own posts — nothing else.                                                                                                                                                                                                       |
| 5.2 | Ordered most recent first.                                                                                                                                                                                                                                                              |
| 5.3 | Timestamp format: relative (<24 h) rounded to the most significant figure (e.g. `1h`, not `1h 20m`); absolute `D MMM YYYY HH:mm` when older.                                                                                                                                            |
| 5.4 | Paginated (cursor-based; no gaps or duplicates across pages).                                                                                                                                                                                                                           |
| 5.5 | Near-real-time: new posts, replies, and interactions arrive via websocket notifications without a manual refresh.                                                                                                                                                                       |
| 5.6 | Reposts surface in the follower's feed attributed to the reposter, showing the original post.                                                                                                                                                                                           |
| 5.7 | Load failures show an inline error with a retry affordance - the copy never says "try again" without offering the button.                                                                                                                                                               |
| 5.8 | Replies in the feed render a "Replying to @x" context line (the reply-target's author) above the post text; replies whose parent is gone render without it (#147).                                                                                                                      |
| 5.9 | A fresh own post is visible at the top of the feed immediately after composing (optimistic prepend, refined by the next real fetch); while the websocket is closed the feed polls page 1 (~15 s) instead of relying on the at-most-once banner, pausing while the tab is hidden (#148). |

## 6. Interactions

| #   | Acceptance criteria                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | Reply, like, bookmark, and repost — each with an undo (delete).                                                                                                                                                                                                                                                       |
| 6.2 | Bookmarks are private to the bookmarking user; no other user can see them. Bookmark counts are never public.                                                                                                                                                                                                          |
| 6.3 | Replies form threads: a post shows its replies, nested viewing follows the conversation.                                                                                                                                                                                                                              |
| 6.4 | Blocked users cannot interact with the blocker or the blocker's posts: replies, likes, reposts (and follows) fail. Undoing one's own interaction is always allowed (it removes the caller's footprint, not an engagement).                                                                                            |
| 6.5 | Like/repost/bookmark counts are consistent across post cards, threads, and profiles.                                                                                                                                                                                                                                  |
| 6.6 | **Repost rule:** reposting a repost reposts the **original** post — nested repost chains are impossible. Reposting your own post is allowed. A repost surfaces in the reposter's followers' feeds attributed to the reposter ("X reposted"), ordered by the repost time; undoing it removes those entries everywhere. |
| 6.7 | Authors get a near-real-time hint (websocket notification, no feed entry) when someone likes or reposts their post.                                                                                                                                                                                                   |

## 7. Relationships

| #   | Acceptance criteria                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Follow adds an account's posts (and their reposts) to the follower's feed; unfollow removes them going forward.                                                  |
| 7.2 | Follow/unfollow is toggleable from any profile and from post cards.                                                                                              |
| 7.3 | Block prevents the blocked user from interacting with the blocker or their posts (replies, likes, reposts, follows all fail). Unblock restores normal behaviour. |
| 7.4 | Every profile shows its **following** and **followers** lists — for any user, not just yourself.                                                                 |
| 7.5 | Profiles show relationship badges (e.g. "Follows you", "Blocked") where relevant.                                                                                |
| 7.6 | Blocking hides the blocked user's content from the blocker's view where feasible.                                                                                |

## 8. Profiles

| #   | Acceptance criteria                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | Any logged-in user can view any profile: avatar, display name, bio, posts, following, followers.                                                                                                  |
| 8.2 | Users can edit their own **displayName** and **bio** only — nothing else is user-editable.                                                                                                        |
| 8.3 | Bio carries a PII reminder (demo site; keep it non-personal).                                                                                                                                     |
| 8.4 | Profile data resets nightly like everything else (see [../data/03-data-lifecycle.md](../data/03-data-lifecycle.md)).                                                                              |
| 8.5 | A demo-range username with no profile yet (never logged in since the reset) renders a "has not logged in yet" shell with next actions, not the generic 404; unknown non-demo usernames still 404. |
| 8.6 | Empty states offer the next action: your own postless profile links to the feed (composer), your empty following list explains what following does, and the empty feed points at the composer.    |     |

## 9. Search

| #   | Acceptance criteria                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| 9.1 | Full-text search over posts, available to logged-in users.                                                              |
| 9.2 | Results respect deletion: deleted posts never appear.                                                                   |
| 9.3 | Results eventually consistent with posting (index lags seconds, not minutes).                                           |
| 9.4 | Results paginate in place: the shared client-side Load more appends the next page without a full navigation (see 13.4). |

## 10. CMS content

| #    | Acceptance criteria                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.1 | About intro sections and FAQ entries are editable in the CMS (Payload) with **live preview**.                                              |
| 10.2 | Published CMS changes appear on the public pages without a deploy.                                                                         |
| 10.3 | Curated content can be promoted back to the repo as seed files so it survives resets (see [../data/02-seeding.md](../data/02-seeding.md)). |
| 10.4 | Arbitrary standalone pages can be created in the CMS (`pages` collection: kebab-case slug, title, description, ordered body sections) with drafts/versioning and live preview; each published page renders at `/<slug>` exactly like the home and About pages — no code change per page (#215). |
| 10.5 | A page slug never collides with a fixed route: the CMS rejects reserved top-level segments at save time, and the web's dynamic route treats reserved slugs as never-CMS (defence in depth). Static routes always win resolution over the dynamic `/<slug>` route. |
| 10.6 | Only published pages render publicly. Drafts are preview-only (`/<slug>?preview=<docId>`, same accepted exposure as the About preview); unknown or unpublished slugs 404. |
| 10.7 | A single-segment URL no fixed route claims resolves through the CMS page lookup before 404ing; deeper unmatched URLs keep hitting the catch-all (and its in-shell 404, 13.6). |

## 11. Admin

| #    | Acceptance criteria                                                                |
| ---- | ---------------------------------------------------------------------------------- |
| 11.1 | A Refine admin panel for the operator, not general users.                          |
| 11.2 | Moderation: delete posts and media.                                                |
| 11.3 | Inspect users (profiles, relationships).                                           |
| 11.4 | View system health (services, queues, index lag, last reset).                      |
| 11.5 | Admin actions take effect everywhere a normal delete does (feed, search, threads). |
| 11.6 | Moderation is audit-logged (who deleted what, when) and surfaced in the panel.     |
| 11.7 | The panel is unreachable without an admin role (system-admin / app-admin).         |

As built: the panel is a static SPA served under `/admin` (edge route, base
path not stripped). Sign-in is a single OIDC authorization-code + PKCE
redirect against the admin realm (ADR 0006) — the panel never sees a
password. Accounts without an admin role authenticate but are rejected at
the callback gate and by every API call (the services re-verify the role on
their internal admin endpoints — the panel gate is UX, not the boundary).

- **Posts moderation**: list with author/text/deleted-state filters;
  soft delete (restorable tombstone, the default), hard delete, restore.
  Soft-deleted posts read as 404 for users everywhere a normal delete does.
- **Media moderation**: list with owner/status filters, variant preview,
  delete — the media service cascades RustFS object deletion (original +
  variants).
- **Users**: read-only list with username filter and a follow-graph view
  (profile, counts, followers/following). The panel mutates no user content.
- **Health**: one dashboard over each service's Terminus detail (each
  service stays the authority on its own dependencies), worker metrics
  pointers (workers expose scrapes, not APIs — links to the Grafana
  dashboards when the panel is served deployed, the cluster-local ports as
  copy in local dev), and a last-reset tile over the feed service's
  reset-status record — outcome, finish time, duration, reseed fingerprint,
  or a clean "no reset recorded yet" state before the environment's first
  reset run (feature 12).
- **Audit log**: merged view of the posts/media audit stores, newest first.

## 12. Data lifecycle

| #    | Acceptance criteria                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1 | Nightly wipe at a configurable time (default 00:30 UTC) of all user data.                                                               |
| 12.2 | Optional deterministic reseed immediately after the wipe (same corpus every time — see [../data/02-seeding.md](../data/02-seeding.md)). |
| 12.3 | Reset and reseed status is visible (admin health + user-facing notice).                                                                 |
| 12.4 | Curated (promoted) content survives resets.                                                                                             |

As built: the reset job writes its run record (outcome, timing, reseed
fingerprint, per-step durations) to Valkey after every attempt — success or
failure. The feed service serves it to the admin panel at
`GET /api/feed/internal/admin/reset-status` (admin-principal-gated; the
machine-readable path stays at `/api/feed/internal/reset-status`), and the
panel's health dashboard renders it as the data lifecycle tile: outcome
badge, finish time (relative + UTC), duration, reseed state and seed
fingerprint — or "no reset recorded yet" on an environment that has not run
a reset (a fresh local stack seeds directly, without a reset run).

## 13. App shell (authenticated navigation)

| #    | Acceptance criteria                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13.1 | The authenticated shell's navigation is visually distinct from body content: icon'd links, brand set apart from destinations.                                                                                                                 |
| 13.2 | The current page is marked in the navigation (`aria-current` + styling) on every destination that has a nav entry.                                                                                                                            |
| 13.3 | On small screens a burger opens a drawer with the same navigation; search stays reachable (drawer link + header icon) even where the search box hides.                                                                                        |
| 13.4 | Every cursor-paginated list (feed, search, bookmarks, profile posts and follow lists, reply threads) uses one shared Load more that appends pages in place - no full-page cursor navigation, one `load-more` affordance everywhere.           |
| 13.5 | One labelled search input per page: the header box hides itself on /search, where the page's own box is the single input.                                                                                                                     |
| 13.6 | Every 404 inside the app - unmatched multi-segment routes, deleted or malformed posts/profiles - renders within the authenticated shell, so nav, search and logout stay available; signed-out visitors get the same branded 404 body, not a login redirect. Unknown single-segment URLs resolve through the CMS page lookup first (#215) and 404 on the public frame - page URLs are public content. |

## 14. Branding

| #    | Acceptance criteria                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1 | The brand mark is a white ✕ on an indigo→cyan (135°) rounded square - the wordmark's gradient. Its geometry lives in one place, `apps/web/scripts/generate-brand-icons.ts`, so every size regenerates from it. |
| 14.2 | The web app ships the mark via App Router conventions (`app/icon.svg` + `app/icon.png`, `app/apple-icon.png`) and a manifest with 192/512 icons; regenerate with `npm run icons` (workspace `web`).            |
| 14.3 | Secondary surfaces reuse the same mark: the admin panel links `public/brand-mark.svg`, and the CMS admin panel's favicon points at its copy (basePath included, since the URL bypasses app-router resolution). |
