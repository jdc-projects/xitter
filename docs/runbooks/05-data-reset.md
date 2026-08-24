# Runbook: Nightly Reset & Partial Recovery

The authoritative procedure is [../specs/operations/02-data-reset.md](../specs/operations/02-data-reset.md) — this is the operator's step-by-step companion.

## Routine

Nothing to do: the `xitter-reset` CronJob (00:30 UTC daily, reseed on) runs the shared flow. Check health:

- Admin panel → System health → Data lifecycle (reads `GET /api/feed/internal/reset-status`).
- `kubectl -n xitter-dev get jobs -l app.kubernetes.io/name=xitter-reset` — last run Succeeded?
- Grafana → xitter · Reset job (job outcomes, phase durations, reseed fingerprint).

## Manual trigger

```sh
kubectl -n xitter-dev create job --from=cronjob/xitter-reset xitter-reset-manual
kubectl -n xitter-dev logs -f job/xitter-reset-manual
```

The same flow, against a local stack, is `npm run reset:live [-- --seed]`. Run the stack as two trees (`npm run start:apps` + `npm run start:workers`): the flow stops the worker processes for the wipe (Kafka rejects group operations while members are attached) and restarts them via `npm run start:workers`; killing workers inside a combined `npm run start` makes that turbo exit and take the services with it. The services must stay up throughout (the flow calls their `/internal/reseed`).

## Partial reset recovery

The flow logs one line per step in order (`reset: <step> ok (<ms>ms)`); the last `ok` line is the last completed step.

1. Read the job logs; identify the failed step (also recorded in the status record's `steps` array).
2. Nothing needs undoing — every step is idempotent and the run replays from the top.
3. Re-trigger the job (manual trigger above). If the same step fails twice, treat it as a real incident:
   - `truncate-service-dbs` → check the named service's health/logs (it answered non-2xx).
   - `wipe-media-bucket` / `delete-search-index` → check RustFS / OpenSearch pods.
   - `reset-consumer-groups` → check the Kafka cluster. The step drains group membership (Kafka evicts stopped consumers after their session timeout, ~45s), then deletes + recreates every topic and deletes the drained groups — a "still has members" failure means a worker did not actually stop (quiesce failed); find it before re-running.
   - `recreate-keycloak-realm` → check the homelab Keycloak; the realm returns on the next run with the same client secrets.
4. After recovery, verify (spec ops 02 table): demo1 login, feed/search state, bucket object count.

## Reseed drift

Every reseeded run records the corpus fingerprint (`xitter_reset_seed_fingerprint_info`, and in the status record). Two environments (or two runs) must always agree; a differing fingerprint means the generator changed without both environments picking it up — run the reset on the stale environment.

## Local equivalents

| Cluster                          | Local                                    |
| -------------------------------- | ---------------------------------------- |
| Nightly reset + reseed (CronJob) | `npm run reset:reseed` (volumes, seeded) |
| Nightly reset (no reseed)        | `npm run reset`                          |
| The CronJob's store-level flow   | `npm run reset:live [-- --seed]`         |
| Just the corpus                  | `npm run seed` (idempotent, verified)    |
