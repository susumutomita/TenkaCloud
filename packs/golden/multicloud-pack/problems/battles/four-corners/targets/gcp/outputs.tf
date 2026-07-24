# The composite-probe scorer HTTPS-probes this output (metadata.json scoring.targets[gcp].outputKey).
output "GcpUrl" {
  description = "Public API URL for the provisioned bucket (composite-probe HTTPS target)."
  value       = "https://storage.googleapis.com/storage/v1/b/${google_storage_bucket.target.name}"
}
