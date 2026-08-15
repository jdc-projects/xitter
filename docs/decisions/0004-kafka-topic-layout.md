# ADR 0004: Kafka topic layout

## Status

Decided — 2026-08-15

## Context

Kafka is the event-driven backbone between services and workers. We need a topic layout, a message format, and an evolution strategy that suits a demo without pretending demos never grow.

## Decision

- **One topic per producing service+domain, version in the name**: `xitter.posts.v1`, `xitter.social.v1`, `xitter.media.v1` (canonical definitions in `packages/events/src/topics.ts`).
- **JSON envelope** shared by all events:
  - `eventId` — UUID, used by consumers as the idempotency key (delivery is at-least-once)
  - `eventType` — discriminator, e.g. `posts.post.created`, `social.follow.deleted`
  - `eventVersion`, `producer`, `occurredAt`, `payload`
- Consumers subscribe to the topic and select on `eventType`.
- **Partitions**: 6 locally; single-digit replication factor in the cluster.
- **Retention**: 7 days.
- **Auto-create disabled**; topics are created explicitly by the `topics:create` script.

Event types: `posts.post.created/deleted`, `posts.interaction.created/deleted` (like | bookmark | repost), `social.follow.created/deleted`, `social.block.created/deleted`, `media.media.uploaded/processed`.

## Options

| Option                                                               | Pros                                                                                                                         | Cons                                                                                                                                          | Verdict    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Topic per event type                                                 | Strong per-event-type isolation                                                                                              | Topic sprawl; weaker ordering guarantees per aggregate (related events land on different topics)                                              | Rejected   |
| Single shared topic (e.g. `xitter.events`)                           | Fewest topics to manage                                                                                                      | Noisy; no per-domain retention or ACL granularity; every consumer sees everything                                                             | Rejected   |
| Avro + schema registry                                               | Strong schema evolution guarantees; compact binary                                                                           | Extra infrastructure for a demo; zod schemas in `@xitter/api-contracts`/`@xitter/events` are already the versioned contract, reviewed in-repo | Rejected   |
| **Topic per service+domain, versioned name, JSON envelope (chosen)** | Ordering per domain; manageable topic count; envelope gives idempotency and evolution hooks; contract stays in-repo with zod | No registry-enforced compatibility; breaking changes need a `.v2` topic and consumer coordination                                             | **Chosen** |

## Consequences

- Consumers must be idempotent on `eventId` — retries and reprocessing are expected (at-least-once).
- Breaking payload changes bump the topic version (`.v2`) rather than mutating `v1` in place; additive changes stay on `v1` with `eventVersion`.
- Schema changes ship in the same PR as producer and consumer updates, validated by zod at the boundary.
- Retention (7 days) is a safety net for consumer downtime, not a source of truth — feed and OpenSearch state is rebuildable (see 0005-storage-ownership.md).
