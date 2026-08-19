# 03 · Service Interfaces

The API contract. **Source of truth:** request/response schemas are defined as zod schemas in the shared contracts package (`@xitter/api-contracts`) and compiled into per-service OpenAPI documents (`npm run openapi:gen`, artifacts in [openapi/](openapi/)). This document is the human-readable contract; where prose and schema disagree, the schema wins.

## Conventions

| Concern         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioning      | Public routes are versioned: `/api/{service}/v1/...`. Breaking changes ship as `/v2` alongside `/v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Internal routes | `/api/{service}/internal/...`, no version segment — they evolve in lockstep with their in-monorepo callers (workers, reset job).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Format          | JSON request/response bodies; `Content-Type: application/json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Errors          | Single shape: `{ "error": { "code": string, "message": string, "details": object? } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pagination      | Cursor-based: request takes `cursor?` and `limit?`; response is `{ "items": [...], "nextCursor": string? }` — `nextCursor` absent/null means end. Cursors are opaque; ordering is stable per endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Timestamps      | ISO-8601 UTC with `Z` suffix (e.g. `2026-08-15T09:30:00.000Z`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Validation      | Every request body/query is parsed with the service's zod schema; failures return `400 VALIDATION_ERROR` with field-level `details`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Auth            | `user` = Bearer user access token (demo realm, issued to the `web` client). `service` = client-credentials service token whose audience is the receiving service's client id (`svc-social`, `svc-posts`, `svc-media`, `svc-feed`, `svc-search`); machine callers are the five services plus `svc-worker-fanout`, `svc-worker-media-process`, `svc-worker-search-index`, and `svc-reset` (scoped audiences, provisioned by `packages/scripts/src/keycloak.ts`). In-cluster the edge validates user tokens and injects identity headers; locally services validate Bearer tokens directly — see [07-security.md](07-security.md). |

Standard error codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403, incl. block violations), `NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `INTERNAL` (500).

## social — profiles, follows, blocks

Owns prefix `/api/social`. Profile `id` equals the Keycloak user id.

| Method | Path                              | Auth | Description                                                   | Key fields                                     |
| ------ | --------------------------------- | ---- | ------------------------------------------------------------- | ---------------------------------------------- |
| POST   | `/v1/profiles/:id`                | user | Upsert own profile (`:id` = caller; idempotent)               | req `displayName?`, `bio?` → res `200` profile |
| GET    | `/v1/profiles/:id`                | user | Fetch profile by id                                           | res profile + counts                           |
| GET    | `/v1/profiles/username/:username` | user | Resolve profile by username                                   | res profile                                    |
| PATCH  | `/v1/profiles/:id`                | user | Update own profile (partial; `:id` = caller)                  | req partial profile → res profile              |
| POST   | `/v1/profiles/:id/follow`         | user | Follow target; rejected if blocked either way                 | res `204`                                      |
| DELETE | `/v1/profiles/:id/follow`         | user | Unfollow target (idempotent)                                  | res `204`                                      |
| POST   | `/v1/profiles/:id/block`          | user | Block target (cascades away any follow, both directions)      | res `204`                                      |
| DELETE | `/v1/profiles/:id/block`          | user | Unblock target (idempotent; does not restore removed follows) | res `204`                                      |
| GET    | `/v1/profiles/:id/relationship`   | user | Caller↔target relationship (following, followed-by, blocked)  | res relationship flags                         |
| GET    | `/v1/profiles/:id/following`      | user | Cursor list of profiles the target follows                    | paginated profiles                             |
| GET    | `/v1/profiles/:id/followers`      | user | Cursor list of the target's followers                         | paginated profiles                             |

## posts — posts, replies, interactions

Owns prefix `/api/posts`.

