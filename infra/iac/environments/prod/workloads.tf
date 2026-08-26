# The 11 xitter workloads via the shared xitter-service module:
#   - 5 API services  (Deployment + Service + HPA)
#   - 3 workers       (Knative Services, cluster-local)
#   - web, cms        (Deployments + Service)
#   - admin           (static image + Service)
# Images come from the Release workflow's publishing contract:
#   ghcr.io/jdc-projects/xitter-{name}:${var.image_tag}
# where image_tag is the release semver (no default - see main.tf), so every
# prod pod traces back to an immutable, GitHub-released image.

locals {
  # In-cluster service addresses (namespace-internal, never through the edge).
  svc_base = { for s in ["social", "posts", "media", "feed", "search"] : s => "http://${s}.${local.ns}.svc:8080" }

  # Shared Valkey (rate limits, feed ws pub/sub) - matches outputs.tf.
  valkey_url = "redis://valkey.${local.ns}.svc:6379"

  common_env = [
    { name = "XITTER_ENV", value = var.environment },
    # Single Sentry project (spec 06): the environment tag separates dev
    # from prod within it; SENTRY_RELEASE = the deployed image tag so errors
    # line up with the rollout. The DSN itself is a shared secret
    # (observability.tf) injected via secret_env below.
    { name = "SENTRY_ENVIRONMENT", value = var.environment },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = local.otel_endpoint },
    { name = "SENTRY_RELEASE", value = var.image_tag },
  ]

  worker_metrics_ports = {
    "fanout"        = 9101
    "media-process" = 9102
    "search-index"  = 9103
  }

  # Cross-service dependencies (namespace-internal, never via the edge).
  # posts calls social's internal relationship endpoint for reply block
  # enforcement (#5); feed hydrates posts + social server-side (#7); search
  # indexes into / queries the OpenSearch cluster (#9); authn is M2M via
  # KEYCLOAK_CLIENT_ID/SECRET below.
  service_extra_env = {
    # posts→media attach validation needs the in-cluster media URL (same
    # localhost-fallback trap as dev - see dev's comment for the incident).
    posts = [
      { name = "XITTER_SOCIAL_URL", value = local.svc_base.social },
      { name = "XITTER_MEDIA_URL", value = local.svc_base.media },
    ]
    feed = [
      { name = "XITTER_POSTS_URL", value = local.svc_base.posts },
      { name = "XITTER_SOCIAL_URL", value = local.svc_base.social },
    ]
    search = [
      { name = "XITTER_POSTS_URL", value = local.svc_base.posts },
      { name = "XITTER_SOCIAL_URL", value = local.svc_base.social },
      { name = "XITTER_OPENSEARCH_URL", value = "http://opensearch.${local.ns}.svc:9200" },
    ]
    # Media storage (T5): server-side S3 calls hit RustFS in-cluster; the
    # presign endpoint is the edge host because SigV4 signs the host the
    # browser contacts (path-style /xitter-media/<key> through the
    # unauthenticated edge route of the same name).
    media = [
      { name = "XITTER_MEDIA_S3_ENDPOINT", value = "http://${local.rustfs_svc}:9000" },
      { name = "XITTER_MEDIA_S3_PUBLIC_ENDPOINT", value = "https://${var.domain}" },
      { name = "XITTER_MEDIA_S3_BUCKET", value = local.rustfs_bucket },
    ]
  }

  # Workers build /api/{service}/internal/... paths themselves from the BARE
  # service base URLs (their clients own the prefix construction).
  worker_extra_env = {
    # fanout (T6): social for follower ids + blocked filtering, posts for
    # backfill pages (FEED_INTERNAL_URL is in the shared worker env).
    fanout = [
      { name = "SOCIAL_INTERNAL_URL", value = local.svc_base.social },
      { name = "POSTS_INTERNAL_URL", value = local.svc_base.posts },
    ]
    "media-process" = [
      { name = "XITTER_MEDIA_S3_ENDPOINT", value = "http://${local.rustfs_svc}:9000" },
      { name = "XITTER_MEDIA_S3_BUCKET", value = local.rustfs_bucket },
    ]
    # search-index (#9): denormalised author names refresh through social's
    # internal profile lookup. This was MISSING in prod too - the worker
    # silently targeted localhost on every author-name refresh (same trap as
    # #112); #113 requires the var at boot, so it must be wired here.
    "search-index" = [
      { name = "SOCIAL_INTERNAL_URL", value = local.svc_base.social },
    ]
  }

  # Per-service additions to the standard secret_env (T5: media's RustFS
  # credentials, from the same random_password values the store itself uses).
  service_extra_secret_env = {
    media = [
      {
        name        = "XITTER_MEDIA_S3_ACCESS_KEY"
        secret_name = kubernetes_secret.media_s3.metadata[0].name
        secret_key  = "XITTER_MEDIA_S3_ACCESS_KEY"
      },
      {
        name        = "XITTER_MEDIA_S3_SECRET_KEY"
        secret_name = kubernetes_secret.media_s3.metadata[0].name
        secret_key  = "XITTER_MEDIA_S3_SECRET_KEY"
      },
    ]
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

  # Schema migrations run before every (re)start (same as dev).
  migrate_command = ["npx", "prisma", "migrate", "deploy"]

  env = concat(local.common_env, [
    { name = "PORT", value = "8080" },
    { name = "KEYCLOAK_BASE_URL", value = local.keycloak_url },
    { name = "DEMO_REALM", value = local.demo_realm },
    { name = "KAFKA_BROKERS", value = local.kafka_bootstrap },
    { name = "KEYCLOAK_CLIENT_ID", value = "svc-${each.key}" },
    # Rate limiting (posts/social/media) + feed's ws pub/sub fan-out (T6):
    # without it services fall back to localhost and silently degrade.
    { name = "VALKEY_URL", value = local.valkey_url },
  ], lookup(local.service_extra_env, each.key, []))

  secret_env = concat(
    [
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
    ],
    # Media S3 credentials (T5) - only the media service talks to RustFS.
    lookup(local.service_extra_secret_env, each.key, []),
    # Sentry DSN (T11) - every API service reports errors (spec 06); all
    # wired workloads share one secret (single project, `service` tag).
    contains(local.sentry_wired, each.key) ? [{
      name        = "SENTRY_DSN"
      secret_name = kubernetes_secret.sentry_dsn.metadata[0].name
      secret_key  = "SENTRY_DSN"
    }] : [],
  )

  depends_on = [kubernetes_manifest.postgres, kubernetes_manifest.kafka]
}

