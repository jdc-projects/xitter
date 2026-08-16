terraform {
  required_version = ">= 1.9"
}

locals {
  labels = {
    "app.kubernetes.io/part-of"  = "xitter"
    "app.kubernetes.io/instance" = var.environment
    environment                  = var.environment

    # Every xitter environment is disposable (nightly reset, spec 07): the
    # nightly cluster backup must never carry their namespaces.
    "velero.io/exclude-from-backup" = "true"
  }
}

variable "environment" {
  description = "Environment name; doubles as the namespace name."
  type        = string
}

variable "namespace_name" {
  description = "Override for the namespace name (defaults to xitter-<environment>)."
  type        = string
  default     = null
}

resource "kubernetes_namespace" "this" {
  metadata {
    name   = coalesce(var.namespace_name, "xitter-${var.environment}")
    labels = local.labels
  }
}

output "name" {
  value       = kubernetes_namespace.this.metadata[0].name
  description = "The created namespace name."
}

output "labels" {
  value       = local.labels
  description = "Shared labels to apply to all resources in the namespace."
}
