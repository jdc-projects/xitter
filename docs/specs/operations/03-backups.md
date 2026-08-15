# Backups

## Posture

The xitter namespaces (`xitter-dev`, `xitter-prod`) are **excluded from Velero cluster backups entirely** via namespace-level exclusion. Cluster backups protect the homelab platform, not xitter state.

## Rationale

| Reason               | Explanation                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Disposable demo data | All content is regenerable by design via the reset + deterministic reseed ([02-data-reset.md](02-data-reset.md)) |
| Reset-by-design      | Environments are wiped nightly; a backup of wiped-by-intent data has no consumer                                 |
| No PII persistence   | Demo user data should not outlive its environment; excluding backups guarantees it                               |

## What is persisted

| Asset                      | Where                                                     | Recovery                                                        |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| Source, infra, tests, docs | Git repo (source of truth)                                | `git clone`                                                     |
| Curated demo content       | Repo seed files, promoted from live content               | Replayed by reseed (faker seed 42 + curated files)              |
| Dashboards and alerts      | Grafana dashboards / Prometheus rules provisioned by Tofu | `tofu apply` recreates them                                     |
| Infrastructure definition  | `infra/iac`                                               | `tofu apply` per env ([01-environments.md](01-environments.md)) |
| Secrets                    | Tofu-managed k8s secrets                                  | Re-applied from Tofu (sources remain out of repo)               |

## Restore story

There is no per-object restore. An environment is rebuilt from scratch:

1. `tofu apply` in `infra/iac/environments/<env>` (recreates namespace, workloads, secrets, ingress, observability).
2. Run DB migrations.
3. Trigger reset-with-reseed (or let the nightly CronJob do it) to restore the known demo state.

Expected outcome: a functionally identical environment with only post-reset content lost — which is the intended semantics.
