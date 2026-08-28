# Remote state consumed by xitter environments

Both environments (`dev`, `prod`) read homelab state from the shared `tf-state`
namespace on the same cluster (`config_path = "../../../cluster.yml"` → `infra/cluster.yml`, gitignored).

| Remote state      | Secret suffix     | Outputs consumed                                                     | Used for                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keycloak-config` | `keycloak-config` | `keycloak_admin_username`, `keycloak_admin_password`, `keycloak_url` | `keycloak` provider — realm/client provisioning (T1: each env's own demo realm per [ADR 0012](../../docs/decisions/0012-realm-per-environment.md) — `xitter-demo` dev, `xitter-demo-prod` prod — plus svc-* clients and audience mappers). The state itself is read-only for xitter: each env's Tofu state owns only the objects it declares. |
| `sentry`          | `sentry`          | `sentry_auth_token`, `sentry_domain`                                 | `jianyuan/sentry` provider — the single Sentry project (T11; dev's state owns it, prod reads it)                                                                                                                                                                                                                                              |

Not consumed (push model, no outputs needed): `prometheus`, `grafana`, `tempo` —
xitter creates its own `ServiceMonitor`/`PrometheusRule`/Grafana CRs inside its
namespace, which the cluster operators pick up.

When adding a new remote-state dependency, follow the same pattern as the
existing `data "terraform_remote_state"` blocks and record it in this table.
