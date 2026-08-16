terraform {
  backend "kubernetes" {
    # Initialised per-environment with:
    #   tofu init -backend-config=secret_suffix=xitter-<env>
    #             -backend-config=namespace=tf-state
    #             -backend-config=config_path=../../../cluster.yml
    secret_suffix = "xitter-dev"
    config_path   = "../../../cluster.yml"
    namespace     = "tf-state"
  }

  required_version = ">= 1.9"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    keycloak = {
      source  = "keycloak/keycloak"
      version = "~> 5.8"
    }
  }
}

provider "kubernetes" {
  config_path = "../../../cluster.yml"
}

# The ingress module provisions Keycloak clients where auth_mode is set, so a
# real keycloak provider is required (credentials come from the homelab's
# keycloak-config remote state).
provider "keycloak" {
  client_id = "admin-cli"
  username  = data.terraform_remote_state.keycloak.outputs.keycloak_admin_username
  password  = data.terraform_remote_state.keycloak.outputs.keycloak_admin_password
  url       = data.terraform_remote_state.keycloak.outputs.keycloak_url
}

data "terraform_remote_state" "keycloak" {
  backend = "kubernetes"

  config = {
    secret_suffix = "keycloak-config"
    config_path   = "../../../cluster.yml"
    namespace     = "tf-state"
  }
}

# Sentry org-scoped auth token + web domain (homelab iac/sentry outputs).
# Consumed by the jianyuan/sentry provider when T11 creates per-app projects.
data "terraform_remote_state" "sentry" {
  backend = "kubernetes"

  config = {
    secret_suffix = "sentry"
    config_path   = "../../../cluster.yml"
    namespace     = "tf-state"
  }
}

variable "domain" {
  description = "Base domain for this environment's URLs."
  type        = string
  default     = "xitter-dev.jd-chapman.dev"
}

variable "environment" {
  type    = string
  default = "dev"
}

module "namespace" {
  source      = "../../modules/namespace"
  environment = var.environment
}

# ---------------------------------------------------------------------------
# Demo realm (Keycloak)
# The xitter-demo realm is created and seeded here; the nightly reset job
# deletes and recreates it via the shared keycloak script.
# Landed with the auth feature ticket - see docs/specs/architecture/07-security.md.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Edge routing (homelab ingress module - path-based, mirrors local Traefik)
# Example wiring (one per public workload):
#
#   module "ingress_web" {
#     source     = "github.com/jdc-projects/homelab//iac/modules/ingress"
#     name       = "xitter-${var.environment}-web"
#     namespace  = module.namespace.name
#     domain     = var.domain
#     target_port = 3000
#     selector   = { "app.kubernetes.io/name" = "web" }
#     kubeconfig_path = "../../../cluster.yml"
#   }
#
# API services set auth_mode = "oidc-api" (Keycloak offload at the edge);
# the demo realm name is passed via keycloak_auth_realm.
# Implemented per-workload in feature tickets.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Workloads (services, workers, web, cms, admin) - module "xitter-service"
# instances land with each vertical-slice feature ticket.
# ---------------------------------------------------------------------------
