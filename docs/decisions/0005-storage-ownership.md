# ADR 0005: Storage ownership

## Status

Decided — 2026-08-15

## Context

Microservices only mean something if each service owns its storage. Cross-service database reads quietly recreate a distributed monolith. At the same time, running five separate Postgres clusters on a laptop (or even in the homelab for a demo) is wasteful. We need an ownership boundary that is architectural, not necessarily physical.

## Decision

- **One Postgres cluster per environment** (CNPG in-cluster; shared docker Postgres locally). **Each service gets its own database and credentials** within that cluster.
- **No cross-service database access, ever.** Cross-service reads go through APIs.
- **Media objects live in RustFS** (S3-compatible), with keys namespaced per purpose.
- **OpenSearch indices are owned by the search-index pipeline** and are treated as rebuildable derived state.
- **Valkey is used for ephemeral caches and rate limits only** — no durable state.
- Local dev mirrors the boundary: one shared docker Postgres instance with per-service databases and roles created by `infra/docker/init/01-databases.sql`.

| Store                      | Owner                                   | Durability expectation                           |
| -------------------------- | --------------------------------------- | ------------------------------------------------ |
| Postgres (per-service DBs) | social, posts, media, feed, search, cms | Source of truth (but nightly reset in demo envs) |
| RustFS                     | media service                           | Media objects, namespaced keys                   |
| OpenSearch                 | search-index worker                     | Derived, rebuildable from events                 |
| Valkey                     | per-app ephemeral                       | Disposable                                       |

## Options

| Option                                                           | Pros                                                                                                | Cons                                                                                             | Verdict                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Database-per-service with separate clusters                      | Physically enforces the boundary                                                                    | Resource-heavy for laptops and over-provisioned for a demo homelab                               | Rejected locally; in-cluster a single CNPG cluster with per-service DBs is the documented tradeoff |
| Shared schema in one database                                    | Simplest operations                                                                                 | Breaks the ownership boundary — any service can join across another's tables; migrations collide | Rejected                                                                                           |
| **Single cluster, per-service databases + credentials (chosen)** | Enforced logical boundary (separate DBs, roles, migrations); one cluster to back up/operate per env | Shared failure domain and noisy-neighbour potential at the cluster level                         | **Chosen**                                                                                         |

## Consequences

- The boundary is enforced by credentials and convention, not network isolation — acceptable at demo scale, and Kubernetes RBAC + NetworkPolicies tighten it in-cluster.
- Cross-service data needs are met by API calls or by materialising via events (e.g. the feed service owning its copy of post data, per 0003-feed-fanout-strategy.md).
- Prisma schemas live per service; a shared schema is never added.
- OpenSearch can be wiped and rebuilt by replaying/re-emitting events without losing source-of-truth data.
