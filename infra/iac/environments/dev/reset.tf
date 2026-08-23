# Nightly data reset (spec: docs/specs/operations/02-data-reset.md).
#
# A CronJob runs the shared reset implementation (packages/scripts, image
# xitter-reset) with the svc-reset client: quiesce workers (minScale 0 on
# the Knative services) -> recreate the demo realm -> per-service
# /internal/reseed + CMS content reset -> RustFS bucket wipe -> OpenSearch
# index delete -> Kafka consumer-group reset -> Valkey flush -> resume
# workers -> optional deterministic seed.
#
# Success/failure is observable two ways: kube-state-metrics job series
# (T11's XitterResetJobStale/Failed alerts match job_name =~ "xitter-reset.*")
# and the xitter_reset_* gauges pushed to the Pushgateway when
# XITTER_RESET_PUSHGATEWAY_URL is set. The run record for the admin health
# tile lands in Valkey (feed serves GET /internal/reset-status).
#
# Manual trigger:
#   kubectl -n xitter-dev create job --from=cronjob/xitter-reset xitter-reset-manual

variable "reset_schedule" {
  description = "Cron schedule (UTC) for the nightly data reset."
  type        = string
  default     = "0 0 * * *"
}

variable "reset_reseed" {
  description = "Apply the deterministic seed corpus (faker seed 42) after each reset."
  type        = bool
  default     = true
}

locals {
  # Matches T11's alert/dashboard job_name regex (xitter-reset.*); the jobs
  # the CronJob spawns are xitter-reset-<timestamp>.
  reset_name = "xitter-reset"
}

resource "kubernetes_service_account_v1" "reset" {
  metadata {
    name      = local.reset_name
    namespace = local.ns
    labels    = module.namespace.labels
  }

  # Required: the job talks to the Kubernetes API (worker quiesce/resume).
  automount_service_account_token = true
}

