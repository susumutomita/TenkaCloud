/**
 * Provisioning Completion Lambda
 *
 * EventBridge から TenantProvisioned イベントを受信し、
 * テナントの provisioningStatus を COMPLETED または FAILED に更新する。
 *
 * Flow:
 * 1. Application Plane の tenant-provisioner が TenantProvisioned イベント発行
 * 2. EventBridge ルールがこの Lambda をトリガー
 * 3. DynamoDB のテナントレコードを更新
 */

import type { EventBridgeEvent, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// TenantProvisioned イベントの詳細
interface TenantProvisionedDetail {
  tenantId: string;
  status: 'COMPLETED' | 'FAILED';
  resources: {
    s3Prefix?: string;
    dedicatedBucket?: string;
  };
  error?: string;
  timestamp: string;
}

// 環境変数
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE ?? 'TenkaCloud';
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

// DynamoDB クライアント初期化
const dynamoClient = new DynamoDBClient({
  ...(AWS_ENDPOINT_URL && { endpoint: AWS_ENDPOINT_URL }),
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * provisioningStatus を更新
 */
async function updateProvisioningStatus(
  tenantId: string,
  status: 'PROVISIONED' | 'FAILED',
  resources?: TenantProvisionedDetail['resources'],
  error?: string
): Promise<void> {
  const now = new Date().toISOString();

  // 更新式の構築
  const updateExpressionParts = [
    'provisioningStatus = :status',
    'updatedAt = :updatedAt',
  ];
  const expressionValues: Record<string, unknown> = {
    ':status': status,
    ':updatedAt': now,
    ':expectedStatus': 'PROVISIONING',
  };

  // リソース情報があれば追加
  if (resources && Object.keys(resources).length > 0) {
    updateExpressionParts.push('provisionedResources = :resources');
    expressionValues[':resources'] = resources;
  }

  // エラー情報があれば追加
  if (error) {
    updateExpressionParts.push('provisioningError = :error');
    expressionValues[':error'] = error;
  }

  // 完了時刻を記録
  if (status === 'PROVISIONED') {
    updateExpressionParts.push('provisionedAt = :provisionedAt');
    expressionValues[':provisionedAt'] = now;
  }

  const command = new UpdateCommand({
    TableName: DYNAMODB_TABLE,
    Key: {
      PK: `TENANT#${tenantId}`,
      SK: 'METADATA',
    },
    UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
    // PROVISIONING 状態のテナントのみ更新（べき等性確保）
    ConditionExpression:
      'attribute_exists(PK) AND provisioningStatus = :expectedStatus',
  });

  try {
    await docClient.send(command);
    console.log('Updated provisioning status', { tenantId, status });
  } catch (err) {
    // 条件が満たされない場合はスキップ（べき等性）
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      console.log('Tenant not in PROVISIONING state, skipping update', {
        tenantId,
        status,
      });
      return;
    }
    throw err;
  }
}

/**
 * Lambda ハンドラー
 */
export async function handler(
  event: EventBridgeEvent<'TenantProvisioned', TenantProvisionedDetail>,
  _context: Context
): Promise<void> {
  console.log('Received TenantProvisioned event', {
    tenantId: event.detail.tenantId,
    status: event.detail.status,
  });

  const { tenantId, status, resources, error } = event.detail;

  // ステータスを DynamoDB の provisioningStatus にマッピング
  const provisioningStatus = status === 'COMPLETED' ? 'PROVISIONED' : 'FAILED';

  await updateProvisioningStatus(
    tenantId,
    provisioningStatus,
    resources,
    error
  );

  console.log('Provisioning completion processed', {
    tenantId,
    provisioningStatus,
    hasResources: !!resources && Object.keys(resources).length > 0,
    hasError: !!error,
  });
}
