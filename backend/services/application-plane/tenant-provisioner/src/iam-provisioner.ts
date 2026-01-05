/**
 * IAM Role Provisioner
 *
 * テナント用 IAM Role を作成する。
 * Auth0 OIDC Federation を使用し、テナントごとにスコープされた権限を付与。
 *
 * LocalStack 環境ではダミー ARN を返す。
 */

import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
} from '@aws-sdk/client-iam';

// 環境変数
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN ?? 'dev-tenkacloud.auth0.com';
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? '000000000000';

// LocalStack 判定
const isLocalStack =
  AWS_ENDPOINT_URL?.includes('localhost') ||
  AWS_ENDPOINT_URL?.includes('localstack');

// IAM クライアント
const iamClient = new IAMClient({
  ...(AWS_ENDPOINT_URL && { endpoint: AWS_ENDPOINT_URL }),
});

/**
 * IAM Role プロビジョニング結果
 */
export interface IamProvisionerResult {
  roleArn: string;
  roleName: string;
}

/**
 * Trust Policy: Auth0 OIDC Federation
 */
function createTrustPolicy(tenantSlug: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Federated: `arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${AUTH0_DOMAIN}`,
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${AUTH0_DOMAIN}:aud`]: 'https://api.tenkacloud.com',
          },
          StringLike: {
            [`${AUTH0_DOMAIN}:sub`]: `org_*|tenant-${tenantSlug}|*`,
          },
        },
      },
    ],
  });
}

/**
 * Permission Policy: テナントスコープの権限
 */
function createPermissionPolicy(
  tenantId: string,
  tier: string,
  dataBucketName: string
): string {
  const baseStatements = [
    // DynamoDB: LeadingKey 条件でテナント分離
    {
      Sid: 'DynamoDBTenantAccess',
      Effect: 'Allow',
      Action: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
      ],
      Resource: `arn:aws:dynamodb:*:${AWS_ACCOUNT_ID}:table/*`,
      Condition: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': [`TENANT#${tenantId}`],
        },
      },
    },
    // S3: テナントプレフィックスへのアクセス
    {
      Sid: 'S3TenantAccess',
      Effect: 'Allow',
      Action: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
      ],
      Resource: [
        `arn:aws:s3:::${dataBucketName}/tenants/${tenantId}/*`,
        `arn:aws:s3:::${dataBucketName}`,
      ],
      Condition: {
        StringLike: {
          's3:prefix': [`tenants/${tenantId}/*`],
        },
      },
    },
    // CloudWatch Logs: テナントログへの書き込み
    {
      Sid: 'CloudWatchLogsAccess',
      Effect: 'Allow',
      Action: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      Resource: `arn:aws:logs:*:${AWS_ACCOUNT_ID}:log-group:/tenkacloud/tenants/${tenantId}:*`,
    },
  ];

  // ENTERPRISE tier には追加の権限を付与
  if (tier === 'ENTERPRISE') {
    baseStatements.push({
      Sid: 'S3DedicatedBucketAccess',
      Effect: 'Allow',
      Action: ['s3:*'],
      Resource: [
        `arn:aws:s3:::tenkacloud-${tenantId}`,
        `arn:aws:s3:::tenkacloud-${tenantId}/*`,
      ],
      Condition: {
        StringLike: {
          's3:prefix': ['*'],
        },
      },
    });
  }

  return JSON.stringify({
    Version: '2012-10-17',
    Statement: baseStatements,
  });
}

/**
 * テナント用 IAM Role を作成
 */
export async function createTenantRole(
  tenantId: string,
  tenantSlug: string,
  tier: string,
  dataBucketName: string
): Promise<IamProvisionerResult> {
  const roleName = `tenkacloud-tenant-${tenantSlug}`;

  // LocalStack モードではダミー ARN を返す
  if (isLocalStack) {
    console.log('LocalStack モード: IAM Role 作成をスキップします', {
      roleName,
      tenantId,
    });
    return {
      roleArn: `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${roleName}`,
      roleName,
    };
  }

  try {
    // 既存の Role を確認
    try {
      const existingRole = await iamClient.send(
        new GetRoleCommand({ RoleName: roleName })
      );
      if (existingRole.Role) {
        console.log('IAM Role は既に存在します', { roleName });
        return {
          roleArn: existingRole.Role.Arn!,
          roleName,
        };
      }
    } catch (error) {
      // NoSuchEntity は新規作成を意味する
      if ((error as { name?: string }).name !== 'NoSuchEntityException') {
        throw error;
      }
    }

    // Role を作成
    const createRoleResult = await iamClient.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: createTrustPolicy(tenantSlug),
        Description: `TenkaCloud tenant role for ${tenantSlug}`,
        Tags: [
          { Key: 'TenantId', Value: tenantId },
          { Key: 'TenantSlug', Value: tenantSlug },
          { Key: 'Tier', Value: tier },
          { Key: 'ManagedBy', Value: 'tenkacloud' },
        ],
      })
    );

    // Inline Policy を追加
    await iamClient.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: 'TenantAccessPolicy',
        PolicyDocument: createPermissionPolicy(tenantId, tier, dataBucketName),
      })
    );

    console.log('IAM Role を作成しました', {
      roleName,
      roleArn: createRoleResult.Role?.Arn,
    });

    return {
      roleArn: createRoleResult.Role!.Arn!,
      roleName,
    };
  } catch (error) {
    console.error('IAM Role 作成に失敗しました', { roleName, error });
    throw error;
  }
}

/**
 * テナント用 IAM Role を削除
 */
export async function deleteTenantRole(tenantSlug: string): Promise<void> {
  const roleName = `tenkacloud-tenant-${tenantSlug}`;

  if (isLocalStack) {
    console.log('LocalStack モード: IAM Role 削除をスキップします', {
      roleName,
    });
    return;
  }

  try {
    // Inline Policy を削除
    try {
      await iamClient.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: 'TenantAccessPolicy',
        })
      );
    } catch (error) {
      // Policy が存在しない場合は無視
      if ((error as { name?: string }).name !== 'NoSuchEntityException') {
        throw error;
      }
    }

    // Role を削除
    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));

    console.log('IAM Role を削除しました', { roleName });
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchEntityException') {
      console.log('IAM Role は存在しません', { roleName });
      return;
    }
    console.error('IAM Role 削除に失敗しました', { roleName, error });
    throw error;
  }
}