# Quiesce/resume = patch minScale on the worker Knative Services + list
# their pods to confirm scale-down. Nothing else.
resource "kubernetes_role_v1" "reset" {
  metadata {
    name      = "${local.reset_name}-workers"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  rule {
    api_groups = ["serving.knative.dev"]
    resources  = ["services"]
    verbs      = ["get", "patch"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["list"]
  }
}

resource "kubernetes_role_binding_v1" "reset" {
  metadata {
    name      = "${local.reset_name}-workers"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.reset.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.reset.metadata[0].name
    namespace = local.ns
  }
}

# Job-only config: Keycloak admin credentials (realm recreate) and the
# machine-client secrets (the recreated realm must hand back the SAME
# secrets the workloads' envFrom Secrets already carry, or every
# client-credentials grant breaks until the next tofu apply).
resource "kubernetes_secret" "reset_config" {
  metadata {
    name      = "${local.reset_name}-config"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    XITTER_KEYCLOAK_ADMIN_USER     = data.terraform_remote_state.keycloak.outputs.keycloak_admin_username
    XITTER_KEYCLOAK_ADMIN_PASSWORD = data.terraform_remote_state.keycloak.outputs.keycloak_admin_password
    XITTER_KEYCLOAK_MACHINE_SECRETS = jsonencode({
      for client, _ in local.machine_clients : client => random_password.machine_client_secret[client].result
    })
  }
}

resource "kubernetes_cron_job_v1" "reset" {
  metadata {
    name      = local.reset_name
    namespace = local.ns
    labels    = merge(module.namespace.labels, { "app.kubernetes.io/name" = local.reset_name })
  }

  spec {
    schedule                      = var.reset_schedule
    concurrency_policy            = "Forbid"
    starting_deadline_seconds     = 600
    successful_jobs_history_limit = 3
    failed_jobs_history_limit     = 3

    job_template {
      metadata {
        labels = module.namespace.labels
      }

      spec {
        backoff_limit              = 2
        ttl_seconds_after_finished = 172800

        template {
          metadata {
            labels = merge(module.namespace.labels, {
              "app.kubernetes.io/name" = local.reset_name
            })
          }

          spec {
            service_account_name = kubernetes_service_account_v1.reset.metadata[0].name
            restart_policy       = "Never"

            container {
              name              = local.reset_name
              image             = "${var.image_registry}/xitter-reset:${var.image_tag}"
              image_pull_policy = "Always"

              # Explicit command: the image's CMD is ["node", "dist/reset-job.js"]
              # but k8s `args` REPLACES CMD - args-only made the container run
              # `node --seed` (node: bad option) and the nightly reset crashloop
              # from its very first manual trigger.
              command = ["node", "dist/reset-job.js"]
              args    = var.reset_reseed ? ["--seed"] : []

              env {
                name  = "XITTER_ENV"
                value = var.environment
              }
              env {
                name  = "XITTER_RESET_JOB_NAME"
                value = local.reset_name
              }
              env {
                name  = "XITTER_RESET_NAMESPACE"
                value = local.ns
              }

              # Store/service coordinates (in-cluster, never via the edge).
              env {
                name  = "KAFKA_BROKERS"
                value = local.kafka_bootstrap
              }
              env {
                name  = "VALKEY_URL"
                value = local.valkey_url
              }
              env {
                name  = "XITTER_OPENSEARCH_URL"
                value = "http://opensearch.${local.ns}.svc:9200"
              }
              env {
                name  = "XITTER_MEDIA_S3_ENDPOINT"
                value = "http://${local.rustfs_svc}:9000"
              }
              env {
                name  = "XITTER_MEDIA_S3_BUCKET"
                value = local.rustfs_bucket
              }

              # Per-service API bases (svc-reset hits /api/{service}/internal/...).
              dynamic "env" {
                for_each = ["social", "posts", "media", "feed", "search"]
                content {
                  name  = "XITTER_${upper(env.value)}_URL"
                  value = local.svc_base[env.value]
                }
              }

              # CMS content reset step: without this the target falls back
              # to the local-stack default (localhost) and the step cannot
              # reach the cms service in-cluster.
              env {
                name  = "XITTER_CMS_URL"
                value = "http://cms.${local.ns}.svc:3000"
              }

              # Realm contract (keycloak.ts must recreate exactly this).
              env {
                name  = "XITTER_SEED_KEYCLOAK_URL"
                value = local.keycloak_url
              }
              # Edge origin: the web client's redirect URIs/origins must
              # converge on tofu's (keycloak.tf), never the local default -
              # the realm upsert overwrites them on every run.
              env {
                name  = "XITTER_EDGE_URL"
                value = "https://${var.domain}"
              }
              env {
                name  = "XITTER_DEMO_REALM"
                value = local.demo_realm
              }
              env {
                name  = "XITTER_DEMO_USER_PREFIX"
                value = "demo"
              }
              env {
                name  = "XITTER_DEMO_USER_COUNT"
                value = "10"
              }
              env {
                name  = "XITTER_DEMO_USER_PASSWORD"
                value = "DemoPass123!"
              }

              # CMS content reset is skipped in dev until the admin-realm CMS
              # client wiring lands (T9 follow-up tracks the dev credential);
              # the step reports an explicit visible skip, never a silent one.
              env {
                name  = "XITTER_RESET_SKIP_CMS"
                value = "1"
              }

              # svc-reset client credentials (same random_password the realm
              # clients and workload Secrets share).
              env {
                name = "XITTER_RESET_CLIENT_SECRET"
                value_from {
                  secret_key_ref {
                    name = kubernetes_secret.keycloak_client["svc-reset"].metadata[0].name
                    key  = "KEYCLOAK_CLIENT_SECRET"
                  }
                }
              }

              env_from {
                secret_ref {
                  name = kubernetes_secret.reset_config.metadata[0].name
                }
              }
              env_from {
                secret_ref {
                  name = kubernetes_secret.media_s3.metadata[0].name
                }
              }

              resources {
                requests = {
                  cpu    = "100m"
                  memory = "256Mi"
                }
                limits = {
                  cpu    = "1"
                  memory = "512Mi"
                }
              }

              security_context {
                allow_privilege_escalation = false
                privileged                 = false
                read_only_root_filesystem  = true
                run_as_non_root            = true
                run_as_user                = 1000
                run_as_group               = 1000
                capabilities {
                  drop = ["ALL"]
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
  }

  depends_on = [module.api_service, module.worker]
}

# Deploy-path user provisioning (#67): a one-shot Job that guarantees the
# 10 demo users EXIST right after the realm converges. The nightly reset
# keeps owning wipe+reseed, but it used to be the ONLY provisioner - any
# realm (re)creation (first deploy of a fresh environment, a realm state
# heal) left zero logins until the next nightly.
#
# Re-run semantics (house pattern - db-init / rustfs-provision): the pod
# template is ForceNew in the kubernetes provider, so tofu replaces - and
# thereby re-runs - the Job whenever its spec changes. CI pins
# image_tag=sha-<short> per deploy, so every deploy re-runs it (cheap:
# --ensure-users is an idempotent upsert, never a wipe). When the image
# does NOT change, two more triggers cover it: replace_triggered_by re-runs
# the Job in the same apply that replaces the realm resources (-replace,
# taint heal), and the completion TTL GCs the finished Job so a later
# apply recreates it.
#
# Named outside the xitter-reset.* alert regex on purpose: this is not the
# nightly reset - its failure surfaces as the tofu apply failing instead.
resource "kubernetes_job" "ensure_demo_users" {
  metadata {
    name      = "ensure-demo-users"
    namespace = local.ns
    labels    = merge(module.namespace.labels, { "app.kubernetes.io/name" = "ensure-demo-users" })
  }

  spec {
    template {
      metadata {
        labels = merge(module.namespace.labels, {
          "app.kubernetes.io/name" = "ensure-demo-users"
        })
      }

      spec {
        # Realm init is pure Keycloak admin API over the identity egress -
        # the pod never talks to the Kubernetes API, so it gets no token.
        automount_service_account_token = false
        restart_policy                  = "Never"

        container {
          name              = "ensure-demo-users"
          image             = "${var.image_registry}/xitter-reset:${var.image_tag}"
          image_pull_policy = "Always"

          # Explicit command for the same reason as the CronJob: k8s `args`
          # REPLACES the image CMD (args-only ran `node --seed` once).
          command = ["node", "dist/reset-job.js"]
          args    = ["--ensure-users"]

          # Realm contract + credentials - exactly what the reset CronJob's
          # realm step sees, so both paths run the same initDemoRealm.
          env {
            name  = "XITTER_SEED_KEYCLOAK_URL"
            value = local.keycloak_url
          }
          # Edge origin: the web-client upsert must converge on tofu's
          # redirect URIs (keycloak.tf), not the local localhost default.
          env {
            name  = "XITTER_EDGE_URL"
            value = "https://${var.domain}"
          }
          env {
            name  = "XITTER_DEMO_REALM"
            value = local.demo_realm
          }
          env {
            name  = "XITTER_DEMO_USER_PREFIX"
            value = "demo"
          }
          env {
            name  = "XITTER_DEMO_USER_COUNT"
            value = "10"
          }
          env {
            name  = "XITTER_DEMO_USER_PASSWORD"
            value = "DemoPass123!"
          }

          env_from {
            secret_ref {
              name = kubernetes_secret.reset_config.metadata[0].name
            }
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "1"
              memory = "512Mi"
            }
          }

          security_context {
            allow_privilege_escalation = false
            privileged                 = false
            read_only_root_filesystem  = true
            run_as_non_root            = true
            run_as_user                = 1000
            run_as_group               = 1000
            capabilities {
              drop = ["ALL"]
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

    backoff_limit              = 0
    ttl_seconds_after_finished = 86400
  }

  # Blocks the apply until the users verifiably exist (fresh environments
  # are loginable the moment the first deploy completes).
  wait_for_completion = true

  timeouts {
    # Generous vs db-init's 5m: the first apply pulls a cold image and the
    # admin-client auth alone may retry for up to 120s.
    create = "10m"
    update = "10m"
  }

  # Only after Tofu has converged the realm the users are ensured into.
  depends_on = [
    keycloak_realm.demo,
    keycloak_role.demo_user,
    keycloak_openid_client.web,
    keycloak_openid_audience_protocol_mapper.audience,
    kubernetes_secret.reset_config,
  ]

  lifecycle {
    # An unchanged-image apply that replaces the realm (-replace, taint
    # heal) must re-provision users in THAT apply, not the next deploy.
    replace_triggered_by = [
      keycloak_realm.demo,
      keycloak_role.demo_user,
      keycloak_openid_client.web,
    ]
  }
}
