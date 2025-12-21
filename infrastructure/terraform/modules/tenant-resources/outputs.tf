output "tenant_role_arn" {
  description = "ARN of the tenant IAM role"
  value       = aws_iam_role.tenant_role.arn
}

output "tenant_role_name" {
  description = "Name of the tenant IAM role"
  value       = aws_iam_role.tenant_role.name
}

output "tenant_bucket_name" {
  description = "Name of the tenant S3 bucket (if created)"
  value       = var.create_s3_bucket ? aws_s3_bucket.tenant_bucket[0].id : null
}

output "tenant_bucket_arn" {
  description = "ARN of the tenant S3 bucket (if created)"
  value       = var.create_s3_bucket ? aws_s3_bucket.tenant_bucket[0].arn : null
}

output "tenant_log_group_name" {
  description = "Name of the tenant CloudWatch log group"
  value       = aws_cloudwatch_log_group.tenant_logs.name
}

output "tenant_log_group_arn" {
  description = "ARN of the tenant CloudWatch log group"
  value       = aws_cloudwatch_log_group.tenant_logs.arn
}
