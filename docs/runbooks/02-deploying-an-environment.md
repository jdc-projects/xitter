# Runbook 02: Deploying an Environment

## Context

Apply OpenTofu to the homelab Kubernetes cluster for the `dev` or `prod` xitter environment. Environments live in `infra/iac/environments/{dev,prod}` on top of shared modules (`namespace`, `xitter-service`); the cluster itself is managed by the homelab repo.

The dev environment deploys, in one root module:

| Piece           | What                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace       | `xitter-dev` (namespace module) + Velero exclusion label                                                                                                                                                                                                                        |
| Deps            | CNPG Postgres `xitter-postgres` (1 instance in dev), Strimzi Kafka + `xitter.{posts,social,media}.v1` topics, Valkey (Helm), OpenSearch (operator CR), RustFS (Helm) + public-read `xitter-media` bucket                                                                        |
| Databases       | `db-init` Job creates per-service roles/DBs (`social`, `posts`, `media`, `feed`, `search`, `cms`); per-service `DATABASE_URL` Secrets                                                                                                                                           |
| Keycloak        | `xitter-demo` realm, `web` client, `svc-*` / `svc-worker-*` / `svc-reset` clients with per-audience mappers; creds into K8s Secrets                                                                                                                                             |
| Workloads       | 11 `xitter-service` instances: 5 API services (+HPA), 3 Knative workers, web, cms, admin                                                                                                                                                                                        |
| Edge            | Homelab ingress module routes for `/`, `/api/{service}`, `/media`, `/cms`, `/admin`; geo-open (no geoblock middleware), plus `realms/xitter-demo`, `resources`, `js` path routes on `idp.jd-chapman.dev` (demo login reachable globally; primary realm + `/admin` stay UK-only) |
| NetworkPolicies | Default deny + explicit allows (edge, Prometheus, same-namespace, per-dependency egress)                                                                                                                                                                                        |

**Deploys are CI-driven**: merge to `dev` runs `tofu-apply` in Actions (see `.github/workflows/deploy-dev.yml`). This runbook covers the one-time setup and the manual/local path — use it when iterating on IaC. Prod deploys are release-driven (`docs/runbooks/06-releasing.md`): the Release workflow applies `environments/prod` with the release's semver `image_tag` (the module's `image_tag` variable is required there — no default).

## Execution steps

1. **Prerequisites**:
   - `tofu` CLI (OpenTofu ≥ 1.9).
   - Homelab kubeconfig copied/linked to `infra/cluster.yml` (gitignored) — the path every provider/backend block resolves via `config_path = "../../../cluster.yml"`.
   - The `CLUSTER_KUBECONFIG` secret in Actions for the CI path (one-time — see [04-ci-and-secrets.md](04-ci-and-secrets.md)).
   - Images published to GHCR at `ghcr.io/jdc-projects/xitter-*:dev` (CI from merge; until then workloads sit in `ImagePullBackOff`, which is expected — see validation below).
2. **Backend bootstrap (first init only)**: the state lives in the cluster's `tf-state` namespace as secret `tfstate-default-xitter-dev`. The backend block in `environments/dev/main.tf` already carries `secret_suffix`/`config_path`/`namespace`, so a plain init works:
   ```sh
   tofu -chdir=infra/iac/environments/dev init
   ```
   If the backend block ever loses its inline config, initialise with
   `tofu init -backend-config=secret_suffix=xitter-dev -backend-config=config_path=../../../cluster.yml -backend-config=namespace=tf-state` (see `infra/iac/REMOTE-STATE.md`). The same namespace holds the homelab remote states (`keycloak-config`, `sentry`) that provide the Keycloak provider credentials.
3. **Iterate**: `tofu -chdir=infra/iac/environments/dev validate`, `tofu -chdir=infra/iac fmt -recursive` (CI enforces both — one recursive fmt check from `infra/iac` plus per-env validate), then `tofu plan -input=false` and review.
4. **Apply**: `tofu -chdir=infra/iac/environments/dev apply`. The CNPG cluster has a `wait` condition (`Cluster in healthy state`), so the apply blocks until Postgres is up; Helm releases (Valkey, RustFS) wait for their pods; the `db-init` and `rustfs-provision` jobs run to completion (`wait_for_completion`), so a green apply means databases, bucket, and realms exist.
5. **CI path** (default): merge to `dev` → images build → `tofu-apply` job runs `tofu init && tofu apply -auto-approve` against `infra/iac/environments/dev`.
6. PRs touching `infra/iac/**` additionally run `tofu fmt/validate` on every PR and `tofu plan` (real backend) as a check — review the plan before merging.

