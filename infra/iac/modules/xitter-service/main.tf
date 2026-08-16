terraform {
  required_version = ">= 1.9"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

variable "name" {
  type = string
}

variable "namespace" {
  type = string
}

variable "environment" {
  type = string
}

variable "image" {
  description = "Container image for the workload."
  type        = string
}

variable "port" {
  description = "Container port; also used for probes when do_expose is true."
  type        = number
  default     = 8080
}

variable "replicas" {
  type    = number
  default = 2
}

variable "env" {
  description = "Additional env vars (name/value). Secrets are injected separately."
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "secret_env" {
  description = "Env vars sourced from Kubernetes secrets."
  type = list(object({
    name        = string
    secret_name = string
    secret_key  = string
  }))
  default = []
}

variable "is_knative" {
  description = "Deploy as a Knative Service (scale-to-zero workers) instead of a Deployment."
  type        = bool
  default     = false
}

variable "do_expose" {
  description = "Create a Service for this workload."
  type        = bool
  default     = true
}

locals {
  labels = {
    "app.kubernetes.io/name"     = var.name
    "app.kubernetes.io/part-of"  = "xitter"
    "app.kubernetes.io/instance" = var.environment
    environment                  = var.environment
  }

  pod_labels = merge(local.labels, {
    "app.kubernetes.io/component" = var.is_knative ? "worker" : "service"
  })

  # Mutable-tag deploys (dev uses tag `dev`): always pull so pods pick up the
  # latest push instead of pinning to whatever a node last cached.
  image_pull_policy = "Always"

  # Shared pod/container hardening: non-root, no privilege escalation, no
  # added capabilities, read-only root filesystem with a writable /tmp.
  # Apps that need other scratch paths mount their own emptyDir.
  pod_security_context = {
    run_as_non_root = true
    fs_group        = 1000
    seccomp_profile = "RuntimeDefault"
  }

  container_security_context = {
    allow_privilege_escalation = false
    privileged                 = false
    read_only_root_filesystem  = true
    run_as_non_root            = true
    run_as_user                = 1000
    run_as_group               = 1000
    capabilities = {
      drop = ["ALL"]
      add  = []
    }
    seccomp_profile = "RuntimeDefault"
  }
}

# One ServiceAccount per workload (spec 07: no shared identities).
resource "kubernetes_service_account_v1" "this" {
  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }

  automount_service_account_token = false
}

# ---------------------------------------------------------------------------
# Deployment (non-knative workloads: web, cms, admin, API services)
# ---------------------------------------------------------------------------
resource "kubernetes_deployment" "this" {
  count = var.is_knative ? 0 : 1

  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    replicas = var.replicas

    selector {
      match_labels = {
        "app.kubernetes.io/name"     = var.name
        "app.kubernetes.io/instance" = var.environment
      }
    }

    template {
      metadata {
        labels = local.pod_labels
      }

      spec {
        service_account_name = kubernetes_service_account_v1.this.metadata[0].name

        security_context {
          run_as_non_root = local.pod_security_context.run_as_non_root
          fs_group        = local.pod_security_context.fs_group
        }

        container {
          name  = var.name
          image = var.image

          image_pull_policy = local.image_pull_policy

          port {
            container_port = var.port
            protocol       = "TCP"
          }

          dynamic "env" {
            for_each = var.env
            content {
              name  = env.value.name
              value = env.value.value
            }
          }

          dynamic "env" {
            for_each = var.secret_env
            content {
              name = env.value.name
              value_from {
                secret_key_ref {
                  name = env.value.secret_name
                  key  = env.value.secret_key
                }
              }
            }
          }

          readiness_probe {
            http_get {
              path = "/readyz"
              port = var.port
            }
            initial_delay_seconds = 5
            period_seconds        = 10
          }

          liveness_probe {
            http_get {
              path = "/healthz"
              port = var.port
            }
            initial_delay_seconds = 10
            period_seconds        = 15
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "192Mi"
            }
            limits = {
              cpu    = "1"
              memory = "512Mi"
            }
          }

          security_context {
            allow_privilege_escalation = local.container_security_context.allow_privilege_escalation
            privileged                 = local.container_security_context.privileged
            read_only_root_filesystem  = local.container_security_context.read_only_root_filesystem
            run_as_non_root            = local.container_security_context.run_as_non_root
            run_as_user                = local.container_security_context.run_as_user
            run_as_group               = local.container_security_context.run_as_group

            capabilities {
              drop = local.container_security_context.capabilities.drop
              add  = local.container_security_context.capabilities.add
            }

            seccomp_profile {
              type = "RuntimeDefault"
            }
          }

          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }
        }

        volume {
          name = "tmp"
          empty_dir {}
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Service (when exposed: edge routing targets it)
# ---------------------------------------------------------------------------
resource "kubernetes_service_v1" "this" {
  count = var.do_expose ? 1 : 0

  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    port {
      name        = "http"
      port        = var.port
      target_port = var.port
      protocol    = "TCP"
    }

    selector = {
      "app.kubernetes.io/name"     = var.name
      "app.kubernetes.io/instance" = var.environment
    }
  }

  depends_on = [kubernetes_deployment.this]
}

# ---------------------------------------------------------------------------
# HPA (non-knative public workloads; Knative autoscales its own revisions)
# ---------------------------------------------------------------------------
resource "kubernetes_horizontal_pod_autoscaler_v2" "this" {
  count = var.is_knative || !var.do_expose ? 0 : 1

  metadata {
    name      = var.name
    namespace = var.namespace
    labels    = local.labels
  }

  spec {
    min_replicas = var.replicas
    max_replicas = max(var.replicas, 6)

    scale_target_ref {
      api_version = "apps/v1"
      kind        = "Deployment"
      name        = var.name
    }

    metric {
      type = "Resource"
      resource {
        name = "cpu"
        target {
          type                = "Utilization"
          average_utilization = 70
        }
      }
    }
  }

  depends_on = [kubernetes_deployment.this]
}

# ---------------------------------------------------------------------------
# Knative Service (workers: scale-to-one floor, bounded ceiling, cluster-local)
# ---------------------------------------------------------------------------
resource "kubernetes_manifest" "knative" {
  count = var.is_knative ? 1 : 0

  manifest = {
    apiVersion = "serving.knative.dev/v1"
    kind       = "Service"

    metadata = {
      name      = var.name
      namespace = var.namespace
      labels = merge(local.labels, {
        # No ingress: workers are reachable only inside the cluster.
        "networking.knative.dev/visibility" = "cluster-local"
      })
    }

    spec = {
      template = {
        metadata = {
          labels = local.pod_labels
          annotations = {
            # Workers must always be consuming: never scale below one.
            "autoscaling.knative.dev/minScale" = "1"
            "autoscaling.knative.dev/maxScale" = "4"
          }
        }
        spec = {
          serviceAccountName   = kubernetes_service_account_v1.this.metadata[0].name
          containerConcurrency = 0
          timeoutSeconds       = 300

          containers = [
            {
              name  = var.name
              image = var.image

              imagePullPolicy = local.image_pull_policy

              ports = [{ containerPort = var.port }]

              env = concat(
                [for e in var.env : { name = e.name, value = e.value }],
                [for e in var.secret_env : {
                  name      = e.name
                  valueFrom = { secretKeyRef = { name = e.secret_name, key = e.secret_key } }
                }],
              )

              # Workers currently serve only a plain metrics listener (no
              # /healthz), so probe the socket instead of HTTP.
              readinessProbe = { tcpSocket = { port = var.port }, periodSeconds = 10 }
              livenessProbe  = { tcpSocket = { port = var.port }, periodSeconds = 15 }

              resources = {
                requests = { cpu = "100m", memory = "128Mi" }
                limits   = { cpu = "500m", memory = "256Mi" }
              }

              securityContext = {
                allowPrivilegeEscalation = false
                readOnlyRootFilesystem   = true
                runAsNonRoot             = true
                runAsUser                = 1000
                runAsGroup               = 1000
                capabilities             = { drop = ["ALL"] }
              }

              volumeMounts = [{ name = "tmp", mountPath = "/tmp" }]
            },
          ]

          volumes = [{ name = "tmp", emptyDir = {} }]
        }
      }
    }
  }

  computed_fields = [
    "metadata.labels",
    "metadata.annotations",
    # Knative rewrites traffic with the concrete revision name.
    "spec.traffic",
  ]
}

output "name" {
  description = "Workload name (Deployment or Knative Service)."
  value       = var.name
}

output "service_name" {
  description = "The Service name when exposed, null otherwise."
  value       = var.do_expose ? kubernetes_service_v1.this[0].metadata[0].name : null
}

output "service_port" {
  description = "The Service port when exposed, null otherwise."
  value       = var.do_expose ? var.port : null
}
