# Runbook 02: Deploying an environment

## Context

Apply OpenTofu to the homelab Kubernetes cluster for the `dev` or `prod` xitter environment. Environments live in `infra/iac/environments/{dev,prod}` on top of shared modules (`namespace`, `xitter-service`); the cluster itself is managed by the homelab repo. Workload modules land incrementally with feature tickets — this runbook covers the environment skeleton and grows over time.

## Execution steps

1. **Prerequisites**: `tofu` CLI, and the cluster kubeconfig from the homelab repo at `iac/cluster.yml` (see `github.com/jdc-projects/homelab`). By convention, copy/link it to the repo-root-adjacent path expected by the environment (`../../../cluster.yml` relative to the environment directory).
2. `cd infra/iac/environments/dev` (or `prod`).
3. `tofu init -backend-config=secret_suffix=xitter-dev` — state lives in the cluster's `tf-state` namespace, using the kubeconfig from step 1.
4. `tofu plan` — review what will land (namespace `xitter-dev`, service modules, ingress).
5. `tofu apply` — idempotent: re-running converges to the declared state.
6. Images are built and pushed by CI on merge to `dev` — deploying code is a PR, not a manual step.

## Validation steps

1. `tofu output` — confirm expected outputs (hosts, namespace).
2. `kubectl -n xitter-dev get pods` — workloads running.
3. `curl https://xitter-dev.jd-chapman.dev/healthz` — edge health responds (real health endpoints land with their feature tickets; until then, any 2xx/308 from the ingress confirms routing).
4. Ingress is provided by the homelab module (`github.com/jdc-projects/homelab//iac/modules/ingress`); API routes use `auth_mode=oidc-api` (edge JWT validation + identity header injection), so unauthenticated API calls should be rejected at the edge.
