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

# Sentry (T11): per-app projects + DSNs, self-hosted at sentry.jd-chapman.dev.
# The org-scoped token comes from the homelab's sentry remote state - the same
# source iac/grafana uses for its own project. In-cluster override: the deploy
# runs tofu on the LAN self-hosted runner; pointed at the public URL its
# requests present the home IP at Cloudflare and die whenever CrowdSec has it
# banned. TF_VAR_provider_sentry_base_url (deploy workflow) routes the
# provider at the in-cluster service instead - no edge in the path.
provider "sentry" {
  token    = data.terraform_remote_state.sentry.outputs.sentry_auth_token
  base_url = coalesce(var.provider_sentry_base_url, "https://${data.terraform_remote_state.sentry.outputs.sentry_domain}/api/")
}

variable "provider_sentry_base_url" {
  description = "Override the Sentry provider base URL (e.g. in-cluster http://sentry-web.sentry:9000/api/ when running on the LAN runner)."
  type        = string
  default     = ""
}

# The ingress module provisions Keycloak clients where auth_mode is set, so a
# real keycloak provider is required (credentials come from the homelab's
# keycloak-config remote state).
provider "keycloak" {
  client_id = "admin-cli"
  username  = data.terraform_remote_state.keycloak.outputs.keycloak_admin_username
  password  = data.terraform_remote_state.keycloak.outputs.keycloak_admin_password
  url       = coalesce(var.provider_keycloak_url, data.terraform_remote_state.keycloak.outputs.keycloak_url)
}

# In-cluster override for LAN runs (see provider_sentry_base_url note) -
# keeps the deploy's admin-cli grants off the public edge and out of
# CrowdSec's ban radius.
variable "provider_keycloak_url" {
  description = "Override the Keycloak provider URL (e.g. in-cluster http://keycloak-keycloakx-http.keycloak:80 when running on the LAN runner)."
  type        = string
  default     = ""
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
# Consumed by the jianyuan/sentry provider: dev's state owns the single
# xitter project (T11), prod reads it via data sources.
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

variable "image_registry" {
  description = "Container registry hosting the xitter images (part A publishes ghcr.io/jdc-projects/xitter-*)."
  type        = string
  default     = "ghcr.io/jdc-projects"
}

variable "image_tag" {
  description = "Image tag for all workloads. CI applies pin the immutable `sha-<short>` tag built by the same run (a mutable tag never changes the spec, so nothing rolls); the `dev` default exists only for tofu plan/validate without cluster context."
  type        = string
  default     = "dev"
}

# Cap.js bot protection (spec 02 §3.2). Keys come from repo secrets
# (docs/runbooks/04-ci-and-secrets.md); empty defaults keep tofu
# plan/validate working without the secrets - captcha is only enabled
# when both keys are provided (web fail-fasts on half-config anyway).
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
# environment is backed up, matching the nightly-reset data policy.
locals {
  ns = module.namespace.name

  # Cap.js (bot protection, spec 02 §3.2): enabled only when both keys are
  # wired (deploy passes the repo secrets as TF_VARs; empty-key runs -
  # plan/validate - stay disabled rather than half-configured).
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
# Real content: deps.tf (Postgres/Kafka/Valkey/OpenSearch/RustFS),
# databases.tf (per-service DBs + secrets), keycloak.tf (realm + clients),
# workloads.tf (11 xitter-service instances), edge.tf (ingress routing),
# netpol.tf (default-deny + allows).
# ---------------------------------------------------------------------------
