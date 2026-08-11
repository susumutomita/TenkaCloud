#!/bin/bash
# `set -e` は shebang でなく実文で set する。 CodeBuild は本 script を buildspec へ inline し、
# 1 つのコマンドブロックとして実行するので shebang は解釈されない (詳細は provision-tenant.sh
# の同じ箇所)。 deprovision で握り潰すと「消えていないのに Deleted」になる。
set -e
# pipefail: runtime bootstrap の curl 失敗を silent に続行させない。
set -o pipefail

# Install dependencies
sudo yum update -y
sudo yum install -y jq
sudo yum install -y python3-pip
# `--ignore-installed`: rpm 管理の setuptools を uninstall しようとして必ず失敗するため
# (詳細は provision-tenant.sh の同じ箇所)。 errexit 下では deprovision がここで止まる。
sudo python3 -m pip install --upgrade --ignore-installed setuptools
# `git-remote-codecommit` はここに置かない。 本 script は git remote を一切使わず (`git clone` も
# `codecommit://` remote も無い)、 source は S3 の source.zip から取る (fetch-source-bundle)。
# AWS SaaS reference architecture が tenant pipeline を CodeCommit で回していた名残で、
# TenkaCloud では最初から未使用だった。
#
# 実害 (2026-08-08 siloverify): #2935 の errexit で「未使用だが失敗する step」が fatal になり、
# さらに #2940 が setuptools を 82.0.1 へ上げたことで、 image 同梱の古い pip が legacy
# setup.py package の metadata を組めなくなった:
#
#   TypeError: canonicalize_version() got an unexpected keyword argument 'strip_trailing_zero'
#
# これで **全 tier の tenant 削除**が `cdk destroy` に到達する前に落ちるようになっていた
# (errexit が効く前は失敗が握り潰され、 後続の実削除処理はそのまま走っていたので露見しなかった)。
# 使っていない依存を入れ直すのではなく、 入れるのをやめるのが根治。

# Source-bundle fetch preamble is shared with provision-tenant.sh and inlined here
# at synth time from scripts/lib/fetch-source-bundle.sh (#2217). It resolves
# account/region, reads the injected CDK_PARAM_S3_BUCKET_NAME, and downloads + unzips
# source.zip. Runs before the bundle exists, so it cannot be `source`d at runtime.
# @@INJECT:fetch-source-bundle@@

# shellcheck source=lib/install-node.sh
source ./scripts/lib/install-node.sh
install_node_from_nvmrc

# Enable nocasematch option
shopt -s nocasematch

# Parse tenant details from the input message from step function
export CDK_PARAM_TENANT_ID=$tenantId
export TIER=$tier

# Define variables
STACK_NAME="tenkacloud-tenant-template-pooled"
USER_POOL_OUTPUT_PARAM_NAME="TenantUserpoolId"
PRODUCT_TABLE_OUTPUT_PARAM_NAME="ProductTableName"
ORDER_TABLE_OUTPUT_PARAM_NAME="OrderTableName"

