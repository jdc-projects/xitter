# Features

Acceptance-style catalogue of every user-facing feature area. "Must" = required for the feature to be considered done. System behaviour is the desired end-state, not the current state; data plumbing details live in [../data/01-storage-model.md](../data/01-storage-model.md) and [../data/03-data-lifecycle.md](../data/03-data-lifecycle.md).

## 1. Landing page

| #   | Acceptance criteria                                                                              |
| --- | ------------------------------------------------------------------------------------------------ |
| 1.1 | Public (unauthenticated). Serves as the site's front door with a short intro managed in the CMS. |
| 1.2 | Shows an **unmissable reset notice**: all data is wiped nightly (default 00:00 UTC).             |
| 1.3 | Links to the About page (which includes the FAQ section).                                        |
| 1.4 | Provides a clear path to login. No user-generated content is visible.                            |

## 2. About page

| #   | Acceptance criteria                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Public. Always referred to as the "About page" in UI copy (it contains an FAQ section but is never called a "FAQ page").  |
| 2.2 | Explains what xitter is, why it exists, and how it works (microservices demo).                                            |
| 2.3 | Documents the data reset, including the schedule (nightly, default 00:00 UTC) and that reseed may restore a fixed corpus. |
| 2.4 | Lists demo credentials (`demo1`..`demo10` / `DemoPass123!`).                                                              |
| 2.5 | Contains an FAQ section with entries managed in the CMS.                                                                  |
| 2.6 | Carries the PII warning: do not enter personal or sensitive data.                                                         |

## 3. Auth

| #   | Acceptance criteria                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Login with demo accounts only. No signup, no password change, no account management.                                         |
| 3.2 | Login form is protected by a Cap.js captcha.                                                                                 |
| 3.3 | Unauthenticated visitors can only reach landing + About; any user-generated content (feeds, profiles, posts) requires login. |
| 3.4 | Logout works from anywhere in the app and returns the visitor to the landing page.                                           |
| 3.5 | Invalid credentials show a generic error without revealing whether username or password failed.                              |

## 4. Posts

| #   | Acceptance criteria                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Create a post with **required** text of 1–512 characters and **optional** images.                                                                                                                                   |
| 4.2 | Images: png, jpeg, webp, gif; ≤5 MB each; ≤4 per post. Over-limit is rejected with a clear message.                                                                                                                 |
| 4.3 | Every post shows its author and an accurate timestamp.                                                                                                                                                              |
| 4.4 | Timestamps in lists use relative format when <24 h old, **rounded to the most significant figure** (e.g. `1h`, not `1h 20m`; `5m`; `2d` boundary per feed rules below); absolute `D MMM YYYY HH:mm` when ≥24 h old. |
| 4.5 | Authors can delete their own posts; deleted posts (and their media) disappear from feeds, profiles, threads, and search.                                                                                            |
| 4.6 | Validation errors (empty text, >512 chars, too many/too large images) never lose the user's draft.                                                                                                                  |
| 4.7 | X-style keyboard: **Enter posts** (attachments upload first); **Shift+Enter inserts a newline**.                                                                                                                    |

## 5. Feed

| #   | Acceptance criteria                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Shows only posts from followed accounts plus the user's own posts — nothing else.                                                            |
| 5.2 | Ordered most recent first.                                                                                                                   |
| 5.3 | Timestamp format: relative (<24 h) rounded to the most significant figure (e.g. `1h`, not `1h 20m`); absolute `D MMM YYYY HH:mm` when older. |
| 5.4 | Paginated (cursor-based; no gaps or duplicates across pages).                                                                                |
| 5.5 | Near-real-time: new posts, replies, and interactions arrive via websocket notifications without a manual refresh.                            |
| 5.6 | Reposts surface in the follower's feed attributed to the reposter, showing the original post.                                                |

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

| #   | Acceptance criteria                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------- |
| 8.1 | Any logged-in user can view any profile: avatar, display name, bio, posts, following, followers.                     |
| 8.2 | Users can edit their own **displayName** and **bio** only — nothing else is user-editable.                           |
| 8.3 | Bio carries a PII reminder (demo site; keep it non-personal).                                                        |
| 8.4 | Profile data resets nightly like everything else (see [../data/03-data-lifecycle.md](../data/03-data-lifecycle.md)). |

## 9. Search

| #   | Acceptance criteria                                                           |
| --- | ----------------------------------------------------------------------------- |
| 9.1 | Full-text search over posts, available to logged-in users.                    |
| 9.2 | Results respect deletion: deleted posts never appear.                         |
| 9.3 | Results eventually consistent with posting (index lags seconds, not minutes). |

## 10. CMS content

| #    | Acceptance criteria                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.1 | Landing intro and FAQ entries are editable in the CMS (Payload) with **live preview**.                                                     |
| 10.2 | Published CMS changes appear on the public pages without a deploy.                                                                         |
| 10.3 | Curated content can be promoted back to the repo as seed files so it survives resets (see [../data/02-seeding.md](../data/02-seeding.md)). |

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
  links (workers expose scrapes, not APIs), and a last-reset tile —
  reported as "pending" until the reset status feed lands (feature 12).
- **Audit log**: merged view of the posts/media audit stores, newest first.

## 12. Data lifecycle

| #    | Acceptance criteria                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1 | Nightly wipe at a configurable time (default 00:00 UTC) of all user data.                                                               |
| 12.2 | Optional deterministic reseed immediately after the wipe (same corpus every time — see [../data/02-seeding.md](../data/02-seeding.md)). |
| 12.3 | Reset and reseed status is visible (admin health + user-facing notice).                                                                 |
| 12.4 | Curated (promoted) content survives resets.                                                                                             |
