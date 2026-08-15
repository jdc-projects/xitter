# Shared modules for every xitter environment (dev, prod).

- `namespace` - the per-environment Kubernetes namespace and shared labels
- `xitter-service` - the deployment recipe for an app/service/worker
  (Deployment or Knative Service, probes, HPA defaults). Feature tickets fill
  in the workloads; the module interface is defined here from day one.
