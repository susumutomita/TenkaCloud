/**
 * AWS Console Federation API
 *
 * STS Federation を使用して参加者用 AWS Console ログイン URL を生成するエンドポイント。
 * デプロイメントレコードから competitor account の roleArn を取得する。
 * フォールバックとして環境変数を使用する。
 */

import { auth } from '@/auth';
import { stsFederation } from '@/lib/aws';
import { getProblemServiceUrl } from '@/lib/api/backend-urls';
import { getAuthToken } from '@/lib/auth/get-auth-token';

interface DeploymentStatusResponse {
  deployed: boolean;
  status: string;
  outputs: Record<string, string> | null;
  roleArn: string | null;
  externalId: string | null;
  competitorAccountId: string | null;
  region: string | null;
  error: string | null;
}

/**
 * デプロイメントレコードから roleArn を取得する
 */
async function fetchRoleArnFromDeployment(
  eventId: string,
): Promise<string | null> {
  try {
    const baseUrl = getProblemServiceUrl();
    const token = await getAuthToken();

    // イベントの全 problem のデプロイ状態を確認
    // まずイベント情報を取得して problemId を特定する
    const eventRes = await fetch(`${baseUrl}/participant/events/${eventId}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!eventRes.ok) return null;

    const eventData = (await eventRes.json()) as {
      problems?: { problemId: string }[];
    };
    if (!eventData.problems?.length) return null;

    // 最初の problem のデプロイ状態を取得
    for (const problem of eventData.problems) {
      const statusRes = await fetch(
        `${baseUrl}/participant/events/${eventId}/problems/${problem.problemId}/deployments/status`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (!statusRes.ok) continue;

      const status = (await statusRes.json()) as DeploymentStatusResponse;
      if (status.deployed && status.roleArn) {
        return status.roleArn;
      }
    }
  } catch {
    // デプロイメントレコードからの取得失敗は無視してフォールバック
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
