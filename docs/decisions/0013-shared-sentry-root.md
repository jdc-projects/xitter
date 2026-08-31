# ADR 0013: A shared tofu root owns the Sentry team and project

## Status

Decided — 2026-08-31

Supersedes the Sentry-ownership half of [ADR 0012](0012-realm-per-environment.md)'s context (one env's state owning what the other reads — the "Sentry-single-project trap" it cites). ADR 0012's actual decision, realm-per-environment, stands untouched.

## Context

Sentry deliberately has ONE `xitter` project (spec 06: cross-service traces and issue correlation need a single event stream; environments separate via `SENTRY_ENVIRONMENT`). Since T11 the project and its team were created by **dev's** state; prod read them via `data.sentry_project`/`data.sentry_key`. That coupling carried two hazards, both exercised during the 2026-08-30 destroy/apply loop:

1. **Ordering**: a prod release cut before dev's first post-merge apply fails prod's plan (`data.sentry_project` cannot find the project) — after the tag and GitHub release are already published.
2. **Destroy-dev orphans prod**: `tofu destroy` of dev deletes the team+project; prod's already-materialised `xitter-sentry` secret keeps pointing at the dead project's DSN and prod events are silently dropped until dev re-applies (and prod re-applies).

ADR 0012 had already named this shape a trap — its shared-realm option was rejected partly because fixing it would need "a second dev→prod state coupling of exactly the kind the runbook already flags as a trap for Sentry". The same reasoning, applied to Sentry itself: a resource one environment owns but both depend on is process-enforced ordering at best, an outage at worst.

## Decision

A new minimal tofu root, `infra/iac/environments/shared` (backend state `xitter-shared`, same `tf-state` namespace), owns **exactly**:

- `sentry_team.xitter` + `sentry_project.xitter` (moved verbatim from dev; `lifecycle { prevent_destroy = true }` on the project — every env's DSN secret points at its key, so recreating the project would silently re-key all events),
- `data.sentry_key.xitter` (`first = true` — the Default key) and outputs `sentry_project_slug` + `sentry_dsn_public` (sensitive),
- its own `jianyuan/sentry` provider, token from the homelab `sentry` remote state and the same `TF_VAR_provider_sentry_base_url` in-cluster override as the env roots (ADR 0011).

Nothing environment-shaped lives there. Wiring:

- **dev**: `removed` blocks (`destroy = false`) make its next apply simply _forget_ the two resources — no state surgery, no window where a stray deploy deletes them; its `xitter-sentry` secret re-sources from `data.terraform_remote_state.xitter_shared.outputs.sentry_dsn_public`.
- **prod**: drops the data sources; same remote-state output into its secret.
- **CI**: the shared root applies **before** the env apply (`deploy-dev.yml`, `release.yml`) and joins fmt/validate/plan in PR gates, so the output always exists before any env plan reads it.

**Migration (no DSN churn — critical):** executed on the PR branch, tofu-only, dev's state untouched. `tofu init` created the `xitter-shared` backend; `tofu import sentry_team.xitter sentry/xitter` + `tofu import sentry_project.xitter sentry/xitter` adopted the live objects; `tofu plan` showed **no changes** (adoption was exact), and the following no-change apply materialised the outputs with zero infrastructure changes. On merge, dev's next apply forgets the two resources and its secret picks up the byte-identical DSN from the new source; prod reads the output from its next release.

## Options considered

| Option                                      | Pros                                                                              | Cons                                                                                                               | Verdict    |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| **Shared root owns team+project (chosen)**  | Removes both hazards; import = byte-identical DSN, no churn; minimal second state | One more tofu root in CI (one apply step, two gate steps)                                                          | **Chosen** |
| Keep dev-owned (status quo)                 | No new state                                                                      | Both hazards remain; ordering is process-enforced and already failed exactly as predicted (2026-08-30)             | Rejected   |
| Prod imports the project into its state too | No new root                                                                       | Two states owning one object fight over every attribute — the collision class ADR 0012 removed for realms          | Rejected   |
| Per-environment Sentry projects             | No sharing at all                                                                 | Splits the single event stream that is the point of Sentry (spec 06); traces and issue correlation across envs die | Rejected   |

## Consequences

- Releases no longer depend on dev's apply timing, and destroying an environment can no longer orphan the other's DSN — the two hazard notes are deleted from the releasing runbook.
- `xitter-shared` is xitter's second owned state; `infra/iac/REMOTE-STATE.md` records it, and it appears wherever CI already handles the env roots (fmt, validate, plan, apply-before-env).
- The sentry provider blocks in dev/prod become transitional: dev's serves the `removed`-block drain, prod's is unused. Both can be pruned once dev's state no longer holds the two resources — a trivial follow-up, deliberately not bundled here.
- Out of scope, flagged (owner call, homelab repo): the bootstrap token is one full-admin non-expiring USER token shared by six tofu states (`iac/sentry/bootstrap.tf:153` includes org/team/project admin) — narrower per-consumer scopes would shrink blast radius.