## Validation steps

1. `tofu -chdir=infra/iac/environments/dev output` — namespace, base URL, and dependency endpoints.
2. Dependencies healthy:
   ```sh
   kubectl -n xitter-dev get cluster xitter-postgres          # phase: Cluster in healthy state
   kubectl -n xitter-dev get kafka,kafkatopics                 # kafka Ready; 3 xitter.* topics Ready
   kubectl -n xitter-dev get pods                              # valkey-*, rustfs-*, opensearch-* Running
   kubectl -n xitter-dev get job db-init rustfs-provision      # Complete
   ```
   Bucket check: `kubectl -n xitter-dev logs job/rustfs-provision` ends with the `mc cors set` for `xitter-media`.
3. Keycloak: `https://idp.jd-chapman.dev/admin/master/#/xitter-demo/clients` lists `web`, `svc-social`…`svc-search`, `svc-worker-*`, `svc-reset` (and the edge-created `xitter-dev-*-api`/`-cms`/`-admin` clients).
4. Workloads: `kubectl -n xitter-dev get deploy,ksvc,hpa` — all present. Until part A's images are on GHCR (`:dev` tag) the API/web/cms/admin pods sit in `ImagePullBackOff`; that is expected and not an apply failure.
5. Edge routing: `kubectl -n xitter-dev get ingressroute,middleware` lists one route per public workload. Health endpoints are deliberately excluded from the services' `api/{service}/v1` global prefix (they sit at each service's root and are not edge-exposed), so validate them by port-forward: `kubectl -n xitter-dev port-forward deploy/social 8080:8080` then `curl localhost:8080/healthz` → 200 (`/readyz` additionally checks the DB). Through the edge, run the `bruno/xitter` collection (environment `dev`, request `social/health.bru`) — it asserts the unauthenticated 401 from the oidc-api middleware, which proves routing + realm wiring pre- and post-images alike.
6. `curl -I https://xitter-dev.jd-chapman.dev/` — any 2xx/3xx from the web route confirms the edge (web itself may 502 while images are pending).
7. **Non-UK reachability (manual — T14 geo-open)**: the demo is globally reachable, so from a non-UK egress (VPN or hotspot; cannot be automated from CI, which runs from UK egress) check:
   - `curl -sI https://idp.jd-chapman.dev/realms/xitter-demo/.well-known/openid-configuration` → 200 (the realm is geo-open via xitter-owned path routes; anything else on the idp host — `/realms/primary`, `/admin` — should still be geo-blocked → non-200 there).
   - The demo login page renders fully from non-UK egress: open `https://idp.jd-chapman.dev/realms/xitter-demo/protocol/openid-connect/auth?...` (or just log in via the web app) — the `resources`/`js` theme-asset paths must load without the geoblock 403, otherwise the page renders broken.
   - `curl -sI https://xitter-dev.jd-chapman.dev/` → 2xx/3xx (host is geo-open).

   If any of these return 403/451 from a non-UK egress, the geoblock exception regressed — check the IngressRoutes in `xitter-dev` still carry no `geoblock` middleware.

## Manual follow-ups / notes

- **Keycloak provider reachability**: `tofu plan/apply` needs the `keycloak` provider to log in at `https://idp.jd-chapman.dev` (master realm, admin creds from the `keycloak-config` remote state). If the edge blocks your egress IP (Cloudflare/crowdsec 403 on every `*.jd-chapman.dev` host), every plan/apply fails at provider init with `failed to perform initial login ... 403 Forbidden` — that is an edge block, not bad credentials. In that state the realm/clients plus the five `xitter-dev-{service}` API routes cannot be applied; everything else can (the client Secrets are derived from the same `random_password`s the clients are created with, so workloads get valid creds once the realm converges). Re-run the full `tofu apply` once the block clears.
- DNS for `xitter-dev.jd-chapman.dev` is a wildcard on the homelab domain (`*.jd-chapman.dev`) — no per-host record needed; if a route 404s at the edge, check the IngressRoute exists for that host first.
- Velero: the `xitter-dev` namespace carries `velero.io/exclude-from-backup=true` (verified against the homelab's exclusion mechanism — the label, applied the same way the velero namespace itself is excluded). Nothing from the environment is backed up, matching the nightly-reset data policy.
- The reset job (T6) recreates demo users in the realm nightly; tofu owns the realm/client skeleton. If the reset ever deletes the whole realm, re-run `tofu apply` to converge it back.

## Related

- Remote-state consumption table: `infra/iac/REMOTE-STATE.md`
- Secrets setup: [04-ci-and-secrets.md](04-ci-and-secrets.md)
