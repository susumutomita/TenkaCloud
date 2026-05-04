#!/bin/bash
set -eo pipefail

# 既存 SBT tenant DDB レコードのうち tier="premium" になっているものを
# tier="platinum" に書き換える one-shot script (#59)。
#
# PR #56 で admin-console の Tier 型から "premium" を削除し "platinum" にリネーム
# したが、それより前に作成された tenant DB レコードは tier="premium" のまま残る。
# 新 admin-console は tier="premium" を未知扱いするため、本 script で 1 度だけ
# 既存レコードを正規化する。
#
# 安全性:
#   - 冪等 (再実行しても "platinum" のままなので無害)
#   - dry-run flag で書き換え前にプレビュー可能
#   - 対象外 (tier=basic / advanced) には触らない
#
# Usage:
#   bash scripts/migrate-tier-premium-to-platinum.sh           # 実書き換え
#   bash scripts/migrate-tier-premium-to-platinum.sh --dry-run # プレビューのみ

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

# DDB tenant table 名を CloudFormation から逆引きする。SBT の ControlPlane
# construct が立てる table は名前にパターンが含まれる (Tenant / TenantTable 等)。
# 確実に取るため list-tables から候補を絞る。
echo "Looking up tenant DDB table name..."
CANDIDATES=$(aws dynamodb list-tables --query 'TableNames[]' --output text | tr '\t' '\n' | grep -i 'tenant' || true)
if [ -z "$CANDIDATES" ]; then
  echo "Error: no DynamoDB table containing 'tenant' found. SBT control-plane is deployed?" >&2
  exit 1
fi

# 候補が複数ある場合は人間に選ばせる
COUNT=$(echo "$CANDIDATES" | wc -l | tr -d ' ')
if [ "$COUNT" -gt 1 ]; then
  echo "Multiple candidate tables found:"
  echo "$CANDIDATES"
  echo ""
  echo "Set DDB_TABLE_NAME env to specify, or remove unrelated tables first." >&2
  if [ -z "${DDB_TABLE_NAME:-}" ]; then
    exit 1
  fi
  TABLE_NAME="$DDB_TABLE_NAME"
else
  TABLE_NAME="$CANDIDATES"
fi
echo "Using table: $TABLE_NAME"

# tier="premium" のレコードを scan する。
echo "Scanning items with tier='premium'..."
ITEMS=$(aws dynamodb scan \
  --table-name "$TABLE_NAME" \
  --filter-expression "#t = :v" \
  --expression-attribute-names '{"#t": "tier"}' \
  --expression-attribute-values '{":v": {"S": "premium"}}' \
  --output json)

# tenantId をキーとして抽出 (SBT は tenantId が partition key)
TENANT_IDS=$(echo "$ITEMS" | jq -r '.Items[]?.tenantId.S // empty')
if [ -z "$TENANT_IDS" ]; then
  echo "No tenants with tier='premium'. Nothing to migrate."
  exit 0
fi

COUNT=$(echo "$TENANT_IDS" | wc -l | tr -d ' ')
echo "Found $COUNT tenant(s) with tier='premium':"
echo "$TENANT_IDS" | sed 's/^/  - /'
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "(dry-run) skipping update. Re-run without --dry-run to apply."
  exit 0
fi

# 各 tenantId に対して UpdateItem で tier を "platinum" に書き換え
echo "Updating tier='premium' → tier='platinum'..."
for TENANT_ID in $TENANT_IDS; do
  aws dynamodb update-item \
    --table-name "$TABLE_NAME" \
    --key "{\"tenantId\":{\"S\":\"$TENANT_ID\"}}" \
    --update-expression "SET #t = :new" \
    --expression-attribute-names '{"#t": "tier"}' \
    --expression-attribute-values '{":new": {"S": "platinum"}}' \
    --output text > /dev/null
  echo "  Updated $TENANT_ID"
done

echo ""
echo "Migration complete. $COUNT tenant(s) updated to tier='platinum'."
