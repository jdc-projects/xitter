# Cluster dependencies for the dev environment: CNPG Postgres, Strimzi Kafka,
# Valkey (Helm - no Valkey CRDs on this cluster), OpenSearch (operator CR),
# RustFS (Helm + provision job). Patterns mirror the homelab reference envs
# (huly/posthog/outline).

locals {
  # Versions pinned to match the operators / reference deployments in the
  # cluster (verified read-only): CNPG images 16.x-standard-trixie, Strimzi
  # 0.51.0 serving Kafka 4.1.0, OpenSearch operator running 2.13.0.
  postgres_image     = "ghcr.io/cloudnative-pg/postgresql:16.14-standard-trixie"
  kafka_version      = "4.1.0"
  opensearch_version = "2.13.0"
  valkey_chart       = "0.10.0"
  rustfs_chart       = "0.9.0"
  minio_mc_image     = "minio/mc:RELEASE.2025-08-13T08-35-41Z"

  # Storage classes verified via `kubectl get storageclass`; matches what the
  # homelab's CNPG/Kafka/OpenSearch deployments already use.
  db_storage_class   = "openebs-zfs-localpv-random"
  bulk_storage_class = "openebs-zfs-localpv-bulk"

  kafka_topics = ["xitter.posts.v1", "xitter.social.v1", "xitter.media.v1"]

  rustfs_bucket = "xitter-media"
  rustfs_svc    = "rustfs-svc"
}

# ---------------------------------------------------------------------------
# Postgres (CNPG)
# ---------------------------------------------------------------------------
resource "kubernetes_secret" "postgres_app" {
  metadata {
    name      = "xitter-postgres-app"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    username = "app"
    password = random_password.postgres_app.result
  }
}

