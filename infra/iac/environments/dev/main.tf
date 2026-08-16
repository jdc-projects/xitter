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

variable "image_registry" {
  description = "Container registry hosting the xitter images (part A publishes ghcr.io/jdc-projects/xitter-*)."
  type        = string
  default     = "ghcr.io/jdc-projects"
}

variable "image_tag" {
  description = "Image tag for all workloads. dev tracks the mutable `dev` tag pushed on merge; prod will pin SHAs/semver."
  type        = string
  default     = "dev"
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
