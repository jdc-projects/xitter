# Demo-user provisioning for prod (spec: docs/specs/operations/02-data-reset.md).
#
# DELIBERATE prod delta vs dev's reset.tf (#13): prod runs no nightly reset
# yet - no CronJob, no svc-reset client, no reset alerts/dashboard - so prod
# data persists until #13 lands its per-env schedule/enable wiring. Until
# then this file carries only the deploy-path half dev also has: the
# one-shot ensure-demo-users Job that guarantees demo1..demo10 EXIST right
# after the realm converges. Without it a first apply serves a login page
# nobody can authenticate against (#159).
#
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
