# The 11 xitter workloads via the shared xitter-service module:
#   - 5 API services  (Deployment + Service + HPA)
#   - 3 workers       (Knative Services, cluster-local)
#   - web, cms        (Deployments + Service)
#   - admin           (static image + Service)
# Images come from part A's CI publishing contract:
#   ghcr.io/jdc-projects/xitter-{name}:${var.image_tag}

locals {
  # In-cluster service addresses (namespace-internal, never through the edge).
  svc_base = { for s in ["social", "posts", "media", "feed", "search"] : s => "http://${s}.${local.ns}.svc:8080" }

  common_env = [
    { name = "XITTER_ENV", value = var.environment },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = local.otel_endpoint },
  ]

  worker_metrics_ports = {
    "fanout"        = 9101
    "media-process" = 9102
    "search-index"  = 9103
  }

  # Cross-service dependencies (namespace-internal, never via the edge).
  # posts calls social's internal relationship endpoint for reply block
  # enforcement (#5); authn is M2M via KEYCLOAK_CLIENT_ID/SECRET below.
  service_extra_env = {
    posts = [{ name = "XITTER_SOCIAL_URL", value = local.svc_base.social }]
  }
}

# ---------------------------------------------------------------------------
# API services
# ---------------------------------------------------------------------------
module "api_service" {
  for_each = toset(["social", "posts", "media", "feed", "search"])
  source   = "../../modules/xitter-service"

  name        = each.key
  namespace   = local.ns
  environment = var.environment
  image       = "${var.image_registry}/xitter-${each.key}:${var.image_tag}"

  port     = 8080
  replicas = 2

  env = concat(local.common_env, [
    { name = "PORT", value = "8080" },
    { name = "KEYCLOAK_BASE_URL", value = local.keycloak_url },
    { name = "DEMO_REALM", value = local.demo_realm },
    { name = "KAFKA_BROKERS", value = local.kafka_bootstrap },
    { name = "KEYCLOAK_CLIENT_ID", value = "svc-${each.key}" },
  ], lookup(local.service_extra_env, each.key, []))

  secret_env = [
    {
      name        = "DATABASE_URL"
      secret_name = kubernetes_secret.db_url[each.key].metadata[0].name
      secret_key  = "DATABASE_URL"
    },
    {
      name        = "KEYCLOAK_CLIENT_SECRET"
      secret_name = kubernetes_secret.keycloak_client["svc-${each.key}"].metadata[0].name
      secret_key  = "KEYCLOAK_CLIENT_SECRET"
    },
  ]

  depends_on = [kubernetes_manifest.postgres, kubernetes_manifest.kafka]
}

# ---------------------------------------------------------------------------
# Workers (Knative)
# ---------------------------------------------------------------------------
module "worker" {
  for_each = toset(["fanout", "media-process", "search-index"])
  source   = "../../modules/xitter-service"

  name        = each.key
  namespace   = local.ns
  environment = var.environment
  image       = "${var.image_registry}/xitter-${each.key}:${var.image_tag}"

  # The workers' only listener is their metrics port.
  port       = local.worker_metrics_ports[each.key]
  is_knative = true
  do_expose  = false

  env = concat(local.common_env, [
    { name = "KAFKA_BROKERS", value = local.kafka_bootstrap },
    { name = "METRICS_PORT", value = tostring(local.worker_metrics_ports[each.key]) },
    # KEYCLOAK_CLIENT_ID/SECRET both come from the client Secret (envFrom).
    { name = "FEED_INTERNAL_URL", value = "${local.svc_base.feed}/api/feed/v1" },
    { name = "MEDIA_INTERNAL_URL", value = "${local.svc_base.media}/api/media/v1" },
    { name = "SEARCH_INTERNAL_URL", value = "${local.svc_base.search}/api/search/v1" },
  ])

  secret_env = [
    {
      name        = "KEYCLOAK_CLIENT_SECRET"
      secret_name = kubernetes_secret.keycloak_client["svc-worker-${each.key}"].metadata[0].name
      secret_key  = "KEYCLOAK_CLIENT_SECRET"
    },
  ]

  depends_on = [kubernetes_manifest.kafka_topics]
}

# ---------------------------------------------------------------------------
# web (Next.js SSR)
# ---------------------------------------------------------------------------
module "web" {
  source = "../../modules/xitter-service"

  name        = "web"
  namespace   = local.ns
  environment = var.environment
  image       = "${var.image_registry}/xitter-web:${var.image_tag}"

  port     = 3000
  replicas = 2

  env = concat(local.common_env, [
    { name = "PORT", value = "3000" },
    # SSR calls sibling services directly in-cluster (never through the edge).
    { name = "XITTER_SOCIAL_URL", value = local.svc_base.social },
    { name = "XITTER_POSTS_URL", value = local.svc_base.posts },
    { name = "XITTER_MEDIA_URL", value = local.svc_base.media },
    { name = "XITTER_FEED_URL", value = local.svc_base.feed },
    { name = "XITTER_SEARCH_URL", value = local.svc_base.search },
    { name = "XITTER_KEYCLOAK_URL", value = local.keycloak_url },
  ])
}

# ---------------------------------------------------------------------------
# cms (Payload)
# ---------------------------------------------------------------------------
resource "random_password" "payload_secret" {
  length  = 48
  numeric = true
  special = false
  upper   = true
}

resource "kubernetes_secret" "cms" {
  metadata {
    name      = "cms-app"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    PAYLOAD_SECRET = random_password.payload_secret.result
  }
}

module "cms" {
  source = "../../modules/xitter-service"

  name        = "cms"
  namespace   = local.ns
  environment = var.environment
  image       = "${var.image_registry}/xitter-cms:${var.image_tag}"

  port     = 3000
  replicas = 2

  # Next.js basePath: health routes live under /cms/healthz + /cms/readyz.
  liveness_probe_path  = "/cms/healthz"
  readiness_probe_path = "/cms/readyz"

  env = concat(local.common_env, [
    { name = "PORT", value = "3000" },
    { name = "WEB_URL", value = "https://${var.domain}" },
  ])

  secret_env = [
    {
      name        = "DATABASE_URL"
      secret_name = kubernetes_secret.db_url["cms"].metadata[0].name
      secret_key  = "DATABASE_URL"
    },
    {
      name        = "PAYLOAD_SECRET"
      secret_name = kubernetes_secret.cms.metadata[0].name
      secret_key  = "PAYLOAD_SECRET"
    },
  ]

  depends_on = [kubernetes_manifest.postgres]
}

# ---------------------------------------------------------------------------
# admin (static bundle served from the image)
# ---------------------------------------------------------------------------
module "admin" {
  source = "../../modules/xitter-service"

  name        = "admin"
  namespace   = local.ns
  environment = var.environment
  image       = "${var.image_registry}/xitter-admin:${var.image_tag}"

  port     = 8080
  replicas = 2

  env = local.common_env
}
