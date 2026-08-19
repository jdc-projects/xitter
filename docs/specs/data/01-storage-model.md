# Storage Model

Per-service data ownership. Each service owns exactly one store and is the only reader/writer of it — no cross-service database access, ever. Cross-service consistency happens via events (see [03-data-lifecycle.md](./03-data-lifecycle.md)).

## Ownership matrix

| Domain                    | Owning service | Store                                             | Notes                                                                                 |
| ------------------------- | -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Profiles, follows, blocks | social         | Postgres (`social`)                               | Identity-adjacent data; user info itself lives in Keycloak                            |
| Posts, interactions       | posts          | Postgres (`posts`)                                | Source of truth for posts, replies, likes, bookmarks, reposts                         |
| Media assets              | media          | Postgres (`media`) + RustFS bucket `xitter-media` | Objects keyed `{userId}/{mediaId}/{original\|thumb}.{ext}`                            |
| Feed entries              | feed           | Postgres (`feed`)                                 | Materialised per-user timeline, event-fed                                             |
| Search                    | search         | Postgres (`search`) + OpenSearch `posts` index    | Postgres holds only checkpoints; OpenSearch holds the index                           |
| Site content              | cms (Payload)  | Postgres (`cms`)                                  | Payload-managed tables: landing intro, FAQ entries, users/sessions for the CMS itself |

Shared, non-service-owned stores: Kafka (event bus), Valkey (ephemeral: ws pub/sub, rate limits — never a source of truth), Keycloak (identity).

## Per-service ER

### social

```mermaid
erDiagram
    Profile ||--o{ Follow : "follower"
    Profile ||--o{ Follow : "followee"
    Profile ||--o{ Block : "blocker"
    Profile ||--o{ Block : "blocked"
    Profile {
        string id PK "Keycloak sub"
        string username UK
        string displayName
        string bio "nullable"
        datetime createdAt
    }
    Follow {
        string id PK
        string followerId FK
        string followeeId FK
        datetime createdAt
    }
    Block {
        string id PK
        string blockerId FK
        string blockedId FK
        datetime createdAt
    }
```

Uniques: `Follow(followerId, followeeId)`, `Block(blockerId, blockedId)`. The profile row is keyed by the Keycloak `sub` itself (no separate user id); `username` is unique and mirrors the Keycloak `preferred_username`.

### posts

```mermaid
erDiagram
    Post ||--o{ Post : "replyTo (self-relation)"
    Post ||--o{ Interaction : ""
    Post {
        string id PK
        string authorId FK "Profile via social"
        string text "1-512 chars"
        string[] mediaIds "uuid refs into media (validated ready at create)"
        json media "ready-asset snapshot taken at creation"
        string replyToId FK "nullable"
        string repostOfId FK "nullable"
        datetime createdAt
        datetime deletedAt "nullable - soft delete"
        int replyCount "read-model, 0 at create"
        int likeCount "read-model, 0 at create - maintained by #8"
        int repostCount "read-model, 0 at create - maintained by #8"
    }
    Interaction {
        string id PK
        string kind "like|bookmark|repost"
        string postId FK
        string userId
        datetime createdAt
    }
```

Unique: `Interaction(kind, postId, userId)` — one of each kind per user per post. Replies are posts (self-relation); the counts read-model lives on the post row — replies maintain `replyCount` transactionally in the posts service, likes/reposts move `likeCount`/`repostCount` in the **same transaction** as the interaction row (create + increment or delete + decrement, with `ON CONFLICT DO NOTHING` absorbing concurrent duplicates), so counts cannot drift from the rows. Bookmarks maintain no counter (private annotations). Deleting is soft (`deletedAt` set); deleted posts are excluded from every read path (timelines, threads, lookups, bookmarks) but rows persist for interaction accounting. Undo of any interaction is never block-checked — it removes the caller's own footprint.

### media

```mermaid
erDiagram
    MediaAsset {
        string id PK
        string ownerId "uploading user"
        string objectKey "{ownerId}/{id}/original.{ext}"
        string mimeType "png|jpeg|webp|gif"
        int bytes "<= 5MB, HEAD-verified at completion"
        string status "pending|ready|failed"
        json variants "[] until processed: kind, objectKey, mime, bytes, width, height"
        int attempts "worker failures; 3 -> failed"
        datetime uploadedAt "nullable - set when completion verified"
        datetime createdAt
    }
```

Assets are never foreign-keyed to posts: attachment is validated at post creation (existence, ownership, `ready`) via the media internal API, and the post row stores a snapshot of the ready asset's variants so reads render without a media round-trip. Variants are immutable once recorded, so the snapshot cannot drift.

### feed

