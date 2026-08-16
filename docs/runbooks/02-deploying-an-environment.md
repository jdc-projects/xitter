# Runbook 02: Deploying an Environment

## Context

Apply OpenTofu to the homelab Kubernetes cluster for the `dev` or `prod` xitter environment. Environments live in `infra/iac/environments/{dev,prod}` on top of shared modules (`namespace`, `xitter-service`); the cluster itself is managed by the homelab repo. Workload modules land incrementally with feature tickets — this runbook covers the environment skeleton and grows over time.

**Deploys are CI-driven**: merge to `dev` runs `tofu-apply` in Actions (see `.github/workflows/deploy-dev.yml`). This runbook covers the one-time setup and the manual/local path — use it when iterating on IaC or deploying `prod` (T13 wires prod deploys).

## Execution steps

1. **Prerequisites**: the `CLUSTER_KUBECONFIG` secret in Actions (one-time — see [04-ci-and-secrets.md](04-ci-and-secrets.md)); for local runs, `tofu` CLI plus the homelab kubeconfig copied/linked to `infra/cluster.yml` (gitignored) — the path the env configs resolve via `config_path = "../../../cluster.yml"`.
2. **CI path** (default): merge to `dev` → images build → `tofu-apply` job runs `tofu init && tofu apply -auto-approve` against `infra/iac/environments/dev`.
3. **Local path** (iterating on IaC): `cd infra/iac/environments/dev` (or `prod`), then `tofu init` (state is in the cluster's `tf-state` namespace; the backend block already carries `secret_suffix`/`config_path`), `tofu plan`, review, `tofu apply`. Idempotent: re-running converges to the declared state.
4. PRs touching `infra/iac/**` additionally run `tofu fmt/validate` on every PR and `tofu plan` (real backend) as a check — review the plan before merging.

## Validation steps

1. The Actions run's `tofu-apply` job is green (or locally: `tofu output` shows expected outputs).
2. `kubectl -n xitter-dev get pods` — workloads running.
3. `curl https://xitter-dev.jd-chapman.dev/healthz` — edge health responds (real health endpoints land with their feature tickets; until then, any 2xx/308 from the ingress confirms routing).

## Related

- Remote-state consumption table: `infra/iac/REMOTE-STATE.md`
- Secrets setup: [04-ci-and-secrets.md](04-ci-and-secrets.md)

4. Ingress is provided by the homelab module (`github.com/jdc-projects/homelab//iac/modules/ingress`); API routes use `auth_mode=oidc-api` (edge JWT validation + identity header injection), so unauthenticated API calls should be rejected at the edge.
