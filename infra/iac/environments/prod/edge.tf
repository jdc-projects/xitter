# Edge routing via the homelab ingress module (path-based, mirrors the local
# Traefik edge). Per spec 01: services own their full path prefix; the edge
# performs no rewriting for APIs.
#
# Auth (spec 07 ruling):
#   - `/api/{service}` routes use auth_mode=oidc-api: the edge validates the
#     Keycloak access token, checks aud contains the receiving service's
#     client id, and injects identity headers. The module provisions its own
#     `<name>-api` client per route in this environment's demo realm
#     (xitter-demo-prod, ADR 0012).
#   - `/cms` + `/admin` use auth_mode=oidc-interactive against the homelab
#     primary realm (the module provisions the clients xitter-prod-cms /
#     xitter-prod-admin); role gating (app-admin / system-admin) per spec.
#   - `/` and `/media` are unauthenticated.
#
# Geo posture (mirrors dev/T14 deliberately): the demo is globally reachable,
# so every xitter host route sets do_enable_geoblock = false (cloudflare +
# crowdsec middlewares stay on). `/cms` + `/admin` rely on their
# oidc-interactive auth, not geo. The flags are explicit rather than relying
# on module defaults we don't control. The idp host is geo-opened per-path in
# the Keycloak section below - not host-wide.

locals {
  kubeconfig = "../../../cluster.yml"

  # Keycloak's public host (idp.jd-chapman.dev) from the homelab keycloak
  # remote state - same canonical instance the keycloak provider targets.
  # Drives the demo realm's path routes below.
  idp_domain = data.terraform_remote_state.keycloak.outputs.keycloak_domain
}

# API services: one route per service, all identical except path/audience.
module "ingress_api" {
  for_each = toset(["social", "posts", "media", "feed", "search"])
  source   = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-${each.key}"
  namespace = local.ns
  domain    = var.domain
  path      = "api/${each.key}"
  priority  = 100

  target_port = 8080
  selector    = { "app.kubernetes.io/name" = each.key }

  auth_mode                       = "oidc-api"
  keycloak_auth_realm             = local.demo_realm
  auth_oidc_api_audience          = "svc-${each.key}"
  auth_oidc_api_pass_access_token = false

  do_enable_geoblock = false

  # xitter-demo-prod is a literal realm this environment creates (verified
  # above); the module's known-realms list only covers primary/master aliases.
  silenced_checks = ["keycloak_auth_realm_known"]

  kubeconfig_path = local.kubeconfig

  depends_on = [keycloak_realm.demo]
}

module "ingress_web" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-web"
  namespace = local.ns
  domain    = var.domain
  priority  = 1

  target_port = 3000
  selector    = { "app.kubernetes.io/name" = "web" }

  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}

module "ingress_cms" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-cms"
  namespace = local.ns
  domain    = var.domain
  path      = "cms"
  priority  = 100

  target_port = 3000
  selector    = { "app.kubernetes.io/name" = "cms" }

  auth_mode           = "oidc-interactive"
  keycloak_auth_realm = "primary"

  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}

module "ingress_admin" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-admin"
  namespace = local.ns
  domain    = var.domain
  path      = "admin"
  priority  = 100

  target_port = 8080
  selector    = { "app.kubernetes.io/name" = "admin" }

  auth_mode           = "oidc-interactive"
  keycloak_auth_realm = "primary"

  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}

# `/media/<key>` → RustFS bucket root: rewrite /media/<key> to
# /xitter-media/<key> (S3 path-style: bucket + key), so the public bucket URL
# is https://<domain>/media/<key> without exposing the bucket name.
# Named `media-store`, NOT `media`: the ingress module derives its resource
# names from `name`, and `xitter-dev-media-internal` is already taken by the
# /api/media route above - sharing it made the two routes overwrite each
# other on every apply.
resource "kubernetes_manifest" "media_path_rewrite" {
  manifest = {
    apiVersion = "traefik.io/v1alpha1"
    kind       = "Middleware"

    metadata = {
      name      = "xitter-media-path-rewrite"
      namespace = local.ns
    }

    spec = {
      replacePathRegex = {
        regex       = "^/media(.*)"
        replacement = "/${local.rustfs_bucket}$${1}"
      }
    }
  }
}