```mermaid
erDiagram
    FeedEntry {
        string id PK
        string userId "feed owner"
        string postId
        string authorId "hydrated from posts/social at read time"
        string reason "post | repost"
        string repostedById "nullable - set on repost entries"
        string entryKey "derived: post:{postId} | repost:{postId}:{repostedById}"
        datetime postCreatedAt "ordering key (post/interaction time)"
        datetime insertedAt "materialisation time"
    }
```

Unique: `FeedEntry(userId, entryKey)` — idempotent event application. `entryKey` is the derived identity of the fanning-out source: `post:{postId}` for post entries, `repost:{postId}:{repostedById}` for repost entries (computed by `feedEntryKey` in `@xitter/api-contracts`, shared by the fanout worker and this service). **Why a derived column instead of keying on `(userId, postId, reason)` + `repostedById`:** a post reposted by two different users fans out to two distinct entries per feed, so the reposter must participate in the key — but `repostedById` is NULL for `reason = 'post'` rows, and Postgres unique indexes treat NULLs as distinct, which would defeat replay idempotency exactly where it matters most. A NOT NULL derived string sidesteps the NULL problem entirely while staying a single-column key member. On repost entries `authorId` is the reposter (the feed-surface author, so unfollow removes their reposts too) and `postCreatedAt` is the repost time — reposts arrive as fresh feed items; the same post may therefore appear twice in one feed (once as a post, once as a repost), which is accepted display behaviour. Undo deletes by `(postId, reason, repostedById)`; post deletion deletes by `postId` (posts and reposts together). Entries store ids + ordering columns only — post bodies and author profiles are hydrated server-side from posts/social on read (`GET /v1/feed`). Deleted posts drop out at hydration; blocked authors are filtered at query time, and reposts whose **original** author is blocked drop out at hydration (rows persist until the nightly reset, per the block product decision).

### search

```mermaid
erDiagram
    SearchCheckpoint {
        string id PK
        string consumerKey UK "per consumer"
        string topicPartition "topic:partition"
        string offset
        datetime updatedAt
    }
```

The OpenSearch `posts` index is derived data, fully rebuildable from `posts` events.

### cms

Payload-managed tables (schema owned by Payload collections/migrations): landing intro content, FAQ entries (question, answer, order), and Payload's own admin users/sessions. No product services read this DB directly; the web app reads via the CMS API.

## Field-level tables

Field tables above (types/constraints inline in each ER diagram) are normative. Additional constraints:

- All ids are string (ULID/UUID) primary keys.
- All `createdAt` are set by the owning service; no client-supplied timestamps.
- `Post.text` is 1–512 chars, enforced at the API boundary and in the schema.
- `Post.mediaIds` reference media assets by uuid; at post creation each must exist, belong to the author and be `ready` (checked via the media internal lookup — see [../architecture/03-service-interfaces.md](../architecture/03-service-interfaces.md)). The row also stores a `media` JSON snapshot of the resolved assets.
- `MediaAsset.bytes` ≤ 5 MB: claimed at slot creation and re-verified against the object's real size (plus stored content type) when completion HEADs the key — client claims are never trusted.

## Index strategy

| Store      | Indexes (beyond PKs/uniques)                                                                         | Serves                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| social     | `Follow(followeeId)`, `Block(blockedId)`                                                             | Followers lists; block checks on write paths                                                 |
| posts      | `Post(authorId, createdAt desc)`, `Post(replyToId)`, `Interaction(userId, kind)`                     | Profiles, threads, bookmarks list (userId+kind prefix covers the newest-first bookmark walk) |
| media      | `MediaAsset(ownerId)`, `MediaAsset(status)`                                                          | Owner lookups (attach validation); pending/failed cleanup                                    |
| feed       | `FeedEntry(userId, postCreatedAt desc, id desc)`, `FeedEntry(postId)`, `FeedEntry(userId, authorId)` | The feed page itself (keyset, newest first); deletion fan-out; unfollow cleanup              |
| search     | checkpoint lookups by consumerKey                                                                    | Resume position                                                                              |
| OpenSearch | standard text index on posts                                                                         | Full-text search                                                                             |

Guideline: index for the read patterns in the product flows ([../product/03-user-flows.md](../product/03-user-flows.md)); add indexes with evidence, not speculation.

## Migration policy

- Prisma per service (`prisma migrate`); one migration history per service DB.
- Migrations are reviewed in PRs like code — no autogenerate-and-ship without review.
- Applied at deploy time by the service's deploy pipeline, before the service accepts traffic.
- Never edit an applied migration; always add a new one.
- Seeds and resets are separate concerns (see [02-seeding.md](./02-seeding.md), [03-data-lifecycle.md](./03-data-lifecycle.md)) — migrations must not seed.
