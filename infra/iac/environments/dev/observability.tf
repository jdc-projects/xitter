# T11 observability (spec 06): everything provisioned, nothing hand-clicked.
#
#   - Sentry project + DSN secret (jianyuan/sentry provider, self-hosted
#     Sentry at sentry.jd-chapman.dev).
#   - Scrape config: ServiceMonitor for the API services (/metrics on the app
#     port), PodMonitors for the Knative workers (their dedicated metrics
#     ports - workers expose no k8s Service, so a ServiceMonitor cannot
#     select them). The cluster Prometheus discovers both cluster-wide
#     (ruleSelectorNilUsesHelmValues=false in homelab iac/prometheus).
#   - Alert rules (PrometheusRule): routed by the severity label through the
#     homelab Alertmanager config (warning/critical -> email receiver,
#     severity=none -> null) - that severity routing IS the homelab contact
#     point convention; there are no Grafana-managed notification resources.
#   - Grafana dashboards: GrafanaDashboard CRs picked up by the homelab
#     Grafana instance via the {dashboards=grafana} instanceSelector;
#     grafana-operator files each dashboard into a folder named after this
#     namespace (xitter-dev).

locals {
  # One Sentry project for every workload (spec 06): cross-service traces and
  # issue correlation are the point of Sentry, and they only work when all
  # events land in one stream. dev/prod separation is the environment tag
  # (SENTRY_ENVIRONMENT), per-workload filtering is the `service` tag every
  # SDK init stamps (initSentry / instrumentation-client). This dev state
  # OWNS the project; prod reads it via data sources (see prod's
  # observability.tf) - tofu resources cannot be shared across states.
  #
  # admin ships a static bundle served by its image - wiring needs build-time
  # injection plumbing in the image pipeline, so it stays unwired until then
  # (tracked in the T11 PR notes).
  sentry_wired = ["web", "cms", "social", "posts", "media", "feed", "search", "fanout", "media-process", "search-index"]
}

# ---------------------------------------------------------------------------
# Sentry: team, single project, DSN key, shared K8s secret
# ---------------------------------------------------------------------------
resource "sentry_team" "xitter" {
  organization = "sentry"
  name         = "xitter"
  slug         = "xitter"
}

# The single project all xitter workloads (dev AND prod) report into.
# Platform only picks Sentry's UI defaults (stack rendering, release health),
# not where events go, so "node" is fine for a mixed
# Next.js/browser/NestJS/Node population - per-runtime fidelity comes from
# each SDK, not this field.
resource "sentry_project" "xitter" {
  organization = sentry_team.xitter.organization
  teams        = [sentry_team.xitter.slug]
  name         = "xitter"
  slug         = "xitter"
  platform     = "node"
}

data "sentry_key" "xitter" {
  organization = sentry_project.xitter.organization
  project      = sentry_project.xitter.id
  first        = true
}

# Cap.js bot protection (spec 02 §3.2): site + secret keys from repo
# secrets (docs/runbooks/04-ci-and-secrets.md), passed by the deploy
# workflow as TF_VAR_cap_*. The secret exists unconditionally (possibly
# with empty values when keys were not provided) so references stay
# valid; web only consumes the keys when XITTER_CAP_ENABLED, and
# XITTER_CAP_REQUIRED makes a keys-less apply fail web at boot.
resource "kubernetes_secret" "cap" {
  metadata {
    name      = "xitter-cap"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    XITTER_CAP_SITE_KEY   = var.cap_site_key
    XITTER_CAP_SECRET_KEY = var.cap_secret_key
  }
}

