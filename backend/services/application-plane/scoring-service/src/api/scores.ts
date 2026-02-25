import { Hono } from 'hono';
import { z } from 'zod';
import { assumeRole, createS3Client } from '../lib/aws';
import { evaluateBucket, type S3ScoringCriteria } from '../scorers/s3-scorer';
import { scoringSessionRepository } from '../lib/dynamodb';

export const scoresRoutes = new Hono();

const s3CheckValues = [
  'encryption',
  'public_access',
  'versioning',
  'logging',
] as const;

const evaluateSchema = z.object({
  participantId: z.string().min(1, '参加者IDは必須です'),
  battleId: z.string().min(1, 'バトルIDは必須です'),
  bucketName: z.string().min(1, 'バケット名は必須です'),
  roleArn: z.string().optional(),
  criteria: z
    .array(
      z.object({
        check: z.enum(s3CheckValues),
        weight: z.number().int().min(1).max(100),
      })
    )
    .min(1, '評価基準は1つ以上必要です'),
});

// POST /api/scores/evaluate - S3 バケット評価を実行
scoresRoutes.post('/api/scores/evaluate', async (c) => {
  const auth = c.get('auth');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストボディが不正です' }, 400);
  }

  const parsed = evaluateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }

  const { participantId, battleId, bucketName, roleArn, criteria } =
    parsed.data;

  try {
    // AssumeRole でクロスアカウントアクセス（roleArn が指定された場合）
    let s3Client;
    if (roleArn) {
      const credentials = await assumeRole(roleArn, `scoring-${participantId}`);
      s3Client = createS3Client(credentials);
    } else {
      s3Client = createS3Client();
    }

    // S3 バケット評価
    const scoringResult = await evaluateBucket(
      s3Client,
      bucketName,
      criteria as S3ScoringCriteria[]
    );

    // スコアを DynamoDB に保存
    const session = await scoringSessionRepository.create({
      tenantId: auth.tenantId,
      battleId,
      participantId,
    });

    const updatedSession = await scoringSessionRepository.update(session.id, {
      status: 'COMPLETED',
      totalScore: scoringResult.totalScore,
      maxPossibleScore: scoringResult.maxScore,
      evaluatedAt: new Date(),
      evaluationItems: scoringResult.results.map((r) => ({
        criteriaId: r.check,
        score: r.passed ? 1 : 0,
        maxScore: 1,
        passed: r.passed,
        details: { message: r.details },
      })),
    });

    return c.json({
      sessionId: updatedSession.id,
      participantId,
      battleId,
      bucketName: scoringResult.bucketName,
      totalScore: scoringResult.totalScore,
      maxScore: scoringResult.maxScore,
      results: scoringResult.results,
    });
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// GET /api/scores/:participantId - 参加者のスコア一覧取得
scoresRoutes.get('/api/scores/:participantId', async (c) => {
  const auth = c.get('auth');
  const participantId = c.req.param('participantId');
  const battleId = c.req.query('battleId');

  const { sessions } = await scoringSessionRepository.listByTenant(
    auth.tenantId,
    {
      participantId,
      battleId: battleId ?? undefined,
    }
  );

  return c.json({
    participantId,
    scores: sessions,
  });
});
