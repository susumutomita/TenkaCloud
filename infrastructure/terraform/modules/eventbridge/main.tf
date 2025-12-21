# TenkaCloud EventBridge - Tenant Lifecycle Events
#
# Event Types:
# - tenkacloud.tenant.onboarding   -> Tenant created, provision resources
# - tenkacloud.tenant.offboarding  -> Tenant deleted, deprovision resources
# - tenkacloud.tenant.updated      -> Tenant updated, update resources

resource "aws_cloudwatch_event_bus" "tenant_events" {
  name = "${var.name_prefix}-tenant-events"
  tags = var.tags
}

# Rule: Tenant Onboarding
resource "aws_cloudwatch_event_rule" "tenant_onboarding" {
  name           = "${var.name_prefix}-tenant-onboarding"
  description    = "Triggers when a new tenant is created"
  event_bus_name = aws_cloudwatch_event_bus.tenant_events.name

  event_pattern = jsonencode({
    source      = ["tenkacloud.control-plane"]
    detail-type = ["TenantOnboarding"]
  })

  tags = var.tags
}

# Rule: Tenant Offboarding
resource "aws_cloudwatch_event_rule" "tenant_offboarding" {
  name           = "${var.name_prefix}-tenant-offboarding"
  description    = "Triggers when a tenant is deleted"
  event_bus_name = aws_cloudwatch_event_bus.tenant_events.name

  event_pattern = jsonencode({
    source      = ["tenkacloud.control-plane"]
    detail-type = ["TenantOffboarding"]
  })

  tags = var.tags
}

# Rule: Tenant Updated
resource "aws_cloudwatch_event_rule" "tenant_updated" {
  name           = "${var.name_prefix}-tenant-updated"
  description    = "Triggers when a tenant is updated"
  event_bus_name = aws_cloudwatch_event_bus.tenant_events.name

  event_pattern = jsonencode({
    source      = ["tenkacloud.control-plane"]
    detail-type = ["TenantUpdated"]
  })

  tags = var.tags
}
