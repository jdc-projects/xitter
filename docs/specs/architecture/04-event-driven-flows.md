# 04 · Event-Driven Flows

Kafka is the only asynchronous integration mechanism between services and workers: producers emit domain events, workers consume them and call back through internal APIs. No service calls another service's write path synchronously.

## Topics

| Topic              | Producer | Partitions | Retention | Partition key                                          |
| ------------------ | -------- | ---------- | --------- | ------------------------------------------------------ |
| `xitter.posts.v1`  | posts    | 6          | 7d        | `postId` (interaction events: `postId`)                |
| `xitter.social.v1` | social   | 6          | 7d        | acting user (`followerId` / `blockerId` / `profileId`) |
| `xitter.media.v1`  | media    | 6          | 7d        | `mediaId`                                              |

Partition keys preserve per-aggregate ordering (a post's lifecycle, a user's graph changes, a media object's processing) — consumers must not assume cross-partition ordering. Producers thread the aggregate id (`postId`, acting user, `mediaId`) through `EventProducer.emit` as the Kafka message key; events emitted without a key fall back to the event type, which orders only per event type.

## Envelope

Every message is JSON with a single envelope; consumers validate it at the boundary. Delivery is **at-least-once**; consumers must be idempotent (rules below).

| Field          | Type         | Rule                                                     |
| -------------- | ------------ | -------------------------------------------------------- |
| `eventId`      | uuid v4      | Unique per event; the idempotency key                    |
| `eventType`    | string       | Dotted name from the catalogue below                     |
| `eventVersion` | int          | Payload schema version, starts at `1`                    |
| `producer`     | string       | Emitting service name (e.g. `posts`)                     |
| `occurredAt`   | ISO-8601 UTC | Domain time of occurrence                                |
| `payload`      | object       | Per-eventType schema (zod, in the shared events package) |

```json
{
  "eventId": "8f14e45f-ceea-4b1f-9a3d-1d64f6cd7a11",
  "eventType": "posts.post.created",
  "eventVersion": 1,
  "producer": "posts",
  "occurredAt": "2026-08-15T09:30:00.123Z",
  "payload": {
    "postId": "c2d1e000-0000-4000-8000-000000000001",
    "authorId": "demo3",
    "text": "hello xitter",
    "mediaIds": [],
    "replyToId": null,
    "createdAt": "2026-08-15T09:30:00.123Z"
  }
}
```

## Event catalogue

| eventType                   | Topic              | Payload fields                                                                                      | Emitted when                                                                         |
| --------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `posts.post.created`        | `xitter.posts.v1`  | `postId`, `authorId`, `text`, `mediaIds[]`, `replyToId?`, `repostOfId?`, `createdAt`                | Post created (top-level or reply)                                                    |
| `posts.post.deleted`        | `xitter.posts.v1`  | `postId`, `authorId`, `deletedAt`                                                                   | Post deleted by author                                                               |
| `posts.interaction.created` | `xitter.posts.v1`  | `interactionId`, `postId`, `userId`, `kind`, `createdAt`                                            | like/bookmark/repost added                                                           |
| `posts.interaction.deleted` | `xitter.posts.v1`  | `postId`, `userId`, `kind`, `deletedAt`                                                             | Interaction removed                                                                  |
| `social.follow.created`     | `xitter.social.v1` | `followerId`, `followeeId`, `createdAt`                                                             | Follow established                                                                   |
| `social.follow.deleted`     | `xitter.social.v1` | `followerId`, `followeeId`, `deletedAt`                                                             | Unfollowed                                                                           |
| `social.block.created`      | `xitter.social.v1` | `blockerId`, `blockedId`, `createdAt`                                                               | Block established                                                                    |
| `social.block.deleted`      | `xitter.social.v1` | `blockerId`, `blockedId`, `deletedAt`                                                               | Block removed                                                                        |
| `social.profile.updated`    | `xitter.social.v1` | `profileId`, `username`, `displayName`, `bio`, `updatedAt`                                          | Own profile created (login bootstrap) or edited (name/bio)                           |
| `media.media.uploaded`      | `xitter.media.v1`  | `mediaId`, `ownerId`, `objectKey`, `mimeType`, `bytes`, `createdAt`                                 | Completion verified the object (HEAD) — key, size and stored content type re-checked |
| `media.media.processed`     | `xitter.media.v1`  | `mediaId`, `ownerId`, `variants[] {kind, objectKey, mimeType, bytes, width, height}`, `processedAt` | Variants (`original`, `thumb`) written and recorded                                  |

## Flows

### Post creation → fanout → feed materialisation + WebSocket notify

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as web
    participant P as posts
    participant K as Kafka
    participant F as fanout (worker)
    participant S as social
    participant FD as feed
    participant V as Valkey

    B->>W: compose post
    W->>P: POST /api/posts/v1/posts
    P->>P: validate (text, media refs) + persist
    P-->>W: 201 post
    P->>K: posts.post.created
    K->>F: consume
    F->>S: GET /internal/users/:authorId/followers/ids
    S-->>F: follower ids
    F->>FD: POST /internal/feed/entries (author + followers, bulk upsert)
    FD->>V: PUBLISH feed:updates:{userId} per affected user
    V-->>FD: fan-out to feed replicas
    FD-->>B: ws push {type:"feed.new-items", count}
    B->>W: refetch GET /api/feed/v1/feed
```

### Media upload → processing → post referencing media

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as web
    participant M as media
    participant R as RustFS
    participant K as Kafka
    participant MP as media-process (worker)
    participant P as posts

    B->>W: pick image
    W->>M: POST /v1/uploads {mimeType, bytes}
    M-->>W: {mediaId, uploadUrl}
    W->>B: presigned URL
    B->>R: PUT object (direct)
    B->>M: POST /v1/media/:id/complete (via web)
    M->>R: HEAD exact key (size + stored content type re-verified)
    M->>K: media.media.uploaded
    K->>MP: consume (skip if already ready/failed)
    MP->>R: GET original, generate thumb, PUT variants
    MP->>M: POST /internal/media/:id/variants
    M->>K: media.media.processed
    Note over B,P: browser may now attach mediaId to a post
    B->>W: create post with mediaIds
    W->>P: POST /v1/posts (media validated: owner, ready, type, size, ≤4)
```

### Follow → timeline backfill

```mermaid
sequenceDiagram
    participant U as Browser
    participant S as social
    participant K as Kafka
    participant F as fanout (worker)
    participant P as posts
    participant FD as feed

    U->>S: POST /v1/profiles/:id/follow
    S->>S: persist follow (block checks)
    S->>K: social.follow.created
    K->>F: consume
    F->>P: POST /internal/posts/by-author (bounded window, newest first)
    P-->>F: recent posts
    F->>FD: POST /internal/feed/entries (bulk upsert for follower)
    FD-->>U: ws {type:"feed.new-items", count}
```

Unfollow (`social.follow.deleted`) removes the followee's entries from the follower's feed via the feed internal API (`DELETE /internal/feed/users/:followerId/authors/:followeeId`). Follow backfill copies the followee's **20 most recent posts** (`POST /api/posts/internal/posts/by-author` — workers hold service tokens, the public timeline requires a user token; bounded window; a full historical rebuild is a reset concern, not a runtime one). **Blocks are different — explicit product decision:** `social.block.*` prevents _future_ interactions (likes, reposts, replies, follows on the blocker's content, enforced at write time); **historical feed entries are not rewritten and remain until the nightly reset.** Block events therefore have no feed consumer; blocked authors are filtered at feed read time instead.