# RustFS credentials for the media path, keyed as the env vars the workloads
# expect (Knative workers mount secrets via envFrom: key == var name, no
# per-key mapping). Same random_password values RustFS itself was bootstrapped
# with, so service, worker and store always agree.
resource "kubernetes_secret" "media_s3" {
  metadata {
    name      = "media-s3"
    namespace = local.ns
    labels    = module.namespace.labels
  }

  data = {
    XITTER_MEDIA_S3_ACCESS_KEY = random_password.rustfs_root_username.result
    XITTER_MEDIA_S3_SECRET_KEY = random_password.rustfs_root_password.result
  }
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
    # M2M token issuer for internal API callbacks (the realm URLs the
    # services use; without it workers default to localhost).
    { name = "KEYCLOAK_BASE_URL", value = local.keycloak_url },
    { name = "DEMO_REALM", value = local.demo_realm },
    # KEYCLOAK_CLIENT_ID/SECRET both come from the client Secret (envFrom).
    # Service bases are BARE: each worker's client builds /api/{service}/...
    # paths itself.
    { name = "FEED_INTERNAL_URL", value = local.svc_base.feed },
    { name = "SEARCH_INTERNAL_URL", value = local.svc_base.search },
    { name = "MEDIA_INTERNAL_URL", value = local.svc_base.media },
  ], lookup(local.worker_extra_env, each.key, []))

  secret_env = concat(
    [
      {
        name        = "KEYCLOAK_CLIENT_SECRET"
        secret_name = kubernetes_secret.keycloak_client["svc-worker-${each.key}"].metadata[0].name
        secret_key  = "KEYCLOAK_CLIENT_SECRET"
      },
    ],
    # media-process reads RustFS with the same credentials as the service
    # (envFrom on Knative: secret keys are already named as the env vars).
    each.key == "media-process" ? [{ name = "XITTER_MEDIA_S3_ACCESS_KEY", secret_name = kubernetes_secret.media_s3.metadata[0].name, secret_key = "XITTER_MEDIA_S3_ACCESS_KEY" }] : [],
    # Sentry DSN (T11) - workers report errors like the services (spec 06).
    contains(local.sentry_wired, each.key) ? [{ name = "SENTRY_DSN", secret_name = kubernetes_secret.sentry_dsn.metadata[0].name, secret_key = "SENTRY_DSN" }] : [],
  )

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
    # Session store (and rate-limit reads) - without it web defaults to a
    # localhost Valkey and login cannot persist sessions.
    { name = "XITTER_VALKEY_URL", value = local.valkey_url },
    # Public origin for OIDC redirect_uris, captcha redirects and session
    # cookies - without it web falls back to the local-stack default and
    # login can never complete on a deployed env (see #55 for the dev hit).
    { name = "XITTER_WEB_BASE_URL", value = "https://${var.domain}" },
    # Bot protection (spec 02 §3.2): REQUIRED - web crashloops at boot
    # without keys rather than serving an unprotected login form.
    { name = "XITTER_CAP_REQUIRED", value = "true" },
    { name = "XITTER_CAP_ENABLED", value = tostring(local.cap_enabled) },
    { name = "XITTER_CAP_SITE_URL", value = local.cap_url },
    { name = "XITTER_CAP_VERIFY_URL", value = local.cap_url },
  ])

  # Sentry DSN (T11): used server-side via initSentry and relayed to the
  # browser SDK through the layout's config script tag (spec 06).
  secret_env = concat(
    [
      {
        name        = "SENTRY_DSN"
        secret_name = kubernetes_secret.sentry_dsn.metadata[0].name
        secret_key  = "SENTRY_DSN"
      },
    ],
    local.cap_enabled
    ? [
      {
        name        = "XITTER_CAP_SITE_KEY"
        secret_name = kubernetes_secret.cap.metadata[0].name
        secret_key  = "XITTER_CAP_SITE_KEY"
      },
      {
        name        = "XITTER_CAP_SECRET_KEY"
        secret_name = kubernetes_secret.cap.metadata[0].name
        secret_key  = "XITTER_CAP_SECRET_KEY"
      },
    ]
    : [],
  )
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
    # Sentry DSN (T11) - cms reports server-side errors (spec 06).
    {
      name        = "SENTRY_DSN"
      secret_name = kubernetes_secret.sentry_dsn.metadata[0].name
      secret_key  = "SENTRY_DSN"
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
