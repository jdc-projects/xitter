terraform {
  required_version = ">= 1.9"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

variable "name" {
  type = string
}

variable "namespace" {
  type = string
}

variable "environment" {
  type = string
}

variable "image" {
  description = "Container image for the workload."
  type        = string
}

variable "port" {
  description = "Container port; also used for probes when do_expose is true."
  type        = number
  default     = 8080
}

variable "replicas" {
  type    = number
  default = 2
}

variable "env" {
  description = "Additional env vars (name/value). Secrets are injected separately."
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "secret_env" {
  description = "Env vars sourced from Kubernetes secrets."
  type = list(object({
    name        = string
    secret_name = string
    secret_key  = string
  }))
  default = []
}

variable "is_knative" {
  description = "Deploy as a Knative Service (scale-to-zero workers) instead of a Deployment."
  type        = bool
  default     = false
}

variable "do_expose" {
  description = "Create a Service for this workload."
  type        = bool
  default     = true
}

# Feature tickets implement the Deployment / Knative Service / Service /
# HPA resources against this interface - one well-tested pattern shared by
# every xitter workload. The variables above are the frozen contract.
