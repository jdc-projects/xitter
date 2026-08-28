# NetworkPolicies (spec 07): default deny for xitter workloads, every allow
# explicit. Ingress to workloads only from the edge (traefik), Prometheus
# (metrics scrape), the Knative autoscaler (worker queue-proxy metrics), and
# same-namespace xitter pods (internal APIs). Egress limited to DNS, the
# owned dependencies, OTLP, Keycloak (identity), and TLS to the cluster +
# Cloudflare ranges.
#
# Scope note: the deny applies to xitter workload pods (app.kubernetes.io/
# part-of=xitter - every pod the xitter-service module creates, including
# Knative revisions, which inherit the template labels). Dependency pods
# (CNPG/Kafka/OpenSearch/Valkey/RustFS) additionally get deny-ingress+allow
# policies so datastores are reachable only from their consumers and their
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

  workers = ["fanout", "media-process", "search-index"]

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

# Same-namespace workloads → workloads (internal service APIs, worker
# callbacks). Sources are scoped to xitter pods: dependency pods have no
# egress deny (their operators need connectivity), so an unscoped `from`
# would let a compromised datastore pod reach workload ports. L7
# authorisation stays with the services.
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
        pod_selector {
          match_labels = local.workload_match_labels
        }
      }
    }
  }
}

# Knative autoscaler → worker revision queue-proxy metrics (:9090). The KPA
# scrapes each revision's pod IP directly to drive scale decisions; with
# default-deny ingress this must be explicit or revision pods never go Ready.
# Workers only - API/web/cms/admin pods are plain Deployments with no
# queue-proxy. knative-serving itself runs no deny policies (verified
# read-only), so no matching egress rule is needed there.
# TODO: confirm scrape success once worker images are published (revisions
# are RevisionMissing pre-images, so this is static reasoning, not verified).
resource "kubernetes_network_policy" "allow_knative_autoscaler_ingress" {
  for_each = toset(local.workers)

  metadata {
    name      = "xitter-allow-knative-metrics-${each.key}"
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
          match_labels = { "kubernetes.io/metadata.name" = "knative-serving" }
        }
      }

      ports {
        port     = 9090
        protocol = "TCP"
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

      # 80 is the service port; 8080/9000 are the container ports the
      # service DNATs to. This cluster's Calico evaluates egress policy
      # AFTER DNAT, so the rule must match the real destination ports too
      # - without them every in-cluster Keycloak call (KEYCLOAK_BASE_URL,
      # main.tf's keycloak_incluster_url) times out silently.
      ports {
        port     = 80
        protocol = "TCP"
      }
      ports {
        port     = 8080
        protocol = "TCP"
      }
      ports {
        port     = 9000
        protocol = "TCP"
      }
    }
  }
}

# TLS egress to the canonical Keycloak issuer (https://idp.jd-chapman.dev,
# Cloudflare-fronted). Workloads reach Keycloak via this external URL
# (KEYCLOAK_BASE_URL comes from the homelab remote state; the cluster's
# CoreDNS has no split-horizon, so the name resolves to Cloudflare anycast
# and traffic hairpins back through the edge). Services fetch JWKS / token
# endpoints over 443 from it - the issuer URL must match the token `iss`
# claim exactly, so an internal rewrite is not an option.
#
# What does and does not need outbound 443:
#   - Keycloak (Cloudflare ranges) and future in-cluster TLS (pod CIDR
#     10.42.0.0/16, service CIDR 10.43.0.0/16 - k3s/Calico defaults,
#     verified on the cluster): allowed below.
#   - OTLP export is plain HTTP to the otel namespace (allow_otel_egress).
#   - Image pulls are node-side (containerd), unaffected by pod egress.
#   - Keycloak's in-cluster service is HTTP :80 (allow_keycloak_egress).
#
# Cloudflare's published ranges move slowly; refresh deliberately from
# https://www.cloudflare.com/ips-v4 when identity calls start failing.
variable "cloudflare_ipv4" {
  description = "Cloudflare IPv4 ranges permitted for TLS egress (identity fronting). Refresh from https://www.cloudflare.com/ips-v4."
  type        = list(string)

  default = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]
}

locals {
  tls_egress_cidrs = concat(
    ["10.42.0.0/16", "10.43.0.0/16"],
    var.cloudflare_ipv4,
  )
}

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
      dynamic "to" {
        for_each = local.tls_egress_cidrs

        content {
          ip_block {
            cidr = to.value
          }
        }
      }

      ports {
        port     = 443
        protocol = "TCP"
      }
    }
  }
}

