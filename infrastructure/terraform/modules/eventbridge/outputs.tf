output "event_bus_name" {
  description = "Name of the EventBridge event bus"
  value       = aws_cloudwatch_event_bus.tenant_events.name
}

output "event_bus_arn" {
  description = "ARN of the EventBridge event bus"
  value       = aws_cloudwatch_event_bus.tenant_events.arn
}

output "onboarding_rule_arn" {
  description = "ARN of the tenant onboarding rule"
  value       = aws_cloudwatch_event_rule.tenant_onboarding.arn
}

output "onboarding_rule_name" {
  description = "Name of the tenant onboarding rule"
  value       = aws_cloudwatch_event_rule.tenant_onboarding.name
}

output "offboarding_rule_arn" {
  description = "ARN of the tenant offboarding rule"
  value       = aws_cloudwatch_event_rule.tenant_offboarding.arn
}

output "offboarding_rule_name" {
  description = "Name of the tenant offboarding rule"
  value       = aws_cloudwatch_event_rule.tenant_offboarding.name
}

output "updated_rule_arn" {
  description = "ARN of the tenant updated rule"
  value       = aws_cloudwatch_event_rule.tenant_updated.arn
}

output "updated_rule_name" {
  description = "Name of the tenant updated rule"
  value       = aws_cloudwatch_event_rule.tenant_updated.name
}