### Search indexing

```mermaid
sequenceDiagram
    participant P as posts
    participant K as Kafka
    participant SI as search-index (worker)
    participant SE as search
    participant OS as OpenSearch

    P->>K: posts.post.created / posts.post.deleted
    K->>SI: consume (batch)
    SI->>SI: batch + dedupe by postId
    SI->>SE: POST /internal/search/index (upserts) / DELETE docs
    SE->>OS: _bulk upsert/delete by postId
```

## Consumer groups

Group ids live in `CONSUMER_GROUPS` (`packages/events/src/topics.ts`); the nightly reset recreates them (see [05-data-platform.md](05-data-platform.md)).

| Group                         | Worker        | Topics                                | Notes                                                              |
| ----------------------------- | ------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `xitter-fanout-worker`        | fanout        | `xitter.posts.v1`, `xitter.social.v1` | Feed materialisation + backfill/removal                            |
| `xitter-media-process-worker` | media-process | `xitter.media.v1`                     | Only `media.media.uploaded` is actionable                          |
| `xitter-search-index-worker`  | search-index  | `xitter.posts.v1`                     | Only `posts.post.*` are actionable; batches for `_bulk` efficiency |

Groups (and topic data) are deleted and recreated by the nightly reset — see [05-data-platform.md](05-data-platform.md).

## Idempotency rules

At-least-once delivery means every flow below must tolerate redelivery:

1. **eventId dedupe** — each worker persists processed `eventId`s (store with retention ≥ topic retention, 7d) and skips already-seen events before doing side-effectful work.
2. **Natural-key upserts** — all writes are idempotent on business keys, so a replay after a crash converges:
   - feed entries: unique `(userId, postId, reason)` — insert on conflict do nothing (repostedById is excluded because Postgres treats NULLs as distinct in unique indexes)
   - search documents: upsert keyed by `postId`; deletes are tombstones (`deletedAt`)
   - media variants: variant writes keyed by `(mediaId, kind)` — regeneration overwrites
3. **No read-modify-write races** — counters and variant state use atomic upserts; consumers never rely on event ordering across partitions.
