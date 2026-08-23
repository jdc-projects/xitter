terraform {
  backend "kubernetes" {
    secret_suffix = "xitter-prod"
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
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.15"
    }
  }
}

provider "kubernetes" {
  config_path = "../../../cluster.yml"
}

provider "helm" {
  kubernetes = {
    config_path = "../../../cluster.yml"
  }
}

provider "random" {}

# Sentry (T11 pattern, prod projects): per-app projects + DSNs, self-hosted at
# sentry.jd-chapman.dev. Prod keeps its own team + projects (xitter-prod-*)
# so dev and prod error streams stay isolated.
provider "sentry" {
  token    = data.terraform_remote_state.sentry.outputs.sentry_auth_token
  base_url = "https://${data.terraform_remote_state.sentry.outputs.sentry_domain}/api/"
}

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
  default     = "xitter.jd-chapman.dev"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "image_registry" {
  description = "Container registry hosting the xitter images (CI publishes ghcr.io/jdc-projects/xitter-*)."
  type        = string
  default     = "ghcr.io/jdc-projects"
}

# Deliberately no default: prod always deploys an explicit, immutable release
# tag (the Release workflow passes -var image_tag=vX.Y.Z). A default here is
# exactly how a dev value would leak into prod - validate needs no value, and
# plan/apply fail loudly instead of silently rolling the mutable dev tag.
variable "image_tag" {
  description = "Immutable semver release tag for all workloads (e.g. v1.2.3)."
  type        = string
}

# Cap.js bot protection (spec 02 §3.2) - same contract as dev: keys from
# repo secrets via TF_VAR_cap_*, empty defaults keep plan working.
variable "cap_site_key" {
  description = "Cap.js site key (gh secret XITTER_CAP_SITE_KEY)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cap_secret_key" {
  description = "Cap.js secret key (gh secret XITTER_CAP_SECRET_KEY)."
  type        = string
  default     = ""
  sensitive   = true
}

module "namespace" {
  source      = "../../modules/namespace"
  environment = var.environment
}

# The namespace module labels the namespace `velero.io/exclude-from-backup`
# (spec 07 - no user-generated data leaves the cluster), so nothing from this
# environment is backed up, matching the disposable-data policy.
locals {
  ns = module.namespace.name

  # Cap.js: enabled only when both keys are wired (see dev's main.tf).
  cap_enabled = var.cap_site_key != "" && var.cap_secret_key != ""
  cap_url     = "https://cap.jd-chapman.dev"

  # Canonical Keycloak: the token issuer for every realm (browser PKCE login,
  # edge middleware discovery, service JWKS validation). From the homelab's
  # keycloak-config remote state, same source the ingress module uses.
  keycloak_url = data.terraform_remote_state.keycloak.outputs.keycloak_url

  otel_endpoint = "http://otel-collector.otel.svc:4318"

  kafka_bootstrap = "kafka.${local.ns}.svc:9092"
}

# ---------------------------------------------------------------------------
# Same layout as dev (see docs/specs/operations/01-environments.md):
# deps.tf (Postgres/Kafka/Valkey/OpenSearch/RustFS), databases.tf (per-service
# DBs + secrets), keycloak.tf (realm + clients), workloads.tf (11
# xitter-service instances), edge.tf (ingress routing), netpol.tf (default-deny
# + allows), observability.tf (Sentry + monitors + alerts + dashboards).
# Deltas from dev are commented in place (Postgres/OpenSearch sizing, pinned
# image tags, reset wiring pending #13).
# ---------------------------------------------------------------------------
