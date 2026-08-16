# Data Specs

Desired end-state for xitter's data: who owns what, how it's seeded, how it lives and dies, and the privacy posture. Services own their stores; these specs describe each store, not the code that touches it.

| Doc                                            | Scope                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| [01-storage-model.md](./01-storage-model.md)   | Ownership matrix, per-service schemas (ER + fields), indexes, migration policy        |
| [02-seeding.md](./02-seeding.md)               | Deterministic seed corpus: goals, volumes, order, idempotency, content promotion      |
| [03-data-lifecycle.md](./03-data-lifecycle.md) | Entity lifecycle states, nightly reset spec, retention                                |
| [04-privacy.md](./04-privacy.md)               | No-PII posture: synthetic identities, warning placements, log rules, reset as erasure |

Product-facing behaviour is specified in [../product/README.md](../product/README.md).