# Delete tenant items
delete_items_if_exists() {
  TABLE_NAME="$1"
  TENANT_ID="$2"
  SUFFIX_START=1
  SUFFIX_END=10

  TABLE_INFO=$(aws dynamodb describe-table \
    --table-name "$TABLE_NAME")

  # Extract the partition key and sort key attribute names
  PARTITION_KEY_NAME=$(echo "$TABLE_INFO" | jq -r '.Table.KeySchema[] | select(.KeyType == "HASH") | .AttributeName')
  SORT_KEY_NAME=$(echo "$TABLE_INFO" | jq -r '.Table.KeySchema[] | select(.KeyType == "RANGE") | .AttributeName')

  for ((SUFFIX = SUFFIX_START; SUFFIX <= SUFFIX_END; SUFFIX++)); do
    PARTITION_KEY_VALUE="$TENANT_ID-$SUFFIX"

    # Query DynamoDB to get items with the specified partition key value
    QUERY_OUTPUT=$(aws dynamodb query \
      --table-name "$TABLE_NAME" \
      --key-condition-expression "$PARTITION_KEY_NAME = :pk" \
      --expression-attribute-values '{":pk":{"S":"'"$PARTITION_KEY_VALUE"'"}}')

    # Check if items were returned in the query result
    ITEM_COUNT=$(echo "$QUERY_OUTPUT" | jq '.Items | length')

    if [ "$ITEM_COUNT" -gt 0 ]; then
      echo "Items found with PartitionKey = $PARTITION_KEY_VALUE"

      # Loop through the items and extract the PartitionKey and SortKey
      for ITEM in $(echo "$QUERY_OUTPUT" | jq -c '.Items[]'); do
        ITEM_KEY=$(echo "$ITEM" | jq -r '.'$PARTITION_KEY_NAME'.S')
        ITEM_SORT_KEY=$(echo "$ITEM" | jq -r '.'$SORT_KEY_NAME'.S')

        # Delete each item using the PartitionKey and SortKey
        aws dynamodb delete-item \
          --table-name "$TABLE_NAME" \
          --key "{\"$PARTITION_KEY_NAME\":{\"S\":\"$ITEM_KEY\"},\"$SORT_KEY_NAME\":{\"S\":\"$ITEM_SORT_KEY\"}}"

        echo "Deleted item with $PARTITION_KEY_NAME = $ITEM_KEY and $SORT_KEY_NAME = $ITEM_SORT_KEY"
      done
    else
      echo "No items found with PartitionKey = $PARTITION_KEY_VALUE"
    fi
  done
}

# Issue #2952: machine (M2M) credential の回収。
#
# `tc-tenant-<tenantId>` bind resource server と `tc-m2m-<tenantId>*` app client は **CFn 管理外**
# である。CFn 管理にすると次の `cdk deploy` が scope list を空へ reconcile して
# 発行済み token を全滅させるため)。したがって `cdk destroy` でも回収されない。pooled tier では
# UserPool が他 tenant と共有で残り続けるので、ここで消さないと **削除済み tenant の
# credential が有効なまま残る**。silo でも UserPool が retain された場合に同じことが起きる。
#
# 冪等: 対象が無ければ何もしない。回収そのものは tenant 削除の成否を左右しないほど軽い操作
# だが、失敗を握り潰すと「消えていないのに Deleted」になるので errexit のまま通す。
BIND_RESOURCE_SERVER_PREFIX="tc-tenant-"
MACHINE_CLIENT_NAME_PREFIX="tc-m2m-"

reap_machine_credentials() {
  USER_POOL_ID="$1"
  TENANT="$2"
  if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
    echo "machine credential reaping skipped: user pool id not resolved"
    return 0
  fi

  MACHINE_CLIENT_IDS=$(aws cognito-idp list-user-pool-clients \
    --user-pool-id "$USER_POOL_ID" --max-results 60 \
    --query "UserPoolClients[?starts_with(ClientName, '${MACHINE_CLIENT_NAME_PREFIX}${TENANT}')].ClientId" \
    --output text)
  for MACHINE_CLIENT_ID in $MACHINE_CLIENT_IDS; do
    aws cognito-idp delete-user-pool-client --user-pool-id "$USER_POOL_ID" --client-id "$MACHINE_CLIENT_ID"
    echo "Deleted machine app client: $MACHINE_CLIENT_ID"
  done

  BIND_RESOURCE_SERVER_ID="${BIND_RESOURCE_SERVER_PREFIX}${TENANT}"
  if aws cognito-idp describe-resource-server --user-pool-id "$USER_POOL_ID" \
    --identifier "$BIND_RESOURCE_SERVER_ID" >/dev/null 2>&1; then
    aws cognito-idp delete-resource-server --user-pool-id "$USER_POOL_ID" \
      --identifier "$BIND_RESOURCE_SERVER_ID"
    echo "Deleted bind resource server: $BIND_RESOURCE_SERVER_ID"
  fi
  # 発行済み access token は TTL (15 分) の残り時間だけまだ有効。
  echo "machine credentials for $TENANT are revoked; already-issued tokens expire within 15 minutes"
}

