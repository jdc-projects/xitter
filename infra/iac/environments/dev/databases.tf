# Per-service databases + credentials (spec: services own their data; one DB
# and one role per service, no shared access) and the RustFS bucket.

resource "random_password" "postgres_app" {
  length  = 32
  numeric = true
  special = false
  upper   = true
}

# Mirrors infra/docker/init/01-databases.sql: one LOGIN role + database per
# service (cms included - the Payload CMS also owns a schema).
locals {
  db_services = ["social", "posts", "media", "feed", "search", "cms"]

  postgres_rw_host = "xitter-postgres-rw.${local.ns}.svc"
}

resource "random_password" "db" {
  for_each = toset(local.db_services)

  length  = 32
  numeric = true
  special = false
  upper   = true
}

# One Secret per service holding just its DATABASE_URL. Consumed by the
# workloads via the xitter-service module's secret_env.
resource "kubernetes_secret" "db_url" {
  for_each = toset(local.db_services)

  metadata {
    name      = "${each.key}-db"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    PASSWORD     = random_password.db[each.key].result
    DATABASE_URL = "postgresql://${each.key}:${random_password.db[each.key].result}@${local.postgres_rw_host}:5432/${each.key}"
  }
}

# Idempotent role/database provisioning. Runs as the CNPG bootstrap owner
# (granted CREATEROLE/CREATEDB by postInitSQL); passwords are injected at
# runtime from the Secrets above, so nothing sensitive lands in the Job spec.
# The \gexec pattern mirrors the docker init SQL.
resource "kubernetes_job" "db_init" {
  metadata {
    name      = "db-init"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  spec {
    template {
      metadata {
        labels = merge(module.namespace.labels, {
          "app.kubernetes.io/name" = "db-init"
        })
      }

      spec {
        restart_policy = "Never"

        container {
          name  = "db-init"
          image = local.postgres_image

          command = [
            "/bin/sh",
            "-c",
            <<-EOT
              set -eu
              export PGHOST=xitter-postgres-rw PGPORT=5432 PGUSER=app PGDATABASE=app
              psql -v ON_ERROR_STOP=1 \
                -v social_pw="$SOCIAL_DB_PASSWORD" \
                -v posts_pw="$POSTS_DB_PASSWORD" \
                -v media_pw="$MEDIA_DB_PASSWORD" \
                -v feed_pw="$FEED_DB_PASSWORD" \
                -v search_pw="$SEARCH_DB_PASSWORD" \
                -v cms_pw="$CMS_DB_PASSWORD" <<'SQL'
              SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'social', :'social_pw')
              WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'social') \gexec
              SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'posts', :'posts_pw')
              WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'posts') \gexec
              SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'media', :'media_pw')
              WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'media') \gexec
              SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'feed', :'feed_pw')
              WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'feed') \gexec
              SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'search', :'search_pw')
              WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'search') \gexec
              SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'cms', :'cms_pw')
              WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cms') \gexec
              SELECT 'CREATE DATABASE social OWNER social'
              WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'social') \gexec
              SELECT 'CREATE DATABASE posts OWNER posts'
              WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'posts') \gexec
              SELECT 'CREATE DATABASE media OWNER media'
              WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'media') \gexec
              SELECT 'CREATE DATABASE feed OWNER feed'
              WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'feed') \gexec
              SELECT 'CREATE DATABASE search OWNER search'
              WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'search') \gexec
              SELECT 'CREATE DATABASE cms OWNER cms'
              WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cms') \gexec
            SQL
            EOT
          ]

          dynamic "env" {
            for_each = local.db_services
            content {
              name = "${upper(env.value)}_DB_PASSWORD"
              value_from {
                secret_key_ref {
                  name = kubernetes_secret.db_url[env.value].metadata[0].name
                  key  = "PASSWORD"
                }
              }
            }
          }
        }
      }
    }

    backoff_limit              = 0
    ttl_seconds_after_finished = 86400
  }

  wait_for_completion = true

  timeouts {
    create = "5m"
    update = "5m"
  }

  depends_on = [kubernetes_manifest.postgres]
}
