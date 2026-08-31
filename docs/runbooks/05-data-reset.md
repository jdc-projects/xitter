# Runbook: Nightly Reset & Partial Recovery

The authoritative procedure is [../specs/operations/02-data-reset.md](../specs/operations/02-data-reset.md) — this is the operator's step-by-step companion.

## Routine

Nothing to do: the `xitter-reset` CronJob (00:30 UTC daily, reseed on) runs the shared flow. Check health:

- Admin panel → System health → Data lifecycle (reads `GET /api/feed/internal/admin/reset-status`; null means no reset has run).
- `kubectl -n xitter-dev get jobs -l app.kubernetes.io/name=xitter-reset` — last run Succeeded?
- Grafana → xitter · Reset job (job outcomes, phase durations, reseed fingerprint).

## Manual trigger

```sh
kubectl -n xitter-dev create job --from=cronjob/xitter-reset xitter-reset-manual
kubectl -n xitter-dev logs -f job/xitter-reset-manual
```

The same flow, against a local stack, is `npm run reset:live [-- --seed]`. Nothing is stopped: the flow writes the reset epoch to the local Valkey and the running workers pause themselves (same code path as in-cluster). The services must stay up throughout (the flow calls their `/internal/reseed`). Infrastructure is never touched: the dev HPAs are retained and free, and scale events are expected to be seamless once #101 (second-pod boot readiness) is fixed.

## Partial reset recovery

The flow logs one line per step in order (`reset: <step> ok (<ms>ms)`); the last `ok` line is the last completed step.

1. Read the job logs; identify the failed step (also recorded in the status record's `steps` array).
2. Nothing needs undoing — every step is idempotent and the run replays from the top. A failed run has already cleared the reset epoch (the flow's `finally` deletes it, plus the next run's leading Valkey flush), so workers keep consuming — safe: the only wipe risk would have been between `wait-workers-paused` and the failure, and every store step is idempotent anyway.
3. Re-trigger the job (manual trigger above). If the same step fails twice, treat it as a real incident:
   - `truncate-service-dbs` → check the named service's health/logs (it answered non-2xx).
   - `wipe-media-bucket` / `delete-search-index` → check RustFS / OpenSearch pods.
   - `wait-workers-paused` → a worker never acknowledged the epoch. Check that worker's logs (did it see the epoch? is its Valkey connection healthy — `VALKEY_URL`, the valkey netpols) and that it is actually running; the flow aborts before any store is wiped, so nothing needs recovery beyond re-running.
   - `set-reset-epoch` / `clear-reset-epoch` → check Valkey itself.
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