# Un deploy the tenant template for platinum tier(silo)
if [[ $TIER == "PLATINUM" ]]; then

  STACK_NAME=$(aws dynamodb get-item \
    --table-name $TENANT_STACK_MAPPING_TABLE \
    --key "{\"tenantId\": {\"S\": \"$CDK_PARAM_TENANT_ID\"}}" \
    --query 'Item.stackName.S')

  echo "Stack name from $TENANT_STACK_MAPPING_TABLE is  $STACK_NAME"

  # Issue #2952: destroy の前に回収する。stack を消したあとでは UserPool id を引けない。
  SILO_USERPOOL_ID=$(aws cloudformation describe-stacks --stack-name "$(echo "$STACK_NAME" | tr -d '"')" \
    --query "Stacks[0].Outputs[?OutputKey=='$USER_POOL_OUTPUT_PARAM_NAME'].OutputValue" \
    --output text 2>/dev/null || echo "")
  reap_machine_credentials "$SILO_USERPOOL_ID" "$CDK_PARAM_TENANT_ID"

  # provision/update と同じ source bundle の CDK workspace を使う。外部の旧SaaS reference
  # repositoryにはTenkaCloudのstack定義もpinned CLIもないため、destroy経路に使わない。
  cd cdk
  bun install

  export CDK_PARAM_SYSTEM_ADMIN_EMAIL="NA"
  export CDK_PARAM_COMMIT_ID="NA"
  export CDK_PARAM_REG_API_GATEWAY_URL="NA"
  export CDK_PARAM_EVENT_BUS_ARN=arn:aws:service:::resource
  export CDK_PARAM_CONTROL_PLANE_SOURCE="NA"
  export CDK_PARAM_ONBOARDING_DETAIL_TYPE="NA"
  export CDK_PARAM_PROVISIONING_DETAIL_TYPE="NA"
  export CDK_PARAM_PROVISIONING_EVENT_SOURCE="NA"
  export CDK_PARAM_APPLICATION_NAME_PLANE_SOURCE="NA"
  export CDK_PARAM_OFFBOARDING_DETAIL_TYPE="NA"
  export CDK_PARAM_DEPROVISIONING_DETAIL_TYPE="NA"

  echo "undeploying tenant template $STACK_NAME"
  bun run cdk -- destroy "$STACK_NAME" --force

else
  # Read tenant details from the cloudformation stack output parameters
  SAAS_APP_USERPOOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$USER_POOL_OUTPUT_PARAM_NAME'].OutputValue" --output text)
  PRODUCT_TABLE_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$PRODUCT_TABLE_OUTPUT_PARAM_NAME'].OutputValue" --output text)
  ORDER_TABLE_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$ORDER_TABLE_OUTPUT_PARAM_NAME'].OutputValue" --output text)

  # Issue #2952: pooled tier は UserPool を全 non-PLATINUM tenant で共有するため、ここで回収
  # しないと削除済み tenant の machine credential が共有 pool 上に残り続ける。
  reap_machine_credentials "$SAAS_APP_USERPOOL_ID" "$CDK_PARAM_TENANT_ID"

  ## Delete tenant users and tenant user groups
  # Get a list of all users in the user group
  USERS=$(aws cognito-idp list-users-in-group --user-pool-id "$SAAS_APP_USERPOOL_ID" --group-name "$CDK_PARAM_TENANT_ID" --query "Users[].Username" --output text)
  # Loop through the list of users and delete each one from the group
  for USERNAME in $USERS; do
    aws cognito-idp admin-delete-user --user-pool-id "$SAAS_APP_USERPOOL_ID" --username "$USERNAME"
    echo "Removed user $USERNAME from group $CDK_PARAM_TENANT_ID"
  done

  # Delete the user group
  aws cognito-idp delete-group --user-pool-id "$SAAS_APP_USERPOOL_ID" --group-name "$CDK_PARAM_TENANT_ID"
  echo "Deleted user group: $CDK_PARAM_TENANT_ID"
  echo "All users have been removed from the group and the group has been deleted."

  # Delete tenant items from the product and order tables
  delete_items_if_exists $PRODUCT_TABLE_NAME $CDK_PARAM_TENANT_ID
  delete_items_if_exists $ORDER_TABLE_NAME $CDK_PARAM_TENANT_ID

fi

# Create JSON response of output parameters
export tenantStatus="Deleted"
export registrationStatus="Deleted"
