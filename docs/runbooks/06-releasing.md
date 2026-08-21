# Runbook 06: Releasing to Prod

## Context

Promote a release from `dev` to `prod`: cut a release branch, merge it, and let the Release workflow (`.github/workflows/release.yml`) derive the semver version, publish images, tag, apply `infra/iac/environments/prod`, and reconcile prod-only commits back to dev.

Normal releases are **workflow-driven** — after the merge, this runbook is mostly a watch-and-verify checklist. The manual paths below cover the first release, dry runs, and repair scenarios.

Full policy: [../specs/operations/04-release-pipeline.md](../specs/operations/04-release-pipeline.md).

## Execution steps

1. **Preconditions (first time only)**
   - Branch protection configured on `dev` and `prod` (see the manual-configuration section of the release-pipeline spec).
   - The `CLUSTER_KUBECONFIG` secret exists (shared with dev deploys — [04-ci-and-secrets.md](04-ci-and-secrets.md)).
   - The `prod` branch exists: `git push origin origin/dev:refs/heads/prod` (once; afterwards fast-forward it to dev before cutting release branches so releases contain what dev contains).

2. **Dry run (first release, or after risky infra changes)**
   - Actions → **Release** → Run workflow → `dry_run=true`, `version=v0.1.0-rc.1` (any throwaway rc version).
   - The workflow builds rc-tagged images, **plans** prod with that tag, and uploads the plan artifact (`prod-plan`). Review it: expect the full environment (no prior state) or a small diff (existing env), and **no destructive changes** that lose data you care about (none is expected — data is disposable by design).
   - The rc images and tag are not created (dry run skips `github-release`); the rc image tags on GHCR are harmless orphans.

3. **Cut + merge the release**
   ```sh
   git checkout -b release/v0.2 origin/dev
   git push origin release/v0.2
   ```
   - Open PR `release/v0.2` → `prod` (gates run; approvals per protection). Optionally stabilise on the release branch first.
   - Merge. The Release workflow starts on the `prod` push.

4. **Watch the Release run** (Actions → Release):
   - `version` — derived from conventional commits since the last `v*` tag (e.g. a history with `feat` entries since `v0.1.0` yields `v0.2.0`). Sanity-check the derivation artifact (`release-derivation`) if it looks wrong.
   - `release-images` — 11 images tagged `vX.Y.Z` + `sha-<short>` on `ghcr.io/jdc-projects`.
   - `github-release` — tag + notes at https://github.com/jdc-projects/xitter/releases.
   - `tofu-apply` — prod environment converges. First apply creates everything (CNPG `wait` blocks until Postgres is healthy; jobs run to completion). Later applies are small rolls (image tags, `SENTRY_RELEASE`).
   - `reconcile` — when prod holds commits dev lacks, a `prod` → `dev` PR is opened. **Merge it as admin** (bot-authored PRs don't trigger gates), or if a reconcile PR already exists, handle it manually.

5. **Manual repair paths**
   - Wrong version tagged (e.g. a `chore` slipped in that you didn't mean to release): let the release complete, then delete the tag/release (`gh release delete vX.Y.Z && git push origin :refs/tags/vX.Y.Z`) and re-run the workflow with `--explicit` via `workflow_dispatch` (`version=vX.Y.Z` empty, derivation reruns from the corrected history).
   - Prod apply failed mid-run: fix forward on a new release branch (or re-run the failed job — `tofu apply` is convergent).
   - Reconciliation PR conflicts (dev moved on): resolve in favour of `dev` for everything except the release-merge commit itself.

## Validation steps

1. `gh release view vX.Y.Z` — tag, notes, target SHA.
2. `kubectl -n xitter-prod get deploy,ksvc,hpa` — all workloads rolled to the release image; `kubectl -n xitter-prod get pods` shows no `ImagePullBackOff`.
3. `curl -sI https://xitter.jd-chapman.dev/` → 2xx/3xx from the edge.
4. Through the edge: `POST /api/...` unauthenticated → 401 from the oidc-api middleware (proves routing + realm wiring). Full smoke: run the Bruno collection against prod — Actions → **Scheduled suites** → Run workflow → `environment=prod` — or locally `npm run test:api -- --env dev` (dev) / `--env prod` once a prod environment file exists.
5. Reconciliation: `git rev-list --count origin/prod ^origin/dev` → `0` after merging the reconcile PR.
6. Sentry: `xitter-prod-*` projects exist; events report `release=vX.Y.Z` (`SENTRY_RELEASE` = image tag).
7. Scheduled suites: next nightly run (02:30 UTC) green against dev; artifacts `bruno-report-dev` + `artillery-report-dev` present.

## Notes

- Prod currently has **no reset CronJob / `svc-reset` client / reset alerts** — that wiring lands with the data-lifecycle follow-up (#13) and is tracked there. Until then prod data persists until manually cleared; demo users for prod logins are created by that job.
- Release images are immutable (`vX.Y.Z` tags are never re-pushed; a bad release gets a new patch version, not an overwrite). The mutable `prod`-style tag does not exist — only `dev` is mutable.
- If the `version` job fails with `vX.Y.Z is not greater than the latest tag`, the derived/explicit version regressed — usually an `--explicit` typo or a tag moved; check `git tag --list 'v*'` first.
