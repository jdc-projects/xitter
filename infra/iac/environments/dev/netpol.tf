# NetworkPolicies (spec 07): default deny for xitter workloads, every allow
# explicit. Ingress to workloads only from the edge (traefik), Prometheus
# (metrics scrape), and same-namespace pods (internal APIs). Egress limited
# to DNS, the owned dependencies, OTLP, and Keycloak (identity).
#
# Scope note: the deny applies to xitter workload pods (app.kubernetes.io/
# part-of=xitter - every pod the xitter-service module creates, including
# Knative revisions, which inherit the template labels). Dependency pods
# (CNPG/Kafka/OpenSearch/Valkey/RustFS) additionally get deny-ingress+allow
# policies so datastores are reachable only from this namespace and their
# operators - but no egress deny, because the cluster operators (which run
# in other namespaces) need to reach their CRs' pods and vice versa.

locals {
  # Namespace names verified read-only on the cluster.
  edge_namespace       = "traefik"
  monitoring_namespace = "prometheus"
  dns_namespace        = "kube-system"

  workload_match_labels = {
    "app.kubernetes.io/part-of"  = "xitter"
    "app.kubernetes.io/instance" = var.environment
  }

  # Metrics listener per workload: services share the app port, workers use
  # their dedicated metrics ports.
  metrics_ports = merge(
    { for s in ["social", "posts", "media", "feed", "search"] : s => 8080 },
    local.worker_metrics_ports,
  )
}

# ---------------------------------------------------------------------------
# Default deny: ingress for every pod in the namespace, egress for xitter
# workload pods (dependency pods keep unrestricted egress - their operators,
# which run in other namespaces, manage their lifecycles).
# ---------------------------------------------------------------------------
resource "kubernetes_network_policy" "default_deny_ingress" {
  metadata {
    name      = "xitter-default-deny-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {}

    policy_types = ["Ingress"]
  }
}

resource "kubernetes_network_policy" "default_deny_egress" {
  metadata {
    name      = "xitter-default-deny-egress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = local.workload_match_labels
    }

    policy_types = ["Egress"]
  }
}

# ---------------------------------------------------------------------------
# Ingress allows
# ---------------------------------------------------------------------------
# Edge → public workload ports (web/cms/admin/API services + RustFS /media).
resource "kubernetes_network_policy" "allow_edge_ingress" {
  for_each = toset(["web", "cms", "admin", "social", "posts", "media", "feed", "search"])

  metadata {
    name      = "xitter-allow-edge-${each.key}"
    namespace = local.ns
  }

  spec {

    policy_types = ["Ingress"]
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"     = each.key
        "app.kubernetes.io/instance" = var.environment
      }
    }

    ingress {
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = local.edge_namespace }
        }
      }

      ports {
        port     = each.key == "web" || each.key == "cms" ? 3000 : 8080
        protocol = "TCP"
      }
    }
  }
}

# Prometheus → metrics ports (services 8080, worker metric ports).
resource "kubernetes_network_policy" "allow_metrics_ingress" {
  for_each = toset(["social", "posts", "media", "feed", "search", "fanout", "media-process", "search-index"])

  metadata {
    name      = "xitter-allow-metrics-${each.key}"
    namespace = local.ns
  }

  spec {

    policy_types = ["Ingress"]
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"     = each.key
        "app.kubernetes.io/instance" = var.environment
      }
    }

    ingress {
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = local.monitoring_namespace }
        }
      }

      ports {
        port     = local.metrics_ports[each.key]
        protocol = "TCP"
      }
    }
  }
}

# Same-namespace → workloads (internal service APIs, worker callbacks,
# kubelet-adjacent checks). L7 authorisation stays with the services.
resource "kubernetes_network_policy" "allow_internal_ingress" {
  metadata {
    name      = "xitter-allow-internal-ingress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Ingress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    ingress {
      from {
        pod_selector {}
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Egress allows (all workloads)
# ---------------------------------------------------------------------------
resource "kubernetes_network_policy" "allow_dns_egress" {
  metadata {
    name      = "xitter-allow-dns-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = local.dns_namespace }
        }
        pod_selector {
          match_labels = { "k8s-app" = "kube-dns" }
        }
      }

      ports {
        port     = 53
        protocol = "UDP"
      }
      ports {
        port     = 53
        protocol = "TCP"
      }
    }
  }
}

# OTLP traces → otel-collector.
resource "kubernetes_network_policy" "allow_otel_egress" {
  metadata {
    name      = "xitter-allow-otel-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "otel" }
        }
      }

      ports {
        port     = 4318
        protocol = "TCP"
      }
    }
  }
}

# Identity: Keycloak token endpoints (in-cluster service; the canonical
# external issuer, https://idp.jd-chapman.dev, is fronted by the same pods).
resource "kubernetes_network_policy" "allow_keycloak_egress" {
  metadata {
    name      = "xitter-allow-keycloak-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "keycloak" }
        }
      }

      ports {
        port     = 80
        protocol = "TCP"
      }
    }
  }
}

# TLS egress to the canonical Keycloak issuer (https://idp.jd-chapman.dev,
# Cloudflare-fronted, so it cannot be expressed as a CIDR) - workloads that
# validate tokens fetch JWKS from the issuer URL, which must match the token
# `iss` claim exactly. Scoped to 443 only.
resource "kubernetes_network_policy" "allow_identity_tls_egress" {
  metadata {
    name      = "xitter-allow-identity-tls-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    egress {
      to {
        ip_block {
          cidr = "0.0.0.0/0"
        }
      }

      ports {
        port     = 443
        protocol = "TCP"
      }
    }
  }
}

