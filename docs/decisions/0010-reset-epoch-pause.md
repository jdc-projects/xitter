# ADR 0010: Reset epoch pause (workers pause themselves)

## Status

Decided — 2026-08-24

## Context

The nightly reset must stop event consumption before wiping stores (a worker writing derived state mid-wipe risks half-processed events). The original mechanism did that from the outside: the reset job talked to the Kubernetes API to patch each worker Knative Service's `minScale` from 1 to 0, waited for the pods to scale to zero, wiped, then scaled back to 1. It also had to deal with Kafka group offsets — kafkajs `resetOffsets` does not durably commit against Kafka 4, so the reset instead deleted and recreated every topic and deleted the drained consumer groups, relying on the workers' `fromBeginning` replay on a fresh log.

That dance worked but was expensive and brittle:

- **Slow**: scale-to-zero waits (Knative stability windows + consumer drain + group session timeouts, ~minutes per reset) dominated the reset duration.
- **Cold-start races**: scale-up 0→1 raced the seed (workers must be consuming before the corpus lands) and every revision roll started from a cold process.
- **Field-manager conflicts**: the job patched Knative annotations Tofu also manages; the `?fieldManager=xitter-reset` hack avoided audit confusion but the ownership overlap remained.
- **K8s API egress/RBAC complexity**: an in-cluster SA token, a Role for Knative service patch + pod list, a `undici` dispatcher for the serviceaccount CA, and a control-plane-LAN egress netpol (kube-proxy DNATs `kubernetes.default` past the service CIDR) — a lot of surface for one job.

The worker-side pause is the only part of that list that actually needs to exist.

## Decision

Workers pause **themselves** on a shared flag; nothing is scaled.

- **Epoch flag in Valkey**: `xitter:reset:epoch` holds an integer the reset bumps (`INCR`). Its presence means "a reset is in progress". Heartbeats `xitter:reset:paused:<worker>` = epoch acknowledge each worker's pause (TTL'd, refreshed while held).
- **Reset order** (`reset-flow.ts`): flush Valkey **first** (clears stale epoch state while workers are still live — harmless, they keep consuming) → set epoch → wait for all three workers' heartbeats to match it (bounded, `XITTER_RESET_PAUSE_TIMEOUT_MS` default 300s, aborting **before any store is wiped** on timeout) → the data steps as before → clear epoch (delete epoch + heartbeats, also in `finally` so a failed run never leaves an event blackhole) → optional seed.
- **Worker side** (`packages/events` `createResetEpochGate`, wired into `runEventWorker` by all three workers): a short timer polls the epoch. Unknown/unchanged → consume normally. Epoch appeared/changed → `pause` all assigned partitions, drain in-flight work, write the heartbeat, idle until the epoch key is **removed** → `seek` every assigned partition to the log end (kafkajs has no seekToEnd; offset `-1` resolves to LATEST at fetch time) → `resume`.
- **The seek-to-end replaces the consumer-group reset entirely**: the Kafka log is retained untouched, and each worker skips the pre-reset backlog itself. Topics are no longer deleted/recreated; groups keep their offsets.
- **Fresh-boot fail-safe**: a worker that boots with no epoch key seeks its first assignment to the log end — a worker that was down for an entire reset must never replay a pre-reset log into freshly wiped stores. This also retires `fromBeginning: true` for the workers: an unknown log is never replayed; the materialised stores only ever hold current-epoch events.
- **Failure posture**: Valkey errors never crash the worker (in `running` they defer the transition — the reset fails safely at its own wait step; while paused they keep the worker paused until Valkey returns). A pause whose epoch vanishes before acknowledgement resumes in place with no seek (nothing was skipped).
- **Tofu**: the reset job's SA/Role/RoleBinding, API-server egress netpol and `control_plane_cidr` variable are gone; the job runs token-less. Workers get `VALKEY_URL` and are admitted by the Valkey egress/ingress netpols. The reset job was also dropped from the Kafka netpols — it no longer has a Kafka admin client.
- **Local dev**: `npm run reset:live` runs the identical flow against local Valkey; the old SIGTERM-based local worker control is deleted.

## Options

| Option                                    | Pros                                                | Cons                                                                                                                | Verdict    |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| Keep minScale quiesce/resume (status quo) | Already worked; no worker changes                   | Slow drains, cold-start races, field-manager conflicts, K8s API RBAC + egress surface                               | Rejected   |
| Boolean "paused" flag                     | Simplest worker logic                               | A crash between set and clear leaves an ambiguous flag; retries cannot distinguish reset generations                 | Rejected   |
| **Integer epoch (chosen)**                | Retry-safe (INCR always yields an unacknowledged value); workers can detect superseded epochs; heartbeat matching is exact | Slightly more worker state (last-known epoch)                                                                      | **Chosen** |
| Reset deletes topics + groups (status quo) | Verifiably empty log                               | Slow (drain + session timeouts), destroys the log nightly, kafkajs offset-reset workaround required                  | Rejected   |
| **Workers seek to log end (chosen)**      | No broker-side coordination; instant; keeps the log  | Workers must be trusted to implement the pause (they are first-party); pre-reset log retained until topic retention | **Chosen** |

## Consequences

- The reset job is a plain container: no Kubernetes API, no RBAC, no undici; `reset-job.ts` contains zero k8s usage.
- Reset duration drops by the scale-to-zero/drain minutes; worker processes stay warm across resets (no cold starts, no revision rolls).
- Workers now require Valkey at boot (`VALKEY_URL` everywhere, fail-fast) — one more hard dependency, but one they already share with the services.
- The Kafka log survives resets (up to 7-day retention); the epoch boundary is enforced at consumption, not at the broker.
- `xitter_reset_step_duration_seconds` gains `set-reset-epoch`, `wait-workers-paused`, `clear-reset-epoch` and loses `quiesce-workers`, `reset-consumer-groups`, `resume-workers`; dashboards keyed on the old step names need the new labels.
- Worker metrics gain `xitter_reset_epoch_paused` and `xitter_reset_epoch_pauses_total` for pause observability.
- Future consumers of `runEventWorker` get the pause protocol by passing `resetPause`; a worker without it keeps the old default (log end on fresh group, no pause).
