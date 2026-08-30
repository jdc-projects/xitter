# Cluster dependencies for the prod environment: CNPG Postgres, Strimzi Kafka,
# Valkey (Helm - no Valkey CRDs on this cluster), OpenSearch (operator CR),
# RustFS (Helm + provision job). Mirrors dev; sizing deltas are commented
# in place (dev runs 1 Postgres / 2 OpenSearch nodes - see dev/deps.tf).

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

      # Prod: 2 instances (dev's single instance is dev-only) - CNPG can then
      # roll the primary with a supervised switchover instead of downtime.
      # Not 3: this is a disposable demo; 2 + nightly-verified tofu apply is
      # the deliberate cost/stability middle ground.
      instances = 2

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
        type  = "persistent-claim"
        size  = "10Gi"
        class = local.bulk_storage_class
        # Recreating the CR (cluster id change, env rebuild) converges onto
        # fresh storage instead of crash-looping on stale volumes. Dev data
        # is disposable per ops spec 01; the nightly reset itself does NOT
        # wipe Kafka (ops spec 02 resets consumer groups only).
        deleteClaim = true
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
# OpenSearch (raw StatefulSet, 2-node, security disabled)
# ---------------------------------------------------------------------------
# No operator. The opensearch-k8s-operator 3.0.0-alpha's bootstrap flow is
# structurally un-winnable for cold formation: it deletes its bootstrap pod
# - the node it stamps into cluster.initial_master_nodes - off a readiness
# signal that repeatedly fired before the second data node's join committed
# into the voting config (four bricked formations, observed live: the
# survivors then fail "an election requires a node with id [bootstrap]"
# forever, every cluster-state API hangs, search wedges at boot). Its env
# cannot be overridden either (nodePool.env duplicate is appended after the
# operator's - the operator's value won, observed live), so the operator
# path was abandoned rather than raced.
#
# This StatefulSet self-bootstraps: node.name defaults to each pod's
# hostname (opensearch-nodes-{0,1} - the STS guarantees those identities
# and their PVCs), discovery.seed_hosts is the headless service, and
# cluster.initial_master_nodes pins the voting config to exactly the two
# data nodes from the first commit - no transient third member can ever
# freeze a quorum. The setting is inert after first formation; restarts
# and reschedules rejoin from persisted cluster state on the same PVCs.
#
# podManagementPolicy is Parallel on purpose: the election needs BOTH
# nodes, and OrderedReady would deadlock it with the join-gated readiness
# probe below (nodes-1 is only created after nodes-0 is Ready, but the
# election - and therefore readiness - needs nodes-1 up).
#
# Two replicas, not one: quorum of 2 with zero failure tolerance - losing
# one node pauses writes until it returns. Acceptable for dev (disposable
# data, nightly reset). Prod sizes identically for now.
locals {
  opensearch_nodes = ["opensearch-nodes-0", "opensearch-nodes-1"]
}

resource "kubernetes_config_map" "opensearch_config" {
  metadata {
    name      = "opensearch-config"
    namespace = local.ns
    labels    = { "opensearch.org/opensearch-cluster" = "opensearch" }
  }

  data = {
    "opensearch.yml" = <<-YAML
      cluster.name: opensearch
      network.host: 0.0.0.0
      http.port: 9200
      transport.port: 9300
      plugins.security.disabled: true
      discovery.seed_hosts: [opensearch-discovery]
      cluster.initial_master_nodes: [${join(", ", local.opensearch_nodes)}]
    YAML
  }
}

# Headless discovery service: resolves to every node pod's address, which
# is all discovery.seed_hosts needs (the operator used the same name, so
# nothing downstream changes).
resource "kubernetes_service" "opensearch_discovery" {
  metadata {
    name      = "opensearch-discovery"
    namespace = local.ns
    labels    = { "opensearch.org/opensearch-cluster" = "opensearch" }
  }

  spec {
    cluster_ip = "None"
    selector = {
      "opensearch.org/opensearch-cluster" = "opensearch"
    }

    port {
      name        = "transport"
      port        = 9300
      protocol    = "TCP"
      target_port = 9300
    }
  }
}

