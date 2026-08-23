# User Flows

Step-by-step flows with diagrams, including error and edge cases. Acceptance criteria for each feature live in [02-features.md](./02-features.md); this doc covers the _sequence_ of interactions.

## 1. First-time visitor

```mermaid
sequenceDiagram
    participant V as Visitor
    participant W as Web
    V->>W: GET /
    W-->>V: Landing page: public header (home / About / Log in), hero with CMS intro, reset notice, demo credentials, under-the-hood stack strip
    V->>W: GET /about
    W-->>V: About page: what/why/how, reset schedule, demo credentials, FAQ, PII warning
    Note over V,W: Any attempt to open /feed, /post, /profile/* etc. redirects to login
```

Edge cases: deep links to user content while unauthenticated → redirect to login, then return to the target after successful login.

## 2. Login

```mermaid
flowchart TD
    A[Login form] --> B{Cap.js captcha solved?}
    B -- no --> B1[Block submission, retry captcha]
    B -- yes --> C{Credentials valid?}
    C -- no --> E[Generic error:\nnothing reveals which field failed]
    E --> A
    C -- yes --> D[Establish session]
    D --> F{Intended destination?}
    F -- deep link --> G[Redirect there]
    F -- none --> H[Feed]
```

Failure states: invalid demo username, wrong password, captcha failure/expiry, session expiry mid-use (re-authenticate and resume).

## 3. Posting with image

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web
    participant P as Posts svc
    participant M as Media svc
    U->>W: Compose: text + optional image files
    W->>W: Client-side validation (text 1–512 chars, ≤4 images, ≤5 MB each, png/jpeg/webp/gif)
    alt invalid
        W-->>U: Inline errors, draft preserved
    else valid
        loop per image
            W->>M: Upload
            M-->>W: MediaAsset (pending)
        end
        W->>P: Create post (text + media ids)
        P-->>W: Post created
        Note over P,M: media.processed event (thumbnails generated, feed + search fan out)
        W-->>U: Post appears (optimistically, then confirmed)
    end
```

Edge cases: upload fails → post creation blocked, images from failed upload are orphaned and cleaned up; server-side re-validation rejects anything the client missed, draft preserved; post with images still pending processing shows originals/placeholder until ready.

## 4. Consuming the feed

```mermaid
flowchart LR
    A[Open /feed] --> B[Load page 1:\nfollowed + own posts,\nnewest first]
    B --> C[Scroll] --> D[Cursor pagination:\nnext page, no dupes/gaps]
    B --> E[ws notification:\nnew post/reply/interaction] --> F[Update in place\nor 'new posts' affordance]
    G[Timestamp <24 h] --> H["Relative, rounded to most\nsignificant figure: '1h', '5m'"]
    I[Timestamp ≥24 h] --> J["Absolute: 'D MMM YYYY HH:mm'"]
```

Edge cases: followed account deletes a post (removed on next load/notification); user follows someone mid-session (their posts appear going forward; backfill per feed rules); empty feed state (prompt to follow accounts or post).

## 5. Engaging (like / reply / repost / bookmark)

```mermaid
flowchart TD
    A[Post card] --> B{Action?}
    B -- like/unlike --> L[Toggle;\ncount updates everywhere]
    B -- bookmark --> K[Private to this user]
    B -- repost/undo --> R[Appears in followers' feeds\nattributed to reposter]
    B -- reply --> T[Compose reply] --> Th[Thread view,\nnested replies]
    A --> Q{Author blocked you?}
    Q -- yes --> X[Action fails:\nreply/like/repost blocked]
    Q -- no --> OK[Proceed]
```

Edge cases: double-click like (idempotent — unique per user+post+kind); interacting with a post deleted moments ago (404, UI removes it); undo of each interaction returns counts to prior state.

## 6. Following / unfollowing

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web
    participant S as Social svc
    U->>W: Click Follow on profile/post card
    W->>S: Create follow
    S-->>W: Follow created
    Note over S: social.follow.created event → feed rebuilt for follower
    W-->>U: Badge/state updates - their posts (and reposts) enter feed going forward
    U->>W: Click Unfollow
    W->>S: Delete follow
    Note over S: social.follow.deleted event
    W-->>U: Their posts stop appearing
```

Edge cases: follow someone who blocked you → fails (block semantics); follow a private-nothing demo account — all accounts are equal, no approval flow; following lists visible on any profile.

## 7. Blocking

```mermaid
sequenceDiagram
    participant A as Blocker
    participant W as Web
    participant S as Social svc
    A->>W: Block user X
    W->>S: Create block
    S-->>W: Block created
    Note over S: X's replies/likes/reposts/follows toward A now fail
    A->>W: Unblock user X
    W->>S: Delete block
    Note over S: X can interact again (prior failures stay failed)
```

Semantics: blocking is one-directional enforcement — X cannot interact with A or A's posts, and cannot follow A. A's view hides X's content where feasible. Unblock does not retroactively create anything.

## 8. Searching

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web
    participant SE as Search svc
    U->>W: Enter query
    W->>SE: Full-text posts search
    SE-->>W: Matching posts (no deleted), newest-weighted
    W-->>U: Results with standard post cards
    Note over W: Load more appends the next page in place (shared cursor pattern)
    Note over SE: Index is event-fed (lags seconds, not minutes)
```

Edge cases: empty query (no search fired); post deleted since indexing (excluded on next index update, tolerated if briefly stale); no results state.

## 9. Admin moderation

```mermaid
flowchart TD
    A[Admin panel] --> B{Action?}
    B -- delete post --> C[Soft delete:\nhidden from feed/threads/profiles/search;\nmedia removed]
    B -- delete media --> D[Media removed from its post or orphans cleaned]
    B -- inspect user --> E[Profile, relationships, activity]
    B -- system health --> F[Services, queues, index lag, last reset]
    C --> G[Same downstream effects as user-initiated delete]
```

Edge cases: deleting a post that already has replies (replies remain but reference a hidden/removed post, rendered gracefully); concurrent user interaction with a post being deleted (last write wins, delete dominates).

## Cross-cutting edge cases

| Situation                                   | Behaviour                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Nightly reset mid-session                   | Session survives (identity is external); data disappears; UI degrades gracefully, empty states shown |
| Any failure                                 | Inline, human error message; drafts preserved where possible                                         |
| Unauthenticated API/web access to user data | Redirect to login (web) / 401 (API)                                                                  |
