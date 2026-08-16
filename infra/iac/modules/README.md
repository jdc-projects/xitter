# Shared modules for every xitter environment (dev, prod).

- `namespace` - the per-environment Kubernetes namespace and shared labels
- `xitter-service` - the deployment recipe for an app/service/worker:
  Deployment (+ Service, HPA) or Knative Service (`is_knative`), probes on
  `/healthz` + `/readyz` (tcp for knative), env + secret_env, non-root
  security context, one ServiceAccount per workload. Note: knative workloads
  receive all env via `envFrom`, so Secret keys must be named exactly as the
  env vars they should become.
