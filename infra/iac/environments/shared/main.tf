# Shared xitter root (#197): owns the objects every environment depends on -
# the Sentry team + project and the primary-realm admin gate roles (#198).
# Previously dev's state owned them, which coupled prod's release to dev's
# apply timing and let a dev destroy orphan prod's DSN (ADR 0013; the roles
# had the same shape). Environment roots read the DSN via this state's
# outputs and own only their own `xitter-sentry` secret - kept to exactly
# these objects, nothing environment-shaped lives here.
terraform {
  backend "kubernetes" {
    secret_suffix = "xitter-shared"
    config_path   = "../../../cluster.yml"
    namespace     = "tf-state"
  }

  required_version = ">= 1.9"

  required_providers {
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.15"
    }
    keycloak = {
      source  = "keycloak/keycloak"
      version = "~> 5.8"
    }
  }
}

# Sentry, self-hosted at sentry.jd-chapman.dev. The org-scoped token comes
# from the homelab's sentry remote state - the same source the env roots and
# iac/grafana use. In-cluster override: CI runs tofu on the LAN self-hosted
# runner; pointed at the public URL its requests present the home IP at
# Cloudflare and die whenever CrowdSec has it banned.
# TF_VAR_provider_sentry_base_url (deploy/release workflows) routes the
# provider at the in-cluster service instead - no edge in the path (ADR 0011).
provider "sentry" {
  token    = data.terraform_remote_state.sentry.outputs.sentry_auth_token
  base_url = coalesce(var.provider_sentry_base_url, "https://${data.terraform_remote_state.sentry.outputs.sentry_domain}/api/")
}

variable "provider_sentry_base_url" {
  description = "Override the Sentry provider base URL (e.g. in-cluster http://sentry-web.sentry:9000/api/ when running on the LAN runner)."
  type        = string
  default     = ""
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

# Keycloak admin credentials (homelab iac/keycloak-config outputs) - same
# wiring as the env roots. The admin gate roles live in the shared "primary"
# realm (jd-chapman.dev), so this root needs the provider to own them; the
# in-cluster override var exists for the same CrowdSec reason as the sentry
# one (ADR 0011).
data "terraform_remote_state" "keycloak" {
  backend = "kubernetes"

  config = {
    secret_suffix = "keycloak-config"
    config_path   = "../../../cluster.yml"
    namespace     = "tf-state"
  }
}

provider "keycloak" {
  client_id = "admin-cli"
  username  = data.terraform_remote_state.keycloak.outputs.keycloak_admin_username
  password  = data.terraform_remote_state.keycloak.outputs.keycloak_admin_password
  url       = coalesce(var.provider_keycloak_url, data.terraform_remote_state.keycloak.outputs.keycloak_url)
}

variable "provider_keycloak_url" {
  description = "Override the Keycloak provider URL (e.g. in-cluster http://keycloak-keycloakx-http.keycloak:80 when running on the LAN runner)."
  type        = string
  default     = ""
}

# Admin gate roles in the shared primary realm (#198): the SPA's role gate
# matches these names literally, and BOTH envs' admin surfaces depend on
# them - the same shared-object shape as the Sentry project, so they live
# here, not in dev's state (which #198 initially used; a dev destroy would
# have broken prod's role gate until dev re-applied). Adopted from dev via
# `tofu import` (2026-08-31); dev forgets them through `removed` blocks.
# Assigning them to operator accounts is a Keycloak-console action (see
# #198 PR notes) - membership is identity management, not tofu.
resource "keycloak_role" "admin_gate" {
  for_each = toset(["system-admin", "app-admin"])

  realm_id = data.terraform_remote_state.keycloak.outputs.primary_realm_id
  name     = each.value

  description = "xitter admin surface gate (${each.value}) - admin panel (system-admin) / CMS (app-admin). Owned by the shared root; see shared/main.tf."

  lifecycle {
    prevent_destroy = true
  }
}

# Moved verbatim from dev's observability.tf; the live objects were adopted
# via `tofu import` (2026-08-31) and dev's state forgets them through
# `removed` blocks on its next apply.
resource "sentry_team" "xitter" {
  organization = "sentry"
  name         = "xitter"
  slug         = "xitter"
}

# The single project all xitter workloads (dev AND prod) report into.
# Platform only picks Sentry's UI defaults (stack rendering, release health),
# not where events go, so "node" is fine for a mixed
# Next.js/browser/NestJS/Node population - per-runtime fidelity comes from
# each SDK, not this field. prevent_destroy: every environment's DSN secret
# points at this project's key; recreating the project would silently re-key
# all events (the DSN-churn hazard #197 closes, inverted - keep it closed).
resource "sentry_project" "xitter" {
  organization = sentry_team.xitter.organization
  teams        = [sentry_team.xitter.slug]
  name         = "xitter"
  slug         = "xitter"
  platform     = "node"

  lifecycle {
    prevent_destroy = true
  }
}

# first = the project's Default key - the same key dev's state read before
# the move, so the exported DSN is byte-identical (no workload re-keys).
data "sentry_key" "xitter" {
  organization = sentry_project.xitter.organization
  project      = sentry_project.xitter.slug
  first        = true
}

output "sentry_project_slug" {
  description = "Slug of the single xitter Sentry project (owned by this root, #197)."
  value       = sentry_project.xitter.slug
}

output "sentry_dsn_public" {
  description = "Public DSN of the project's Default key; each environment root materialises it into its own xitter-sentry secret."
  value       = data.sentry_key.xitter.dsn["public"]
  sensitive   = true
}