# Object responses are immutable (uuid uploads; the deterministic seed
# recreates byte-identical objects after each nightly wipe) - cache at the
# browser for a year so detail views stop re-downloading originals (#154).
resource "kubernetes_manifest" "media_cache_headers" {
  manifest = {
    apiVersion = "traefik.io/v1alpha1"
    kind       = "Middleware"

    metadata = {
      name      = "xitter-media-cache-headers"
      namespace = local.ns
    }

    spec = {
      headers = {
        customResponseHeaders = {
          "Cache-Control" = "public, max-age=31536000, immutable"
        }
      }
    }
  }
}

module "ingress_media" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-media-store"
  namespace = local.ns
  domain    = var.domain
  path      = "media"
  priority  = 90

  existing_service_name      = local.rustfs_svc
  existing_service_namespace = local.ns
  target_port                = 9000

  extra_middlewares = [
    {
      name      = kubernetes_manifest.media_path_rewrite.manifest.metadata.name
      namespace = local.ns
    },
    {
      name      = kubernetes_manifest.media_cache_headers.manifest.metadata.name
      namespace = local.ns
    },
  ]

  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig

  depends_on = [helm_release.rustfs]
}

# Presigned browser PUTs (T5). SigV4 signs the host AND canonical path of the
# request the CLIENT sends, so they cannot ride the rewritten `/media` route -
# the signature would cover `/media/<key>` while RustFS needs to authenticate
# `/xitter-media/<key>`. The media service therefore presigns against the edge
# host with path-style addressing, and this route forwards those
# `/xitter-media/<key>` URLs to the store unauthenticated, un-rewritten. The
# signature itself is the authorisation (15-minute expiry, exact-key scoped).
module "ingress_media_uploads" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-media-uploads"
  namespace = local.ns
  domain    = var.domain
  path      = "xitter-media"
  priority  = 100

  existing_service_name      = local.rustfs_svc
  existing_service_namespace = local.ns
  target_port                = 9000

  auth_mode          = "none"
  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig

  depends_on = [helm_release.rustfs]
}

# Keycloak demo-realm path routes on the idp host. The homelab edge
# geo-blocks non-UK traffic host-wide on *.jd-chapman.dev, but the demo is
# global, so exactly three paths are opened - realms/<demo realm> (the demo
# realm's endpoints: well-known, token, login flows) plus the `resources` and
# `js` theme-asset paths the login page loads from realm-agnostic paths
# (missing these breaks the login page for non-UK visitors). auth_mode is
# none: Keycloak serves its own flows. Everything else on the host -
# realms/primary, /admin - stays UK-only via homelab's route; do NOT widen
# these paths. Crowdsec's token-endpoint exception lives in the homelab.
#
# The realm route opens exactly THIS environment's realm
# (xitter-demo-prod, ADR 0012): dev's route geo-opens dev's xitter-demo at
# priority 200, and the anchored regexes are disjoint, so the two never
# collide - each env's demo login survives independently of the other.
# Priority stays 190 for the assets/js routes: those paths DO overlap with
# dev's 200-priority routes, and two matching routes at equal priority is
# an undefined Traefik tie - dev's win while they exist and these stay
# armed as a standby (if dev is ever destroyed, prod's routes still beat
# the homelab's geo-blocked host-level route at priority 0). Resource names
# are derived from `name` (see the /api/media collision note above), hence
# the -demo/-assets/-js suffixes.
module "ingress_keycloak_demo" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-keycloak-demo"
  namespace = local.ns
  domain    = local.idp_domain
  # PathPrefix is a raw byte prefix - it would also match sibling realm
  # names like /realms/xitter-demo-backup. PathRegexp treats `path` as the
  # verbatim Traefik regex (no automatic leading slash), keeping the
  # geo-open surface exactly this realm.
  path         = "^/realms/${local.demo_realm}(/.*)?$"
  path_matcher = "PathRegexp"
  priority     = 190

  existing_service_name      = "keycloak-keycloakx-http"
  existing_service_namespace = "keycloak"
  target_port                = 80

  auth_mode          = "none"
  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig

  depends_on = [keycloak_realm.demo]
}

module "ingress_keycloak_assets" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-keycloak-assets"
  namespace = local.ns
  domain    = local.idp_domain
  path      = "resources"
  priority  = 190

  existing_service_name      = "keycloak-keycloakx-http"
  existing_service_namespace = "keycloak"
  target_port                = 80

  auth_mode          = "none"
  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}

module "ingress_keycloak_js" {
  source = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-keycloak-js"
  namespace = local.ns
  domain    = local.idp_domain
  path      = "js"
  priority  = 190

  existing_service_name      = "keycloak-keycloakx-http"
  existing_service_namespace = "keycloak"
  target_port                = 80

  auth_mode          = "none"
  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}
