# Nightly wipe + demo-user provisioning for prod (spec:
# docs/specs/operations/02-data-reset.md). The owner decision (2026-08-29,
# #160): wipe-on-schedule, same contract as dev - the CronJob below mirrors
# dev's reset.tf line-for-line where the environments allow. The deploy-path
# ensure-demo-users Job guarantees demo1..demo10 EXIST right after the realm
# converges (#159).
# The job runs the shared reset implementation's --ensure-users mode
# (packages/scripts, image xitter-reset): ONLY the flow's realm-init step
# (initDemoRealm) - an idempotent upsert that never wipes data or touches
# workers. Realm coordinates match the reset CronJob's contract in dev, so
# both paths run the same code.

# Job config: Keycloak admin credentials (realm init) and the
# machine-client secrets (the realm upsert must hand back the SAME secrets
# the workloads' envFrom Secrets already carry, or every
# client-credentials grant breaks until the next tofu apply).
resource "kubernetes_secret" "reset_config" {
  metadata {
    name      = "xitter-reset-config"
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

# Deploy-path user provisioning (#67, mirrored from dev for #159): a one-shot
# Job that guarantees the 10 demo users EXIST right after the realm
# converges - fresh environments are loginable the moment the first deploy
# completes, instead of waiting for a reset that prod does not run.
#
# Re-run semantics (house pattern - db-init / rustfs-provision): the pod
# template is ForceNew in the kubernetes provider, so tofu replaces - and
# thereby re-runs - the Job whenever its spec changes. The Release workflow
# pins image_tag=<semver> per apply, so every release re-runs it (cheap:
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

          # Explicit command for the same reason as dev's CronJob: k8s `args`
          # REPLACES the image CMD (args-only once ran `node --seed`).
          command = ["node", "dist/reset-job.js"]
          args    = ["--ensure-users"]

          # Realm contract + credentials - exactly what dev's reset CronJob's
          # realm step sees, so both paths run the same initDemoRealm.
          env {
            name  = "XITTER_SEED_KEYCLOAK_URL"
            value = local.keycloak_incluster_url
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

    # Idempotent realm-init (#104): retry transient pod failures (a single
    # DNS EAI_AGAIN was observed failing a live apply) instead of failing
    # the whole deploy - a re-run upserts users, it never wipes.
    backoff_limit              = 2
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
    # heal) must re-provision users in THAT apply, not the next release.
    replace_triggered_by = [
      keycloak_realm.demo,
      keycloak_role.demo_user,
      keycloak_openid_client.web,
    ]
  }
}

# Nightly wipe (#160 owner decision 2026-08-29: wipe-on-schedule, same as
# dev). 00:30 UTC for the same quiet-window reason as dev (reset.tf there);
# prod evening deploys are rarer still.
variable "reset_schedule" {
  description = "Cron schedule (UTC) for the nightly data reset."
  type        = string
  default     = "30 0 * * *"
}

variable "reset_reseed" {
  description = "Apply the deterministic seed corpus (faker seed 42) after each reset."
  type        = bool
  default     = true
}

resource "kubernetes_cron_job_v1" "reset" {
  metadata {
    name      = "xitter-reset"
    namespace = local.ns
    labels    = merge(module.namespace.labels, { "app.kubernetes.io/name" = "xitter-reset" })
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
              "app.kubernetes.io/name" = "xitter-reset"
            })
          }

          spec {
            # The reset job never talks to the Kubernetes API (workers pause
            # themselves on the Valkey epoch, ADR 0010) - no token mounted.
            automount_service_account_token = false
            restart_policy                  = "Never"

            container {
              name              = "xitter-reset"
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
                value = "xitter-reset"
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
                value = local.keycloak_incluster_url
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

# Deploy-path corpus seed (mirrored from dev): the SAME full reset flow
# the nightly CronJob runs (`--seed`), executed as part of every Release
# apply. A fresh prod formation is loginable (ensure-demo-users) but
# EMPTY without it - zero posts, follows or media until the first
# nightly. Every release now converges the deterministic corpus (chosen
# semantics: demo data is disposable by design, ADR 0010; a
# deterministic post-deploy state also self-heals any half-seeded
# environment).
#
# Re-run semantics: house ForceNew pattern - the Release workflow pins
# image_tag=<semver> per apply, so each release replaces and thereby
# re-runs the Job (wipe + reseed). The flow is idempotent (step replay,
# packages/scripts reset-flow) and its worker-pause gate aborts BEFORE
# any store is wiped when the stack is not ready; the k8s backoff then
# retries once the rollouts settle (backoff_limit 4 vs the nightly's 2 -
# a deploy-path run races freshly-rolled pods by construction).
#
# Named outside the xitter-reset.* alert regex on purpose: its failure
# fails the Release apply itself (wait_for_completion), not the alerts.
resource "kubernetes_job" "deploy_seed" {
  metadata {
    name      = "deploy-seed"
    namespace = local.ns
    labels    = merge(module.namespace.labels, { "app.kubernetes.io/name" = "deploy-seed" })
  }

  spec {
    template {
      metadata {
        labels = merge(module.namespace.labels, {
          "app.kubernetes.io/name" = "deploy-seed"
        })
      }

      spec {
        # Same no-Kubernetes-API contract as the nightly (ADR 0010:
        # workers pause themselves on the Valkey epoch).
        automount_service_account_token = false
        restart_policy                  = "Never"

        container {
          name              = "deploy-seed"
          image             = "${var.image_registry}/xitter-reset:${var.image_tag}"
          image_pull_policy = "Always"

          # Explicit command for the same reason as the CronJob: k8s
          # `args` REPLACES the image CMD (args-only ran `node --seed`).
          command = ["node", "dist/reset-job.js"]
          args    = ["--seed"]

          env {
            name  = "XITTER_ENV"
            value = var.environment
          }
          # Run-record name (admin reset tile): deploy runs must read
          # distinctly from the nightly's xitter-reset-<env> default.
          env {
            name  = "XITTER_RESET_JOB_NAME"
            value = "deploy-seed"
          }
          env {
            name  = "XITTER_RESET_NAMESPACE"
            value = local.ns
          }

          # Store/service coordinates (in-cluster, never via the edge) -
          # the exact contract the nightly CronJob carries.
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
            value = local.keycloak_incluster_url
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

          # CMS content reset is skipped until the admin-realm CMS client
          # wiring lands (T9 follow-up tracks the credential); the step
          # reports an explicit visible skip, never a silent one.
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

    # Idempotent flow: a backoff retry replays safely from any failed
    # step; 4 (vs the nightly's 2) tolerates pods still rolling out.
    backoff_limit              = 4
    ttl_seconds_after_finished = 86400
  }

  # A green Release means the corpus is verifiably in - the first apply
  # of a fresh environment ends with a populated feed, not just pods.
  wait_for_completion = true

  timeouts {
    # The worker-pause gate alone can legitimately wait 5 minutes
    # (XITTER_RESET_PAUSE_TIMEOUT_MS default) while rollouts settle.
    create = "20m"
    update = "20m"
  }

  depends_on = [
    module.api_service,
    module.worker,
    # Sequential realm work: the reset recreates the realm through the
    # same initDemoRealm ensure-demo-users runs - two concurrent realm
    # inits would race delete/create on the admin API.
    kubernetes_job.ensure_demo_users,
  ]
}
