# Observability for prod (T11 pattern, see dev/observability.tf): everything
# provisioned, nothing hand-clicked.
#
#   - Sentry: prod keeps its OWN team + projects (xitter-prod-*) - Sentry
#     slugs are org-global, so reusing dev's `xitter-*` slugs would collide.
#     Dev and prod error streams stay isolated; SENTRY_RELEASE = the semver
#     image tag makes each event traceable to a release.
#   - Scrape config: ServiceMonitor for the API services (/metrics on the app
#     port), PodMonitors for the Knative workers (their dedicated metrics
#     ports - workers expose no k8s Service, so a ServiceMonitor cannot
#     select them). The cluster Prometheus discovers both cluster-wide.
#   - Alert rules (PrometheusRule): routed by the severity label through the
#     homelab Alertmanager config (warning/critical -> email receiver,
#     severity=none -> null). No reset-job group here yet - prod's reset
#     CronJob lands with the data-lifecycle follow-up (#13).
#   - Grafana dashboards: the dashboard JSONs are environment-agnostic (they
#     filter on xitter_* metric labels, not namespaces), so prod renders the
#     SAME files dev does instead of forking copies; the one env-specific
#     dashboard (reset job, hardcoded to xitter-dev) is excluded until prod
#     gets its reset wiring.

locals {
  # One Sentry project per app/service/worker. Platforms follow the SDK
  # actually reporting: web/cms are Next.js (@sentry/nextjs), admin is a
  # static browser bundle, services/workers run @sentry/node.
  sentry_apps = {
    web           = { platform = "javascript-nextjs" }
    cms           = { platform = "javascript-nextjs" }
    admin         = { platform = "javascript" }
    social        = { platform = "node" }
    posts         = { platform = "node" }
    media         = { platform = "node" }
    feed          = { platform = "node" }
    search        = { platform = "node" }
    fanout        = { platform = "node" }
    media-process = { platform = "node" }
    search-index  = { platform = "node" }
  }

  # Workloads whose runtime consumes the DSN secret. admin ships a static
  # bundle served by its image - wiring needs build-time injection plumbing
  # in the image pipeline, so the project + secret exist but stay unwired
  # until then (tracked in the T11 PR notes).
  sentry_wired = ["web", "cms", "social", "posts", "media", "feed", "search", "fanout", "media-process", "search-index"]
}

# ---------------------------------------------------------------------------
# Sentry: team, projects, DSN keys, per-workload K8s secrets
# ---------------------------------------------------------------------------
resource "sentry_team" "xitter" {
  organization = "sentry"
  name         = "xitter prod"
  slug         = "xitter-prod"
}

resource "sentry_project" "app" {
  for_each = local.sentry_apps

  organization = sentry_team.xitter.organization
  teams        = [sentry_team.xitter.slug]
  name         = "xitter-prod-${each.key}"
  slug         = "xitter-prod-${each.key}"
  platform     = each.value.platform
}

data "sentry_key" "app" {
  for_each = local.sentry_apps

  organization = sentry_project.app[each.key].organization
  project      = sentry_project.app[each.key].id
  first        = true
}

# One secret per workload, keyed exactly as the env var the SDK reads
# (SENTRY_DSN). Deployments inject it per-key via secret_env; Knative workers
# envFrom whole secrets, so the key naming is the contract either way.
resource "kubernetes_secret" "sentry_dsn" {
  for_each = local.sentry_apps

  metadata {
    name      = "sentry-${each.key}"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    SENTRY_DSN = data.sentry_key.app[each.key].dsn["public"]
  }
}

# ---------------------------------------------------------------------------
# Scrape config (spec 06 metrics section)
# ---------------------------------------------------------------------------
# API services: RED metrics on /metrics over the existing http Service port.
resource "kubernetes_manifest" "servicemonitor_services" {
  manifest = {
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "ServiceMonitor"

    metadata = {
      name      = "xitter-services"
      namespace = local.ns
      labels    = module.namespace.labels
    }

    spec = {
      selector = {
        matchExpressions = [{
          key      = "app.kubernetes.io/name"
          operator = "In"
          values   = ["social", "posts", "media", "feed", "search"]
        }]
      }

      endpoints = [{
        port     = "http"
        path     = "/metrics"
        interval = "30s"
      }]
    }
  }
}

# Workers: scrape the Knative revision pods directly on their metrics ports
# (9101/9102/9103 - see workloads.tf worker_metrics_ports).
resource "kubernetes_manifest" "podmonitor_workers" {
  for_each = local.worker_metrics_ports

  manifest = {
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "PodMonitor"

    metadata = {
      name      = "xitter-worker-${each.key}"
      namespace = local.ns
      labels    = module.namespace.labels
    }

    spec = {
      selector = {
        matchLabels = {
          "app.kubernetes.io/name" = each.key
        }
      }

      podMetricsEndpoints = [{
        targetPort = each.value
        path       = "/metrics"
        interval   = "30s"
      }]
    }
  }
}

