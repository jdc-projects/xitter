# Seeding

Deterministic seeding for the nightly reset (and local bootstrap). Goals, volumes, generation order, and the content-promotion loop. The reset itself is specified in [03-data-lifecycle.md](./03-data-lifecycle.md).

## Goals

1. **Identical corpus everywhere**: the same seed input produces the same data locally and in any deployed environment.
2. **Realistic-ish volumes** (below) so feeds, threads, profiles, and search feel lived-in.
3. **Idempotent**: reseeding over an existing seed corpus is a no-op (keyed upserts, no duplicates).
4. Runs from one script locally and remotely, driven by env-based base URLs — no environment-specific code paths.

## Volumes

| Entity       | Target                       | Notes                                                                                                         |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Users        | 10 (fixed)                   | `demo1`..`demo10`; profiles with varied display names/bios                                                    |
| Posts        | ~12 per user (~120 total)    | Mix of standalone posts and replies                                                                           |
| Follow graph | ~30% density                 | Each user follows ~3 of the other 9; guaranteed connected-ish, no self-follows                                |
| Replies      | A share of posts are replies | Concentrated on a few "conversation" threads (3 roots × 4 replies)                                            |
| Likes        | Distributed                  | Some posts hot, most cold                                                                                     |
| Reposts      | A few                        | Must produce repost feed entries                                                                              |
| Bookmarks    | A few                        | Scattered across users                                                                                        |
| Images       | A few posts                  | Generated PNGs uploaded through the real media pipeline (slot → presigned PUT → completion → worker variants) |

Interaction totals are capped per user (≤12) so seeding never trips the services' mutation rate limits.

## Determinism

- Faker (and any RNG) seeded with the constant **42** — recorded here as the contract.
- No `Date.now()`, randomness, or environment-derived values in generation; timestamps derive from a fixed epoch plus generated offsets.
- Generation order is fixed (below) so ids and references match across runs.
- The corpus digest (`corpusFingerprint`) hashes the canonical corpus; every reseeded reset records it, and any two runs (or environments) must agree byte-for-byte.
- Server-assigned ids (post/media UUIDs, Keycloak sub claims) are not part of the digest: determinism is over the corpus content, not the stores' identifiers.

## Generation order

```mermaid
flowchart LR
    A["Users (fixed demo1..demo10)"] --> B[Profiles]
    B --> C["Follow graph"]
    C --> D[Posts]
    D --> E["Replies (self-referencing posts)"]
    E --> F["Interactions: likes/reposts/bookmarks"]
    F --> G["Media (a few posts with images)"]
    G --> H["Feed rebuild via replayed events"]
    H --> I["Search reindex from posts events"]
```

Feed and search are **not** written directly: the seed emits the same events the real services emit, and the fanout/index workers build derived stores exactly as in production. This exercises the event path and guarantees consistency.

## How seed runs

| Aspect       | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point  | One script (`packages/scripts/src/seed.ts`), invoked by the nightly reset (optional step) and by local bootstrap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Targets      | Env-driven base URLs for each service API (per-service `XITTER_*_URL` overrides, or one shared `XITTER_SEED_BASE_URL`); same script local + remote                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Idempotency  | Keyed upserts through the services' own idempotent operations (ensure-profile, follow, interact) — re-running over seeded data changes nothing; a pre-flight probe recognises a fully seeded environment (verified no-op) or a partial one (fails loudly: reset first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Failure      | Fail loudly and non-destructively; partial seeds are retried wholesale on the next run/reset. Seed and CMS-apply calls retry transient failures bounded (3 tries, 2s backoff), split by call idempotency (#82, #85): keyed upserts (profiles, follows, interactions, media complete, CMS slug-keyed upserts) and reads retry anything transient (502/503/504, connection-level codes); plain creates whose id the server mints (post create, media upload slot, CMS doc create) retry only provably-unprocessed causes (503, connect-phase errors) and reconcile ambiguous ones instead — an exact-text twin on the author timeline adopts a post that landed, a slug re-list adopts a CMS doc, and media slots fail loudly (the media API exposes no user-scoped probe). Deploy pod-churn during the seed window is ridden out without risking duplicate content |
| Verification | Post-seed sanity counts (users/posts/follow density/derived feed entries) polled until the workers converge; mismatch marks the seed failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The corpus itself is pure (`packages/scripts/src/corpus.ts`) — no I/O, no clocks — and unit-tested for volumes, graph shape and cross-run fingerprint equality, so every environment derives identical data from the same constants.

## Content promotion flow

Curated content must survive resets, so anything worth keeping is promoted **from CMS to repo**:

```mermaid
flowchart LR
    A[Edit in CMS\nlive preview] --> B[Publish]
    B --> C[Export to repo\nseed content files]
    C --> D[Merge via PR]
    D --> E[Seed consumes files\non next reset/reseed]
    E --> F[Content survives nightly wipes]
```

- Only CMS-managed content (landing intro, FAQ entries) participates; user posts are never promoted.
- Seed content files in the repo are the durable source (`packages/scripts/data/content/`, keyed by the collections' unique `slug`); the CMS is the editing surface.
- A promotion is a PR like any other: reviewed, merged, then picked up by the next seed run.
