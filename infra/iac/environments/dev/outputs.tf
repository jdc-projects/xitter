output "namespace" {
  description = "The xitter dev namespace."
  value       = local.ns
}

output "base_url" {
  description = "Public edge URL for this environment."
  value       = "https://${var.domain}"
}

output "kafka_bootstrap" {
  description = "In-cluster Kafka bootstrap address."
  value       = local.kafka_bootstrap
}

output "postgres_host" {
  description = "In-cluster Postgres read/write host."
  value       = local.postgres_rw_host
}

output "opensearch_url" {
  description = "In-cluster OpenSearch endpoint."
  value       = "http://opensearch.${local.ns}.svc:9200"
}

output "valkey_url" {
  description = "In-cluster Valkey endpoint."
  value       = "redis://valkey.${local.ns}.svc:6379"
}

output "rustfs_endpoint" {
  description = "In-cluster RustFS S3 endpoint (bucket xitter-media)."
  value       = "http://${local.rustfs_svc}.${local.ns}.svc:9000"
}
