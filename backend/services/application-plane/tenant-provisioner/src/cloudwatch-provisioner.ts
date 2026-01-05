/**
 * CloudWatch Logs Provisioner
 *
 * テナント用 CloudWatch Log Group を作成する。
 * tier に応じた保持期間を設定。
 *
 * LocalStack 環境では Log Group を作成するが、保持ポリシーはスキップ。
 */

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
  TagLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// 環境変数
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

// LocalStack 判定
const isLocalStack =
  AWS_ENDPOINT_URL?.includes('localhost') ||
  AWS_ENDPOINT_URL?.includes('localstack');

// CloudWatch Logs クライアント
const logsClient = new CloudWatchLogsClient({
  ...(AWS_ENDPOINT_URL && { endpoint: AWS_ENDPOINT_URL }),
});

/**
 * tier ごとのログ保持期間（日数）
 */
const RETENTION_DAYS: Record<string, number> = {
  FREE: 30,
  PRO: 90,
  ENTERPRISE: 365,
};

/**
 * CloudWatch Logs プロビジョニング結果
 */
export interface CloudWatchProvisionerResult {
  logGroupName: string;
  retentionDays: number;
}

/**
 * テナント用 Log Group を作成
 */
export async function createTenantLogGroup(
  tenantId: string,
  tenantSlug: string,
  tier: string
): Promise<CloudWatchProvisionerResult> {
  const logGroupName = `/tenkacloud/tenants/${tenantId}`;
  const retentionDays = RETENTION_DAYS[tier] ?? 30;

  try {
    // 既存の Log Group を確認
    const describeResult = await logsClient.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: logGroupName,
        limit: 1,
      })
    );

    const existingGroup = describeResult.logGroups?.find(
      (g) => g.logGroupName === logGroupName
    );

    if (existingGroup) {
      console.log('Log Group は既に存在します', { logGroupName });

      // 保持期間を更新（tier 変更時など）
      if (!isLocalStack && existingGroup.retentionInDays !== retentionDays) {
        await logsClient.send(
          new PutRetentionPolicyCommand({
            logGroupName,
            retentionInDays: retentionDays,
          })
        );
        console.log('Log Group の保持期間を更新しました', {
          logGroupName,
          retentionDays,
        });
      }

      return { logGroupName, retentionDays };
    }

    // Log Group を作成
    await logsClient.send(
      new CreateLogGroupCommand({
        logGroupName,
        tags: {
          TenantId: tenantId,
          TenantSlug: tenantSlug,
          Tier: tier,
          ManagedBy: 'tenkacloud',
        },
      })
    );

    console.log('Log Group を作成しました', { logGroupName });

    // 保持期間を設定（LocalStack ではスキップ）
    if (!isLocalStack) {
      await logsClient.send(
        new PutRetentionPolicyCommand({
          logGroupName,
          retentionInDays: retentionDays,
        })
      );
      console.log('Log Group の保持期間を設定しました', {
        logGroupName,
        retentionDays,
      });
    }

    return { logGroupName, retentionDays };
  } catch (error) {
    // ResourceAlreadyExistsException は無視
    if (
      (error as { name?: string }).name === 'ResourceAlreadyExistsException'
    ) {
      console.log('Log Group は既に存在します（競合）', { logGroupName });
      return { logGroupName, retentionDays };
    }

    console.error('Log Group 作成に失敗しました', { logGroupName, error });
    throw error;
  }
}

/**
 * テナント用 Log Group を削除
 */
export async function deleteTenantLogGroup(tenantId: string): Promise<void> {
  const logGroupName = `/tenkacloud/tenants/${tenantId}`;

  try {
    await logsClient.send(
      new DeleteLogGroupCommand({
        logGroupName,
      })
    );

    console.log('Log Group を削除しました', { logGroupName });
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      console.log('Log Group は存在しません', { logGroupName });
      return;
    }

    console.error('Log Group 削除に失敗しました', { logGroupName, error });
    throw error;
  }
}

/**
 * tier 変更時に保持期間を更新
 */
export async function updateLogGroupRetention(
  tenantId: string,
  tier: string
): Promise<void> {
  const logGroupName = `/tenkacloud/tenants/${tenantId}`;
  const retentionDays = RETENTION_DAYS[tier] ?? 30;

  if (isLocalStack) {
    console.log('LocalStack モード: 保持期間更新をスキップします', {
      logGroupName,
    });
    return;
  }

  try {
    await logsClient.send(
      new PutRetentionPolicyCommand({
        logGroupName,
        retentionInDays: retentionDays,
      })
    );

    console.log('Log Group の保持期間を更新しました', {
      logGroupName,
      retentionDays,
    });
  } catch (error) {
    console.error('保持期間更新に失敗しました', { logGroupName, error });
    throw error;
  }
}
