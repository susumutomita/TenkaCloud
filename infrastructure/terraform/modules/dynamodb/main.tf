# TenkaCloud DynamoDB Single Table Design
#
# PK/SK Pattern:
# - TENANT#<id> | METADATA           -> Tenant info
# - TENANT#<id> | USER#<id>          -> Tenant-User membership
# - USER#<id>   | METADATA           -> User info
# - EVENT#<id>  | METADATA           -> Event info
# - EVENT#<id>  | PROBLEM#<id>       -> Event-Problem mapping
# - EVENT#<id>  | TEAM#<id>          -> Team info
# - EVENT#<id>  | SCORE#<team>#<prob>-> Score record

resource "aws_dynamodb_table" "main" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  attribute {
    name = "EntityType"
    type = "S"
  }

  attribute {
    name = "CreatedAt"
    type = "S"
  }

  # GSI1: Inverted index for reverse lookups
  # e.g., Find all tenants a user belongs to
  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # GSI2: Entity type index for listing
  # e.g., List all events, list all tenants
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "EntityType"
    range_key       = "CreatedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "TTL"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  tags = var.tags
}
