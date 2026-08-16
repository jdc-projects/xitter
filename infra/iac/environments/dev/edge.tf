# Edge routing via the homelab ingress module (path-based, mirrors the local
# Traefik edge). Per spec 01: services own their full path prefix; the edge
# performs no rewriting for APIs.
#
# Auth (spec 07 ruling):
#   - `/api/{service}` routes use auth_mode=oidc-api: the edge validates the
#     Keycloak access token, checks aud contains the receiving service's
#     client id, and injects identity headers. The module provisions its own
#     `<name>-api` client per route in the xitter-demo realm.
#   - `/cms` + `/admin` use auth_mode=oidc-interactive against the homelab
#     primary realm (the module provisions the clients xitter-dev-cms /
#     xitter-dev-admin); role gating (app-admin / system-admin) lands with
#     #10/#11.
#   - `/` and `/media` are unauthenticated.

locals {
  kubeconfig = "../../../cluster.yml"
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

  # xitter-demo is a literal realm this environment creates (verified above);
  # the module's known-realms list only covers primary/master aliases.
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

  extra_middlewares = [{
    name      = kubernetes_manifest.media_path_rewrite.manifest.metadata.name
    namespace = local.ns
  }]

  kubeconfig_path = local.kubeconfig

  depends_on = [helm_release.rustfs]
}
