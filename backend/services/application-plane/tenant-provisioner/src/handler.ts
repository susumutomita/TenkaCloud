/**
 * Tenant Provisioner Lambda
 *
 * EventBridge から TenantOnboarding イベントを受信し、
 * テナント固有のリソースをプロビジョニングする Application Plane Lambda
 *
 * プロビジョニング対象:
 * - Auth0 Organization（LocalStack 環境ではスキップ）
 * - S3 ストレージ（Pool: 共有バケット + プレフィックス、Silo: 専用バケット）
 * - IAM Role（TODO: Phase 3 で実装）
 * - CloudWatch Logs（TODO: Phase 3 で実装）
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
import { Auth0Provisioner } from '@tenkacloud/auth0';
import type { ProvisionedResources } from '@tenkacloud/events';
import { EventSource, EventDetailType } from '@tenkacloud/events';
import { createTenantRole } from './iam-provisioner';
import { createTenantLogGroup } from './cloudwatch-provisioner';

// イベント型定義（Control Plane からのイベント形式）
// NOTE: provisioning Lambda が発行する形式に合わせる
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

// Auth0 Provisioner（LocalStack 環境では自動的にスキップモードになる）
const auth0Provisioner = new Auth0Provisioner();

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

  return { s3Bucket: bucketName };
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
          Source: EventSource.APPLICATION_PLANE,
          DetailType: EventDetailType.TENANT_PROVISIONED,
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

  const { tenantId, tenantSlug, tenantTier: tier, details } = event.detail;
  const tenantName = details.name;

  try {
    const resources: ProvisionedResources = {};

    // 1. Auth0 Organization をプロビジョニング
    // LocalStack 環境では自動的にスキップされる
    const auth0Result = await auth0Provisioner.createTenantOrganization(
      tenantSlug,
      tenantName,
      tier
    );
    resources.auth0OrganizationId = auth0Result.organizationId;
    console.log('Auth0 Organization created', {
      tenantId,
      organizationId: auth0Result.organizationId,
    });

    // 2. S3 ストレージをプロビジョニング
    // ティアに応じたモデルを選択
    if (tier === 'ENTERPRISE') {
      // ENTERPRISE: Silo モデル（専用リソース）
      const siloResources = await provisionSiloResources(tenantId, tenantName);
      resources.s3Bucket = siloResources.s3Bucket;
    } else {
      // FREE/PRO: Pool モデル（共有リソース）
      const poolResources = await provisionPoolResources(tenantId);
      resources.s3Prefix = poolResources.s3Prefix;
    }

    // 3. IAM Role をプロビジョニング
    // LocalStack 環境では自動的にダミー ARN を返す
    const iamResult = await createTenantRole(
      tenantId,
      tenantSlug,
      tier,
      DATA_BUCKET_NAME
    );
    resources.iamRoleArn = iamResult.roleArn;
    console.log('IAM Role created', {
      tenantId,
      roleName: iamResult.roleName,
    });

    // 4. CloudWatch Logs をプロビジョニング
    const logsResult = await createTenantLogGroup(tenantId, tenantSlug, tier);
    resources.cloudwatchLogGroup = logsResult.logGroupName;
    console.log('CloudWatch Log Group created', {
      tenantId,
      logGroupName: logsResult.logGroupName,
      retentionDays: logsResult.retentionDays,
    });

    // 成功イベント発行
    await publishProvisionedEvent(tenantId, 'COMPLETED', resources);

    console.log('Tenant provisioning completed', {
      tenantId,
      tier,
      provisionedResources: Object.keys(resources),
    });
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