| Method | Path                               | Auth | Description                                                                                                                                                                                                                                                                                                                                                        | Key fields                                       |
| ------ | ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| POST   | `/v1/posts`                        | user | Create post. `text` required (1–512 chars); `mediaIds` optional (max 4, each validated for existence, ownership and `ready` status via the media internal lookup — rejected 400 `invalidMediaIds` otherwise); `replyToId` optional — rejected 403 when a block exists between replier and parent author (either direction), 404 when the parent is missing/deleted | req `text`, `mediaIds?`, `replyToId?` → res post |
| DELETE | `/v1/posts/:id`                    | user | Delete own post (author only; soft delete → hidden everywhere, repeat delete reads 404)                                                                                                                                                                                                                                                                            | res `204`                                        |
| GET    | `/v1/posts/:id`                    | user | Fetch post (hydrated); deleted posts 404                                                                                                                                                                                                                                                                                                                           | res post                                         |
| GET    | `/v1/users/:id/posts`              | user | Cursor list of author's posts (incl. replies), newest first, deleted excluded                                                                                                                                                                                                                                                                                      | paginated posts                                  |
| GET    | `/v1/posts/:id/replies`            | user | Cursor list of replies to a post, chronological (oldest first)                                                                                                                                                                                                                                                                                                     | paginated posts                                  |
| POST   | `/v1/posts/:id/interactions`       | user | Interact: `{kind: like\|bookmark\|repost}`. Rejected if caller is blocked by the post author (#8)                                                                                                                                                                                                                                                                  | req `kind` → res interaction                     |
| DELETE | `/v1/posts/:id/interactions/:kind` | user | Remove own interaction (#8)                                                                                                                                                                                                                                                                                                                                        | res `204`                                        |
| GET    | `/v1/bookmarks`                    | user | Cursor list of caller's bookmarked posts (#8)                                                                                                                                                                                                                                                                                                                      | paginated posts                                  |

Post payloads carry a counts read-model (`replies/likes/reposts`, zero-initialised; replies maintained by posts, likes/reposts by #8) and `media`: a snapshot of the attached ready assets (variant kind + `/media` URL) taken at creation. Authors are not embedded in posts responses - callers join profiles through social (the web does this until #7's server-side joins).

## media — uploads and variants

Owns prefix `/api/media`. Binaries never transit the service: the browser PUTs directly to RustFS via presigned URL.

| Method | Path                     | Auth | Description                                                                                                                                                               | Key fields                                           |
| ------ | ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/v1/uploads`            | user | Request an upload slot; returns presigned PUT URL (RustFS)                                                                                                                | req `mimeType`, `bytes` → res `mediaId`, `uploadUrl` |
| POST   | `/v1/media/:id/complete` | user | Client callback after the browser PUT; server HEADs the exact key and re-verifies size + stored content type before emitting `media.media.uploaded` (idempotent on retry) | res media                                            |
| GET    | `/v1/media/:id`          | user | Media metadata incl. variant URLs (`original`, `thumb`) served from `/media`                                                                                              | res media + variants                                 |

Allowed types `png/jpeg/webp/gif`, max 5MB per file, max 4 media per post. Slot creation enforces the allowlist (415) and size cap (413); completion re-verifies the object's real size and stored content type (rejected uploads are marked `failed` and their object deleted — the bucket is public). Posts re-enforce the 4-per-post cap and `ready` status at creation via the media internal lookup.

## feed — home timeline

Owns prefix `/api/feed`. Content rule: only posts from followed authors plus the caller's own posts, most recent first.

| Method | Path       | Auth | Description                                                                                           | Key fields                                              |
| ------ | ---------- | ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/v1/feed` | user | Materialised home timeline; entries joined server-side with social (profiles) and posts (post bodies) | req `cursor?`, `limit?` → paginated hydrated feed items |

### WebSocket contract

| Aspect           | Contract                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL              | `wss://{host}/api/feed/v1/ws?token={accessToken}` (token as query param; in-cluster the feed service receives the edge-validated identity on upgrade) |
| Direction        | Server → client notifications **only**                                                                                                                |
| Messages         | `{ "type": "feed.new-items", "count": number }` — count of new items since the last delivered notification                                            |
| Client behaviour | On receipt, refetch `GET /v1/feed`; the server never pushes post payloads over the socket                                                             |
| Liveness         | Server pings every 30s; clients reconnect with exponential backoff and resubscribe                                                                    |
| Delivery         | At-most-once per connection; a missed notification is recovered by the next refetch/poll — notifications are a UX hint, not a data channel            |

## search

Owns prefix `/api/search`.

| Method | Path               | Auth | Description           | Key fields                                     |
| ------ | ------------------ | ---- | --------------------- | ---------------------------------------------- |
| GET    | `/v1/search/posts` | user | Full-text post search | req `q`, `cursor?`, `limit?` → paginated posts |

## Internal endpoints

Service-token only (audience = receiving service client id; callers are the `svc-*` services, the `svc-worker-*` worker clients, and `svc-reset`). Never edge-exposed beyond the namespace; see [07-security.md](07-security.md).

| Path                                                        | Caller               | Purpose                                                         |
| ----------------------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `GET /api/social/internal/users/:id/followers/ids`          | fanout worker        | Follower id list for feed fanout                                |
| `GET /api/social/internal/users/:id/relationships/:otherId` | posts, workers       | Blocked-either-way check for write-path enforcement             |
| `GET /api/social/internal/users/:id/blocked/ids`            | feed, search         | Blocked-id list for timeline/index filtering                    |
| `POST /api/posts/internal/reseed`                           | reset job            | Truncate + optional deterministic reseed of posts data          |
| `POST /api/media/internal/media/lookup`                     | posts                | Resolve media ids for attachment (existence, ownership, ready)  |
| `GET /api/media/internal/media/:id`                         | media-process worker | Asset incl. storage coordinates (redelivery idempotency checks) |
| `POST /api/media/internal/media/:id/variants`               | media-process worker | Record processed variants for a media object                    |
| `POST /api/media/internal/media/:id/failure`                | media-process worker | Record a failed processing attempt (service caps attempts)      |
| `POST /api/media/internal/reseed`                           | reset job            | Truncate media metadata + trigger bucket wipe support           |
| `POST /api/feed/internal/feed/entries`                      | fanout worker        | Bulk insert feed entries (idempotent upsert)                    |
| `DELETE /api/feed/internal/feed/users/:id`                  | reset job / fanout   | Delete all feed entries for a user                              |
| `POST /api/feed/internal/reseed`                            | reset job            | Truncate feed entries                                           |
| `POST /api/search/internal/search/index`                    | search-index worker  | Bulk upsert of post documents                                   |
| `DELETE /api/search/internal/search/index`                  | reset job            | Clear the posts index                                           |
| `POST /api/search/internal/reseed`                          | reset job            | Truncate search service state                                   |
| `POST /api/social/internal/reseed`                          | reset job            | Truncate + optional reseed of profiles/graph                    |

Reset semantics (what "reseed" means, ordering, determinism) are specified in [05-data-platform.md](05-data-platform.md); the runbook lives in the [operations specs](../operations/).