# ---------------------------------------------------------------------------
# Alerts (spec 06 required list; same thresholds as dev)
# ---------------------------------------------------------------------------
resource "kubernetes_manifest" "prometheus_rule" {
  manifest = {
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "PrometheusRule"

    metadata = {
      name      = "xitter-${var.environment}"
      namespace = local.ns
      labels    = module.namespace.labels
    }

    spec = {
      groups = [
        {
          name = "xitter-api"
          rules = [
            {
              alert  = "XitterAPI5xxRate"
              expr   = "sum by (service) (rate(xitter_http_requests_total{status_class=\"5xx\"}[5m])) / sum by (service) (rate(xitter_http_requests_total[5m])) > 0.01"
              for    = "5m"
              labels = { severity = "critical" }
              annotations = {
                summary     = "API 5xx rate above 1% ({{ $labels.service }})"
                description = "{{ $labels.service }} is returning more than 1% 5xx responses over the last 5m."
              }
            },
            {
              alert  = "XitterAPIP95Latency"
              expr   = "histogram_quantile(0.95, sum by (le, service) (rate(xitter_http_request_duration_seconds_bucket[10m]))) > 0.5"
              for    = "10m"
              labels = { severity = "warning" }
              annotations = {
                summary     = "API p95 latency above 500ms ({{ $labels.service }})"
                description = "p95 request duration for {{ $labels.service }} has been above the 500ms SLO for 10m."
              }
            },
          ]
        },
        {
          # Page loads are measured at the edge: Traefik exports per-service
          # request duration histograms for the IngressRoute backends.
          name = "xitter-web"
          rules = [
            {
              alert  = "XitterPageP95Latency"
              expr   = "histogram_quantile(0.95, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{service=~\".*xitter-${var.environment}-web.*\"}[10m]))) > 2"
              for    = "10m"
              labels = { severity = "warning" }
              annotations = {
                summary     = "Web page p95 latency above 2s"
                description = "Edge-measured p95 page load duration has been above the 2s SLO for 10m."
              }
            },
          ]
        },
        {
          # Consumer lag: xitter_kafka_consumer_lag{topic,partition} is
          # exported per worker; summing by instance gives per-group totals.
          name = "xitter-kafka"
          rules = [
            {
              alert  = "XitterConsumerLag"
              expr   = "sum by (instance) (xitter_kafka_consumer_lag) > 500"
              for    = "10m"
              labels = { severity = "critical" }
              annotations = {
                summary     = "Kafka consumer lag above threshold ({{ $labels.instance }})"
                description = "Total consumer lag for {{ $labels.instance }} has exceeded 500 messages for 10m. Fanout lag directly delays time-to-feed."
              }
            },
          ]
        },
        {
          # Edge/cert signals. Both come from the homelab edge's own metrics:
          # 5xx rate on xitter routes, and minimum remaining validity across
          # certs the edge serves (the wildcard covers every xitter host).
          name = "xitter-edge"
          rules = [
            {
              alert  = "XitterEdge5xxRate"
              expr   = "sum(rate(traefik_service_requests_total{code=~\"5..\", service=~\".*xitter-${var.environment}.*\"}[5m])) > 0.1"
              for    = "10m"
              labels = { severity = "warning" }
              annotations = {
                summary     = "Edge returning 5xx on xitter routes"
                description = "The edge is serving more than 0.1 5xx responses/s across xitter-${var.environment} ingress routes for 10m."
              }
            },
            {
              alert  = "XitterCertExpiringSoon"
              expr   = "min(traefik_tls_certs_not_after) - time() < 14 * 24 * 3600"
              for    = "1h"
              labels = { severity = "warning" }
              annotations = {
                summary     = "TLS certificate served by the edge expires within 14 days"
                description = "A certificate the edge serves (incl. the wildcard covering xitter hosts) expires in under 14 days."
              }
            },
          ]
        },
      ]
    }
  }
}

# ---------------------------------------------------------------------------
# Grafana dashboards (spec 06 required list)
# ---------------------------------------------------------------------------
# The dashboard JSONs live with dev and are env-agnostic (labels filter on
# xitter_* metrics, not namespaces); rendering the same files here keeps one
# source of truth instead of forks. The reset-job dashboard hardcodes
# xitter-dev and lands here with prod's reset wiring (#13).
locals {
  dashboard_jsons = {
    for file in fileset("${path.module}/../dev/dashboards", "*.json") :
    trimsuffix(file, ".json") => file("${path.module}/../dev/dashboards/${file}")
    if file != "xitter-reset-job.json"
  }
}

resource "kubernetes_manifest" "grafana_dashboard" {
  for_each = local.dashboard_jsons

  manifest = {
    apiVersion = "grafana.integreatly.org/v1beta1"
    kind       = "GrafanaDashboard"

    metadata = {
      name      = "xitter-${each.key}"
      namespace = local.ns
      labels    = module.namespace.labels
    }

    spec = {
      allowCrossNamespaceImport = true

      # The homelab Grafana instance's fixed selector (iac/modules/
      # grafana-dashboard is the single source of truth for this label).
      instanceSelector = {
        matchLabels = { dashboards = "grafana" }
      }

      json = each.value
    }
  }
}
