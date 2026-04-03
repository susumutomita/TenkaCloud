/**
 * AWS Console Federation API
 *
 * STS Federation を使用して参加者用 AWS Console ログイン URL を生成するエンドポイント
 */

import { auth } from '@/auth';
import { stsFederation } from '@/lib/aws';

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

  // Role ARN の取得（環境変数またはイベント設定から）
  const roleArn =
    process.env.AWS_PARTICIPANT_ROLE_ARN ||
    process.env[`AWS_ROLE_ARN_${eventId}`];

  if (!roleArn) {
    return Response.json(
      { error: 'AWS Console access is not configured for this event' },
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