# One shared DSN secret for every wired workload, keyed exactly as the env
# var the SDK reads (SENTRY_DSN). Deployments inject it per-key via
# secret_env; Knative workers envFrom whole secrets, so the key naming is
# the contract either way - both point at this same secret now.
resource "kubernetes_secret" "sentry_dsn" {
  metadata {
    name      = "xitter-sentry"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    SENTRY_DSN = data.sentry_key.xitter.dsn["public"]
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
# Alerts (spec 06 required list)
# ---------------------------------------------------------------------------
resource "kubernetes_manifest" "prometheus_rule" {
  manifest = {
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "PrometheusRule"

    metadata = {
      name      = "xitter-dev"
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
          # request duration histograms for the IngressRoute backends. The
          # exact traefik service label for the web route is confirmed on
          # first apply (naming derives from the IngressRoute).
          name = "xitter-web"
          rules = [
            {
              alert  = "XitterPageP95Latency"
              expr   = "histogram_quantile(0.95, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{service=~\".*xitter-dev-web.*\"}[10m]))) > 2"
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
          # exported per worker (#25); summing by instance gives per-group
          # totals (one group per worker process). 500 messages is the
          # default threshold - fanout is the SLO-critical consumer, tune
          # per group when real baselines exist.
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
          # Reset job (#13 lands the CronJob; these rules render empty until
          # then and get their job_name regex confirmed in that ticket):
          #  - Stale: past 01:00 UTC with no completed run in the last 24h.
          #  - Failed: a recently-completed run reported failure.
          name = "xitter-reset"
          rules = [
            {
              # completion_time only exists for SUCCESSFUL jobs (k8s sets it
              # "when the job finishes successfully, and only then"), so a
              # run that fails every night never produces the series and the
              # stale alert's RHS goes empty. Absent() keeps the stale
              # condition armed in that case too.
              alert  = "XitterResetJobStale"
              expr   = "(hour() >= 1) and on () ((time() - max(kube_job_status_completion_time{namespace=\"xitter-dev\", job_name=~\"xitter-reset.*\"}) > 86400) or absent(kube_job_status_completion_time{namespace=\"xitter-dev\", job_name=~\"xitter-reset.*\"}))"
              for    = "15m"
              labels = { severity = "warning" }
              annotations = {
                summary     = "Nightly reset job has not completed"
                description = "It is past 01:00 UTC and no xitter reset job has completed successfully in the last 24h."
              }
            },
            {
              # A failed job has start_time but no completion_time: detect
              # recent runs (started < 24h ago) that never succeeded.
              alert  = "XitterResetJobFailed"
              expr   = "(time() - kube_job_status_start_time{namespace=\"xitter-dev\", job_name=~\"xitter-reset.*\"} < 86400) and on (job_name, namespace) (kube_job_status_succeeded{namespace=\"xitter-dev\", job_name=~\"xitter-reset.*\"} == 0)"
              for    = "5m"
              labels = { severity = "warning" }
              annotations = {
                summary     = "Nightly reset job failed ({{ $labels.job_name }})"
                description = "A reset job started in the last 24h never completed successfully."
              }
            },
          ]
        },
        {
          # Edge/cert signals. Both come from the homelab edge's own metrics
          # (Traefik ServiceMonitor is enabled in iac/traefik): 5xx rate on
          # xitter routes, and minimum remaining validity across certs the
          # edge serves (the wildcard covers every xitter host; the homelab
          # defines no cert-expiry alert of its own).
          name = "xitter-edge"
          rules = [
            {
              alert  = "XitterEdge5xxRate"
              expr   = "sum(rate(traefik_service_requests_total{code=~\"5..\", service=~\".*xitter-dev.*\"}[5m])) > 0.1"
              for    = "10m"
              labels = { severity = "warning" }
              annotations = {
                summary     = "Edge returning 5xx on xitter routes"
                description = "The edge is serving more than 0.1 5xx responses/s across xitter-dev ingress routes for 10m."
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
# Web vitals is intentionally absent here: CWV comes from the Sentry browser
# SDK, so that view lives in Sentry's Web Vitals pages (spec 06 amended in
# the T11 PR). The reset-job dashboard renders empty until #13 ships the job.
locals {
  dashboard_jsons = {
    for file in fileset("${path.module}/dashboards", "*.json") :
    trimsuffix(file, ".json") => file("${path.module}/dashboards/${file}")
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