# Same-namespace service-to-service (workers → internal APIs, web → SSR
# service calls).
resource "kubernetes_network_policy" "allow_same_namespace_egress" {
  metadata {
    name      = "xitter-allow-same-namespace-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    egress {
      to {
        pod_selector {}
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Egress allows (per dependency, only the workloads that use it)
# ---------------------------------------------------------------------------
resource "kubernetes_network_policy" "allow_postgres_egress" {
  metadata {
    name      = "xitter-allow-postgres-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_expressions {
        key      = "app.kubernetes.io/name"
        operator = "In"
        values   = ["social", "posts", "media", "feed", "search", "cms", "db-init"]
      }
      match_labels = {
        "app.kubernetes.io/instance" = var.environment
      }
    }

    egress {
      to {
        pod_selector {
          match_labels = { "cnpg.io/cluster" = "xitter-postgres" }
        }
      }

      ports {
        port     = 5432
        protocol = "TCP"
      }
    }
  }
}

resource "kubernetes_network_policy" "allow_kafka_egress" {
  metadata {
    name      = "xitter-allow-kafka-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = local.workload_match_labels
    }

    egress {
      to {
        pod_selector {
          match_labels = { "strimzi.io/cluster" = "kafka" }
        }
      }

      ports {
        port     = 9092
        protocol = "TCP"
      }
    }
  }
}

resource "kubernetes_network_policy" "allow_valkey_egress" {
  metadata {
    name      = "xitter-allow-valkey-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"     = "feed"
        "app.kubernetes.io/instance" = var.environment
      }
    }

    egress {
      to {
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "valkey" }
        }
      }

      ports {
        port     = 6379
        protocol = "TCP"
      }
    }
  }
}

resource "kubernetes_network_policy" "allow_opensearch_egress" {
  metadata {
    name      = "xitter-allow-opensearch-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"     = "search"
        "app.kubernetes.io/instance" = var.environment
      }
    }

    egress {
      to {
        pod_selector {
          match_labels = { "opensearch.org/opensearch-cluster" = "opensearch" }
        }
      }

      ports {
        port     = 9200
        protocol = "TCP"
      }
    }
  }
}

# media service + media-process worker write to RustFS; the provision job
# bootstraps the bucket.
resource "kubernetes_network_policy" "allow_rustfs_egress" {
  for_each = toset(["media", "media-process", "rustfs-provision"])

  metadata {
    name      = "xitter-allow-rustfs-egress-${each.key}"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"     = each.key
        "app.kubernetes.io/instance" = var.environment
      }
    }

    egress {
      to {
        pod_selector {
          match_labels = { "app.kubernetes.io/name" = "rustfs" }
        }
      }

      ports {
        port     = 9000
        protocol = "TCP"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Datastore ingress isolation (deny + narrow allows)
# ---------------------------------------------------------------------------
# Postgres: only this namespace's pods (workloads + db-init job), the CNPG
# operator (instance status API), and Prometheus (metrics scrape via PodMonitor).
resource "kubernetes_network_policy" "postgres_ingress" {
  metadata {
    name      = "xitter-postgres-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = { "cnpg.io/clusterName" = "xitter-postgres" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {}
      }

      ports {
        port     = 5432
        protocol = "TCP"
      }
    }

    ingress {
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "cloudnative-pg" }
        }
      }

      ports {
        port     = 8000
        protocol = "TCP"
      }
      ports {
        port     = 8001
        protocol = "TCP"
      }
    }

    ingress {
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = local.monitoring_namespace }
        }
      }

      ports {
        port     = 9187
        protocol = "TCP"
      }
    }
  }
}

# Kafka: Strimzi manages its own policies; add this-namespace access on 9092.
resource "kubernetes_network_policy" "kafka_ingress" {
  metadata {
    name      = "xitter-kafka-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = { "strimzi.io/cluster" = "kafka" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {}
      }

      ports {
        port     = 9092
        protocol = "TCP"
      }
    }
  }
}

# Valkey: only this namespace's pods + Prometheus (metrics exporter).
resource "kubernetes_network_policy" "valkey_ingress" {
  metadata {
    name      = "xitter-valkey-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = { "app.kubernetes.io/name" = "valkey" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {}
      }

      ports {
        port     = 6379
        protocol = "TCP"
      }
    }

    ingress {
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = local.monitoring_namespace }
        }
      }

      ports {
        port     = 9121
        protocol = "TCP"
      }
    }
  }
}

# OpenSearch: this namespace + the operator namespace (lifecycle management).
resource "kubernetes_network_policy" "opensearch_ingress" {
  metadata {
    name      = "xitter-opensearch-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = { "opensearch.org/opensearch-cluster" = "opensearch" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {}
      }

      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "opensearch-operator" }
        }
      }

      ports {
        port     = 9200
        protocol = "TCP"
      }
      ports {
        port     = 9300
        protocol = "TCP"
      }
    }
  }
}

# RustFS: this namespace + the edge (public /media reads).
resource "kubernetes_network_policy" "rustfs_ingress" {
  metadata {
    name      = "xitter-rustfs-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = { "app.kubernetes.io/name" = "rustfs" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
        pod_selector {}
      }

      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = local.edge_namespace }
        }
      }

      ports {
        port     = 9000
        protocol = "TCP"
      }
    }
  }
}
