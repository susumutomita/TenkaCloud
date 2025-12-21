/**
 * Tenant Provisioner Lambda
 *
 * EventBridge から TenantOnboarding イベントを受信し、
 * テナント固有のリソースをプロビジョニングする Application Plane Lambda
 */

import type { EventBridgeEvent, Context } from 'aws-lambda';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';

// イベント型定義（Control Plane からのイベント形式）
interface TenantOnboardingDetail {
  tenantId: string;
  tenantSlug: string;
  tenantTier: 'FREE' | 'PRO' | 'ENTERPRISE';
  eventType: 'TenantOnboarding' | 'TenantUpdated' | 'TenantOffboarding';
  timestamp: string;
  details: {
    id: string;
    name: string;
    slug: string;
    tier: 'FREE' | 'PRO' | 'ENTERPRISE';
    status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
    auth0OrganizationId?: string;
  };
}

interface ProvisionedResources {
  s3Prefix?: string;
  dedicatedBucket?: string;
}

// 環境変数
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? 'default';
const DATA_BUCKET_NAME = process.env.DATA_BUCKET_NAME ?? 'tenkacloud-data';
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

// クライアント初期化
const eventBridgeClient = new EventBridgeClient({
  ...(AWS_ENDPOINT_URL && { endpoint: AWS_ENDPOINT_URL }),
});

const s3Client = new S3Client({
  ...(AWS_ENDPOINT_URL && { endpoint: AWS_ENDPOINT_URL }),
  forcePathStyle: true, // LocalStack 用
});

/**
 * Pool モデルでのプロビジョニング
 * 共有バケット内にテナント専用プレフィックスを作成
 */
async function provisionPoolResources(
  tenantId: string
): Promise<ProvisionedResources> {
  const prefix = `tenants/${tenantId}/`;

  // プレフィックスの存在を示すマーカーファイルを作成
  await s3Client.send(
    new PutObjectCommand({
      Bucket: DATA_BUCKET_NAME,
      Key: `${prefix}.tenant-marker`,
      Body: JSON.stringify({
        tenantId,
        createdAt: new Date().toISOString(),
        model: 'pool',
      }),
      ContentType: 'application/json',
    })
  );

  console.log('Created pool resources', { tenantId, prefix });

  return { s3Prefix: prefix };
}

/**
 * Silo モデルでのプロビジョニング
 * テナント専用バケットを作成
 */
async function provisionSiloResources(
  tenantId: string,
  _tenantName: string
): Promise<ProvisionedResources> {
  const bucketName = `tenkacloud-${tenantId}`;

  // バケットが存在するか確認
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log('Bucket already exists', { bucketName });
  } catch (error) {
    // バケットが存在しない場合は作成
    if ((error as { name?: string }).name === 'NotFound') {
      await s3Client.send(
        new CreateBucketCommand({
          Bucket: bucketName,
        })
      );
      console.log('Created dedicated bucket', { bucketName });
    } else {
      throw error;
    }
  }

  // メタデータマーカーを作成
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: '.tenant-metadata',
      Body: JSON.stringify({
        tenantId,
        createdAt: new Date().toISOString(),
        model: 'silo',
      }),
      ContentType: 'application/json',
    })
  );

  return { dedicatedBucket: bucketName };
}

/**
 * TenantProvisioned イベントを発行
 */
async function publishProvisionedEvent(
  tenantId: string,
  status: 'COMPLETED' | 'FAILED',
  resources: ProvisionedResources,
  error?: string
): Promise<void> {
  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: 'tenkacloud.application-plane',
          DetailType: 'TenantProvisioned',
          Detail: JSON.stringify({
            tenantId,
            status,
            resources,
            error,
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    })
  );

  console.log('Published TenantProvisioned event', { tenantId, status });
}

/**
 * Lambda ハンドラー
 */
export async function handler(
  event: EventBridgeEvent<'TenantOnboarding', TenantOnboardingDetail>,
  _context: Context
): Promise<void> {
  console.log('Received TenantOnboarding event', {
    tenantId: event.detail.tenantId,
    tier: event.detail.tenantTier,
  });

  const { tenantId, tenantTier: tier, details } = event.detail;
  const tenantName = details.name;

  try {
    let resources: ProvisionedResources;

    // ティアに応じたプロビジョニング
    if (tier === 'ENTERPRISE') {
      // ENTERPRISE: Silo モデル（専用リソース）
      resources = await provisionSiloResources(tenantId, tenantName);
    } else {
      // FREE/PRO: Pool モデル（共有リソース）
      resources = await provisionPoolResources(tenantId);
    }

    // 成功イベント発行
    await publishProvisionedEvent(tenantId, 'COMPLETED', resources);

    console.log('Tenant provisioning completed', { tenantId, tier, resources });
  } catch (error) {
    console.error('Tenant provisioning failed', { tenantId, error });

    // 失敗イベント発行
    await publishProvisionedEvent(
      tenantId,
      'FAILED',
      {},
      error instanceof Error ? error.message : 'Unknown error'
    );

    throw error;
  }
}
