/**
 * AWS Console Federation API
 *
 * STS Federation を使用して参加者用 AWS Console ログイン URL を生成するエンドポイント。
 * デプロイメントレコードから competitor account の roleArn を取得する。
 * フォールバックとして環境変数を使用する。
 */

import { auth } from '@/auth';
import { stsFederation } from '@/lib/aws';
import { serverApiRequest } from '@/lib/api/server';
import type { DeploymentStatus } from '@/lib/api/gameday-types';

/**
 * デプロイメントレコードから roleArn を取得する
 *
 * イベント全体のデプロイメント状態を 1 回の API 呼び出しで取得する。
 */
async function fetchRoleArnFromDeployment(
  eventId: string,
): Promise<string | null> {
  try {
    const result = await serverApiRequest<DeploymentStatus>(
      `/participant/events/${eventId}/deployments/status`,
    );
    if (result.deployed && result.roleArn) {
      return result.roleArn;
    }
  } catch (error) {
    // デプロイメントレコードからの取得失敗は無視してフォールバック
    console.warn('Failed to fetch deployment roleArn:', error);
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  // 認証チェック
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  // Role ARN の取得: デプロイメントレコード → 環境変数の順にフォールバック
  const deploymentRoleArn = await fetchRoleArnFromDeployment(eventId);
  const roleArn =
    deploymentRoleArn ||
    process.env.AWS_PARTICIPANT_ROLE_ARN ||
    process.env[`AWS_ROLE_ARN_${eventId}`];

  if (!roleArn) {
    return Response.json(
      {
        error:
          'AWS Console access is not configured for this event. No deployment record or environment configuration found.',
      },
      { status: 404 },
    );
  }

  const tenantId = session.tenantId || 'default';
  const participantId = session.user?.email || 'unknown';
  const teamId = session.teamId || 'no-team';

  try {
    const result = await stsFederation.generateParticipantConsoleUrl(
      tenantId,
      participantId,
      `${eventId}-${teamId}`,
      roleArn,
    );

    return Response.json({
      url: result.url,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('STS Federation error:', error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to generate AWS Console URL',
      },
      { status: 500 },
    );
  }
}