resource "kubernetes_manifest" "postgres" {
  manifest = {
    apiVersion = "postgresql.cnpg.io/v1"
    kind       = "Cluster"

    metadata = {
      name      = "xitter-postgres"
      namespace = local.ns

      labels = {
        "velero.io/exclude-from-backup" = "true"
      }
    }

    spec = {
      imageName = local.postgres_image

      # Dev: a single instance is acceptable (ticket #2); prod will run 2+.
      instances = 1

      monitoring = {
        enablePodMonitor = true
      }

      postgresql = {
        parameters = {
          shared_buffers = "128MB"
        }
      }

      bootstrap = {
        initdb = {
          database = "app"
          owner    = "app"
          secret = {
            name = kubernetes_secret.postgres_app.metadata[0].name
          }

          # Runs once at bootstrap (as the postgres superuser). Grants the app
          # owner enough privilege for the db-init job (below) to create the
          # per-service roles/databases; per-service passwords never appear in
          # the CR spec - only in Secrets.
          postInitSQL = [
            "ALTER ROLE app CREATEROLE CREATEDB"
          ]
        }
      }

      storage = {
        storageClass = local.db_storage_class
        size         = "10Gi"

        pvcTemplate = {
          accessModes = ["ReadWriteOnce"]
        }
      }

      resources = {
        requests = {
          cpu    = "250m"
          memory = "512Mi"
        }
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      primaryUpdateStrategy = "unsupervised"
      primaryUpdateMethod   = "switchover"

      logLevel = "info"
    }
  }

  field_manager {
    force_conflicts = true
  }

  computed_fields = [
    "metadata.labels",
    "metadata.annotations",
    "spec.postgresql.parameters",
    "spec.monitoring",
  ]

  wait {
    fields = {
      "status.phase" = "Cluster in healthy state"
    }
  }
}

# ---------------------------------------------------------------------------
# Kafka (Strimzi)
# ---------------------------------------------------------------------------
resource "kubernetes_manifest" "kafka" {
  manifest = {
    apiVersion = "kafka.strimzi.io/v1beta2"
    kind       = "Kafka"

    metadata = {
      name      = "kafka"
      namespace = local.ns
    }

    spec = {
      kafka = {
        version = local.kafka_version

        listeners = [
          {
            name = "plain"
            port = 9092
            type = "internal"
            tls  = false
          }
        ]

        config = {
          "offsets.topic.replication.factor"         = "1"
          "transaction.state.log.replication.factor" = "1"
          "transaction.state.log.min.isr"            = "1"
          "default.replication.factor"               = "1"
          "min.insync.replicas"                      = "1"
        }
      }

      entityOperator = {
        topicOperator = {}
      }
    }
  }

  computed_fields = [
    "metadata.labels",
    "metadata.annotations",
  ]
}

resource "kubernetes_manifest" "kafka_node_pool" {
  manifest = {
    apiVersion = "kafka.strimzi.io/v1beta2"
    kind       = "KafkaNodePool"

    metadata = {
      name      = "mixed"
      namespace = local.ns

      labels = {
        "strimzi.io/cluster" = "kafka"
      }
    }

    spec = {
      replicas = 1
      roles    = ["controller", "broker"]

      storage = {
        type        = "persistent-claim"
        size        = "10Gi"
        class       = local.bulk_storage_class
        deleteClaim = false
      }

      resources = {
        requests = {
          cpu    = "250m"
          memory = "512Mi"
        }
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }
  }

  depends_on = [kubernetes_manifest.kafka]
}

resource "kubernetes_manifest" "kafka_topics" {
  for_each = toset(local.kafka_topics)

  manifest = {
    apiVersion = "kafka.strimzi.io/v1beta2"
    kind       = "KafkaTopic"

    metadata = {
      name      = each.key
      namespace = local.ns

      labels = {
        "strimzi.io/cluster" = "kafka"
      }
    }

    spec = {
      # Spec 04 sizes these at 6 partitions; dev runs 1 (single-node Kafka,
      # no consumers to parallelise) - partitions can be grown later without
      # recreation.
      partitions = 1
      replicas   = 1
      topicName  = each.key
    }
  }

  depends_on = [kubernetes_manifest.kafka, kubernetes_manifest.kafka_node_pool]
}

# Short, stable bootstrap address for apps: `kafka.<ns>.svc:9092` instead of
# the Strimzi-generated `kafka-kafka-bootstrap` (homelab pattern).
resource "kubernetes_service_v1" "kafka" {
  metadata {
    name      = "kafka"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  spec {
    port {
      name        = "kafka"
      port        = 9092
      target_port = 9092
      protocol    = "TCP"
    }

    selector = {
      "strimzi.io/cluster" = "kafka"
      "strimzi.io/name"    = "kafka-kafka"
    }
  }

  depends_on = [kubernetes_manifest.kafka]
}

# ---------------------------------------------------------------------------
# Valkey (Helm chart - no Valkey operator/CRDs on this cluster)
# ---------------------------------------------------------------------------
resource "helm_release" "valkey" {
  name       = "valkey"
  namespace  = local.ns
  repository = "https://valkey.io/valkey-helm/"
  chart      = "valkey"
  version    = local.valkey_chart

  timeout = 300

  set = [
    { name = "resources.requests.cpu", value = "100m" },
    { name = "resources.requests.memory", value = "128Mi" },
    { name = "resources.limits.cpu", value = "500m" },
    { name = "resources.limits.memory", value = "256Mi" },
    { name = "metrics.enabled", value = "true" },
    { name = "metrics.serviceMonitor.enabled", value = "true" },
  ]
}

# ---------------------------------------------------------------------------
# OpenSearch (operator CR, single node, security disabled - dev pattern)
# ---------------------------------------------------------------------------
resource "kubernetes_manifest" "opensearch" {
  manifest = {
    apiVersion = "opensearch.org/v1"
    kind       = "OpenSearchCluster"

    metadata = {
      name      = "opensearch"
      namespace = local.ns
    }

    spec = {
      general = {
        version     = local.opensearch_version
        httpPort    = 9200
        serviceName = "opensearch"

        additionalConfig = {
          "plugins.security.disabled" = "true"
          "node.name"                 = "opensearch-bootstrap-0"
        }
      }

      nodePools = [
        {
          component = "nodes"
          replicas  = 1
          diskSize  = "10Gi"

          persistence = {
            pvc = {
              storageClass = local.bulk_storage_class
              accessModes  = ["ReadWriteOnce"]
            }
          }

          jvm = "-Xms512m -Xmx512m"

          roles = [
            "cluster_manager",
            "data",
            "ingest",
          ]

          env = [
            { name = "DISABLE_INSTALL_DEMO_CONFIG", value = "true" },
          ]

          resources = {
            requests = {
              cpu    = "250m"
              memory = "1Gi"
            }
            limits = {
              cpu    = "500m"
              memory = "1Gi"
            }
          }
        },
      ]
    }
  }

  field_manager {
    force_conflicts = true
  }

  computed_fields = [
    "metadata.labels",
    "metadata.annotations",
  ]
}

# ---------------------------------------------------------------------------
# RustFS (S3-compatible object store; media bucket is public-read at /media)
# ---------------------------------------------------------------------------
resource "kubernetes_persistent_volume_claim" "rustfs" {
  metadata {
    name      = "rustfs"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = local.bulk_storage_class

    resources {
      requests = {
        storage = "20Gi"
      }
    }
  }

  lifecycle {
    ignore_changes = [spec[0].selector]
  }
}

resource "random_password" "rustfs_root_username" {
  length  = 20
  numeric = true
  special = false
  upper   = true
}

resource "random_password" "rustfs_root_password" {
  length  = 40
  numeric = true
  special = false
  upper   = true
}

resource "helm_release" "rustfs" {
  name       = "rustfs"
  namespace  = local.ns
  repository = "https://charts.rustfs.com/"
  chart      = "rustfs"
  version    = local.rustfs_chart

  timeout = 300

  set = [
    { name = "fullnameOverride", value = "rustfs" },
    { name = "mode.standalone.enabled", value = "true" },
    { name = "mode.distributed.enabled", value = "false" },
    { name = "mode.standalone.existingClaim.dataClaim", value = kubernetes_persistent_volume_claim.rustfs.metadata[0].name },
    { name = "config.rustfs.obs_log_directory", value = "" },
    { name = "config.rustfs.region", value = "us-east-1" },
    { name = "ingress.enabled", value = "false" },
    { name = "resources.requests.cpu", value = "100m" },
    { name = "resources.requests.memory", value = "512Mi" },
    { name = "resources.limits.cpu", value = "1" },
    { name = "resources.limits.memory", value = "1Gi" },
  ]

  set_sensitive = [
    { name = "secret.rustfs.access_key", value = random_password.rustfs_root_username.result },
    { name = "secret.rustfs.secret_key", value = random_password.rustfs_root_password.result },
  ]
}

# Provisioner credentials as a Secret (mirrors db-init: nothing sensitive
# lands in the Job spec). Same random_password values the Helm release gets
# via set_sensitive, so job and server always agree.
resource "kubernetes_secret" "rustfs_provision" {
  metadata {
    name      = "rustfs-provision"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    RUSTFS_ACCESS_KEY = random_password.rustfs_root_username.result
    RUSTFS_SECRET_KEY = random_password.rustfs_root_password.result
  }
}

# One-shot bucket provisioning: creates the public-read `xitter-media` bucket
# and sets CORS so browsers can presigned-PUT media from the web origin
# (outline/posthog pattern). Idempotent: alias set overwrites, mb uses
# --ignore-existing, anonymous set and cors set are re-applies.
resource "kubernetes_job" "rustfs_provision" {
  metadata {
    name      = "rustfs-provision"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  spec {
    template {
      metadata {
        labels = merge(module.namespace.labels, {
          "app.kubernetes.io/name" = "rustfs-provision"
        })
      }

      spec {
        restart_policy = "Never"

        container {
          name  = "rustfs-provision"
          image = local.minio_mc_image

          command = [
            "/bin/sh",
            "-c",
            <<-EOT
              i=0
              until mc alias set rustfs http://${local.rustfs_svc}:9000 "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY"; do
                i=$$((i+1)); [ $$i -ge 60 ] && echo "rustfs not ready, giving up" && exit 1
                echo "waiting for rustfs... ($$i)"; sleep 2
              done
              mc mb --ignore-existing rustfs/${local.rustfs_bucket}
              # Media is served unauthenticated at /media (spec 01): the whole
              # bucket is public-read; uploads still require credentials.
              mc anonymous set download rustfs/${local.rustfs_bucket}
              # Browser presigned uploads are cross-origin from the edge host.
              printf '%s' '<CORSConfiguration><CORSRule><AllowedOrigin>https://${var.domain}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3000</MaxAgeSeconds></CORSRule></CORSConfiguration>' > /tmp/cors.xml
              mc cors set rustfs/${local.rustfs_bucket} /tmp/cors.xml
            EOT
          ]

          env {
            name = "RUSTFS_ACCESS_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.rustfs_provision.metadata[0].name
                key  = "RUSTFS_ACCESS_KEY"
              }
            }
          }

          env {
            name = "RUSTFS_SECRET_KEY"
            value_from {
              secret_key_ref {
                name = kubernetes_secret.rustfs_provision.metadata[0].name
                key  = "RUSTFS_SECRET_KEY"
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

  depends_on = [helm_release.rustfs, kubernetes_secret.rustfs_provision]
}
