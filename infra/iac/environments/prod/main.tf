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
  }
}

provider "kubernetes" {
  config_path = "../../../cluster.yml"
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

module "namespace" {
  source      = "../../modules/namespace"
  environment = var.environment
}

# Same layout as dev: demo realm, edge routing via the homelab ingress module
# (auth_mode = "oidc-api" for APIs), and xitter-service workload instances -
# each landing with its vertical-slice feature ticket.
