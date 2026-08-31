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
#     The admin SPA's public PKCE client in that realm is provisioned
#     below (#198).
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

  auth_mode = "oidc-interactive"
  # Route-local callback: the plugin default (/oidc/callback) lands on the
  # web catch-all and the handshake 404s; this path stays inside this
  # router's prefix, and the two panels never share a callback path.
  callback_path       = "/cms/oidc/callback"
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

  auth_mode = "oidc-interactive"
  # Route-local callback: the plugin default (/oidc/callback) lands on the
  # web catch-all and the handshake 404s; this path stays inside this
  # router's prefix, and the two panels never share a callback path.
  callback_path       = "/admin/oidc/callback"
  keycloak_auth_realm = "primary"

  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}

# The admin SPA's own OIDC client (#198), separate from the confidential edge
# client above: the panel is a public PKCE SPA (no server runtime to hold a
# secret), so it signs in browser-side under the client_id baked into the
# image at build time (release workflow build-args). Env-distinct id per ADR
# 0012 (shared primary realm, one state per Keycloak object); the gate roles
# it needs live in the SHARED root (infra/iac/environments/shared) - no env
# declares them.
resource "keycloak_openid_client" "admin_spa" {
  realm_id  = data.terraform_remote_state.keycloak.outputs.primary_realm_id
  client_id = "xitter-${var.environment}-admin-spa"

  name    = "xitter ${var.environment} admin SPA"
  enabled = true

  access_type = "PUBLIC"

  # Public client with no secret: enforce the code challenge server-side -
  # oidc-client-ts always sends S256 with the code flow, so nothing legit is
  # lost and plain/no-challenge exchanges are rejected.
  pkce_code_challenge_method = "S256"

  standard_flow_enabled        = true
  direct_access_grants_enabled = false

  # scope openid+profile (session.ts); full scope keeps realm roles in the
  # access token for the panel's login gate (callback.tsx + @xitter/auth).
  full_scope_allowed = true

  # `/admin` exact (no trailing slash) covers post_logout_redirect_uri;
  # `/admin/*` covers the SPA's `${origin}/admin/callback` redirect_uri.
  valid_redirect_uris = [
    "https://${var.domain}/admin",
    "https://${var.domain}/admin/*",
  ]
  web_origins = ["https://${var.domain}"]
}

# Self-audience mapper for the SPA: the internal-admin edge routes below
# check `aud` against the SPA's own client id (the audience must name a real
# client in the route's realm - svc-* only exist in the demo realm, the
# module's validation rejects them). `aud` is just a claim - no secret leaves
# the public client. Service-side, the human admin path checks azp + role,
# not aud, so one self-audience is the whole requirement (#210).
resource "keycloak_openid_audience_protocol_mapper" "admin_spa" {
  realm_id  = data.terraform_remote_state.keycloak.outputs.primary_realm_id
  client_id = keycloak_openid_client.admin_spa.id

  name = "audience-self"

  included_client_audience = "xitter-${var.environment}-admin-spa"
  add_to_access_token      = true
  add_to_id_token          = false
}

# The services' internal admin routes get their own edge routes on the
# PRIMARY realm (#210): the panel's SPA token (primary realm, self-audience,
# system-admin role) is the admin principal spec 03 defines. Higher priority
# than the demo-realm api/{service} routes (100) so these paths match first;
# pass_access_token forwards the verified token for the service-side
# verifyAdminToken re-check (issuer via ADMIN_ISSUER, azp via ADMIN_CLIENTS -
# workloads.tf). Tokens minted before the mapper applies lack the audience:
# existing sessions re-login once.
module "ingress_admin_internal" {
  for_each = toset(["social", "posts", "media", "feed", "search"])
  source   = "github.com/jdc-projects/homelab//iac/modules/ingress"

  name      = "xitter-${var.environment}-${each.key}-admin-internal"
  namespace = local.ns
  domain    = var.domain
  path      = "api/${each.key}/internal/admin"
  priority  = 200

  target_port = 8080
  selector    = { "app.kubernetes.io/name" = each.key }

  auth_mode                       = "oidc-api"
  keycloak_auth_realm             = "primary"
  auth_oidc_api_audience          = "xitter-${var.environment}-admin-spa"
  auth_oidc_api_pass_access_token = true

  do_enable_geoblock = false

  kubeconfig_path = local.kubeconfig
}

# The cms app's OWN confidential client (#208), separate from the edge
# middleware's xitter-<env>-cms (which only gates the route): the app's
# Payload-admin login does a server-side code flow against this client
# (apps/cms/src/auth/oidc.ts, callback ${origin}/cms/auth/oidc/callback).
# Full scope keeps the app-admin realm role in the token for the app's own
# gate (keycloak-strategy). The generated secret feeds the cms workload's
# CMS_CLIENT_SECRET via the cms-app kubernetes secret (workloads.tf).
resource "keycloak_openid_client" "cms_app" {
  realm_id  = data.terraform_remote_state.keycloak.outputs.primary_realm_id
  client_id = "xitter-${var.environment}-cms-app"

  name    = "xitter ${var.environment} cms app"
  enabled = true

  access_type = "CONFIDENTIAL"

  standard_flow_enabled        = true
  direct_access_grants_enabled = false

  # The reset/seed job authenticates server-to-server with this client
  # (client-credentials, #214) - that grant needs a service account enabled,
  # else the token endpoint 401s (invalid_client, observed on dev).
  service_accounts_enabled = true

  # Realm roles (app-admin) must reach the app's session token.
  full_scope_allowed = true

  valid_redirect_uris = [
    "https://${var.domain}/cms/auth/oidc/callback",
  ]
  web_origins = ["https://${var.domain}"]
}

# The cms's content access maps a token onto a CMS user only when it carries
# the app-admin realm role (keycloak-strategy); the reset/seed job's service
# account (#214) starts role-less, so its writes 403'd. Attach the gate role
# (owned by the shared root) to the client's service account - the homelab
# pattern for machine principals (iac/keycloak-config/role-mapping.tf).
data "keycloak_role" "app_admin" {
  realm_id = data.terraform_remote_state.keycloak.outputs.primary_realm_id
  name     = "app-admin"
}

resource "keycloak_openid_client_service_account_role" "cms_app" {
  realm_id                = data.terraform_remote_state.keycloak.outputs.primary_realm_id
  client_id               = keycloak_openid_client.cms_app.id
  service_account_user_id = keycloak_openid_client.cms_app.service_account_user_id
  role                    = data.keycloak_role.app_admin.name
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
