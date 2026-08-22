# Operations Specs

Desired end-state for running xitter: environments, data lifecycle, and backup posture.

| Doc                                              | Purpose                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [01-environments.md](01-environments.md)         | Environment model (local/dev/prod), cluster topology, config management, access control |
| [02-data-reset.md](02-data-reset.md)             | Nightly reset: schedule, scope, execution order, reseed, verification, failure handling |
| [03-backups.md](03-backups.md)                   | Backup posture: Velero exclusions, rationale, what is persisted, restore story          |
| [04-release-pipeline.md](04-release-pipeline.md) | Gitflow, semver releases, prod deploys, scheduled suites, branch protection             |

Detailed operational runbooks (step-by-step procedures) live outside specs in `docs/runbooks`.