# Same-namespace service-to-service: workers → internal APIs, web → SSR
# service calls, service → service. Scoped to the five API service pods as
# destinations (spec 07: per-dependency egress) - dependency pods (Postgres,
# Kafka, OpenSearch, Valkey, RustFS) are each reachable only via the dedicated
# egress policies below, keyed by the workloads that actually use them.
# Knative revision pods carry the same app.kubernetes.io/name label as their
# worker (set in the revision template - verified on the live Revision CR), so
# worker sources/destinations select correctly.
resource "kubernetes_network_policy" "allow_same_namespace_egress" {
  metadata {
    name      = "xitter-allow-api-egress"
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
          match_expressions {
            key      = "app.kubernetes.io/name"
            operator = "In"
            values   = ["social", "posts", "media", "feed", "search"]
          }
          match_labels = {
            "app.kubernetes.io/instance" = var.environment
          }
        }
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

# Producers (posts/social/media) and consumers (the three workers) only -
# feed/search/cms/admin/web never touch Kafka.
resource "kubernetes_network_policy" "allow_kafka_egress" {
  metadata {
    name      = "xitter-allow-kafka-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_expressions {
        key      = "app.kubernetes.io/name"
        operator = "In"
        values   = concat(["posts", "social", "media"], local.workers)
      }
      match_labels = {
        "app.kubernetes.io/instance" = var.environment
      }
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

# Valkey users: feed (ws fan-out pub/sub, spec 05) plus the services with
# spec'd mutation endpoints for the Valkey rate limiter (spec 07: post/reply
# creation + interactions → posts, follows/blocks → social, upload slots →
# media). Cap.js (login captcha) and the ws-token broker also live in web
# and store through Valkey, so web needs egress too - login 500s without it.
# The three workers read the reset epoch from it to pause/resume themselves
# around a wipe (ADR 0010; prod runs no nightly reset yet - #13 - but the
# workers carry VALKEY_URL and must reach the store either way).
resource "kubernetes_network_policy" "allow_valkey_egress" {
  metadata {
    name      = "xitter-allow-valkey-egress"
    namespace = local.ns
  }

  spec {

    policy_types = ["Egress"]
    pod_selector {
      match_expressions {
        key      = "app.kubernetes.io/name"
        operator = "In"
        values   = concat(["feed", "posts", "social", "media", "web"], local.workers)
      }
      match_labels = {
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
# Postgres: only its consumers on 5432 (the five API services + cms, and the
# db-init bootstrap job - mirrors allow_postgres_egress), the cluster's own
# pods (CNPG replication/instance-manager traffic for when instances > 1),
# the CNPG operator (instance status API), and Prometheus (metrics via
# PodMonitor).
resource "kubernetes_network_policy" "postgres_ingress" {
  metadata {
    name      = "xitter-postgres-ingress"
    namespace = local.ns
  }

  spec {
    pod_selector {
      match_labels = { "cnpg.io/cluster" = "xitter-postgres" }
    }

    policy_types = ["Ingress"]

    ingress {
      from {
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
      }

      from {
        pod_selector {
          match_labels = { "cnpg.io/cluster" = "xitter-postgres" }
        }
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

# Kafka: producers + consumers only (mirrors allow_kafka_egress). Caveat:
# Strimzi additionally manages its own policy (`kafka-network-policy-kafka`)
# whose 9092 rule has no `from` - i.e. cluster-wide. Our rule documents the
# xitter allow-list and would be the effective gate if Strimzi's generated
# policy is ever tightened via the Kafka CR.
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
        pod_selector {
          match_expressions {
            key      = "app.kubernetes.io/name"
            operator = "In"
            values   = concat(["posts", "social", "media"], local.workers)
          }
          match_labels = {
            "app.kubernetes.io/instance" = var.environment
          }
        }
      }

      ports {
        port     = 9092
        protocol = "TCP"
      }
    }
  }
}

# Valkey: its users only (mirrors allow_valkey_egress - web included: its
# session store and rate-limit reads land here, and the ingress policy wins
# over the egress allow on a default-deny+allow pair) + Prometheus
# (metrics exporter).
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
        pod_selector {
          match_expressions {
            key      = "app.kubernetes.io/name"
            operator = "In"
            values   = concat(["feed", "posts", "social", "media", "web"], local.workers)
          }
          match_labels = {
            "app.kubernetes.io/instance" = var.environment
          }
        }
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

# OpenSearch: the search service only (spec 04/05 - search-index keeps the
# index in sync via search's internal bulk API, never OpenSearch directly;
# the index is owned by search), the cluster's own pods on the transport
# port (inter-node traffic once nodePools > 1), and the operator namespace
# (lifecycle management).
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
        pod_selector {
          match_labels = {
            "app.kubernetes.io/name"     = "search"
            "app.kubernetes.io/instance" = var.environment
          }
        }
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
    }

    ingress {
      from {
        pod_selector {
          match_labels = { "opensearch.org/opensearch-cluster" = "opensearch" }
        }
      }

      ports {
        port     = 9300
        protocol = "TCP"
      }
    }
  }
}

# RustFS: its writers only (mirrors allow_rustfs_egress: media service,
# media-process worker, rustfs-provision job) + the edge (public /media
# reads).
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
        pod_selector {
          match_expressions {
            key      = "app.kubernetes.io/name"
            operator = "In"
            values   = ["media", "media-process", "rustfs-provision"]
          }
          match_labels = {
            "app.kubernetes.io/instance" = var.environment
          }
        }
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