# Client service: same name the workloads and reset flow already target.
resource "kubernetes_service" "opensearch" {
  metadata {
    name      = "opensearch"
    namespace = local.ns
    labels    = { "opensearch.org/opensearch-cluster" = "opensearch" }
  }

  spec {
    selector = {
      "opensearch.org/opensearch-cluster" = "opensearch"
    }

    port {
      name        = "http"
      port        = 9200
      protocol    = "TCP"
      target_port = 9200
    }

    port {
      name        = "transport"
      port        = 9300
      protocol    = "TCP"
      target_port = 9300
    }
  }
}

resource "kubernetes_stateful_set" "opensearch_nodes" {
  metadata {
    name      = "opensearch-nodes"
    namespace = local.ns
    labels    = { "opensearch.org/opensearch-cluster" = "opensearch" }
  }

  spec {
    service_name          = "opensearch-discovery"
    replicas              = 2
    pod_management_policy = "Parallel"

    selector {
      match_labels = {
        "opensearch.org/opensearch-cluster" = "opensearch"
      }
    }

    template {
      metadata {
        labels = {
          "opensearch.org/opensearch-cluster" = "opensearch"
        }
      }

      spec {
        termination_grace_period_seconds = 120

        init_container {
          name  = "init-sysctl"
          image = "busybox:1.36"

          command = ["sh", "-c", "sysctl -w vm.max_map_count=262144"]

          security_context {
            privileged = true
          }
        }

        container {
          name  = "opensearch"
          image = "opensearchproject/opensearch:${local.opensearch_version}"

          port {
            name           = "http"
            container_port = 9200
          }

          port {
            name           = "transport"
            container_port = 9300
          }

          env = [
            { name = "DISABLE_INSTALL_DEMO_CONFIG", value = "true" },
            { name = "OPENSEARCH_JAVA_OPTS", value = "-Xms512m -Xmx512m" },
          ]

          # Readiness = joined (the health endpoint only answers 200 once
          # this node participates in an elected cluster with both nodes).
          # Parallel pod creation means this can never deadlock formation.
          readiness_probe {
            exec {
              command = [
                "/bin/bash",
                "-c",
                "curl --silent --fail 'http://localhost:9200/_cluster/health?wait_for_nodes=2&wait_for_status=yellow&timeout=25s'",
              ]
            }

            initial_delay_seconds = 60
            period_seconds        = 15
            timeout_seconds       = 30
            failure_threshold     = 5
          }

          liveness_probe {
            tcp_socket {
              port = 9200
            }

            initial_delay_seconds = 120
            period_seconds        = 20
            timeout_seconds       = 5
            failure_threshold     = 10
          }

          resources {
            requests = {
              cpu    = "250m"
              memory = "1Gi"
            }
            limits = {
              cpu    = "500m"
              memory = "1Gi"
            }
          }

          volume_mount {
            name       = "config"
            mount_path = "/usr/share/opensearch/config/opensearch.yml"
            sub_path   = "opensearch.yml"
          }

          volume_mount {
            name       = "data"
            mount_path = "/usr/share/opensearch/data"
          }
        }

        volume {
          name = "config"

          config_map {
            name = kubernetes_config_map.opensearch_config.metadata[0].name
          }
        }
      }
    }

    # Same PVC names the operator created (data-opensearch-nodes-{0,1}) -
    # nothing downstream (netpols, reset flow, dashboards) changes.
    volume_claim_templates {
      metadata {
        name   = "data"
        labels = { "opensearch.org/opensearch-cluster" = "opensearch" }
      }

      spec {
        access_modes       = ["ReadWriteOnce"]
        storage_class_name = local.bulk_storage_class

        resources {
          requests = {
            storage = "10Gi"
          }
        }
      }
    }
  }
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
