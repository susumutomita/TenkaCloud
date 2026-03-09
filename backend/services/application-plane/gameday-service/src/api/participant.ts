import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { StatusCodes } from 'http-status-codes';
import {
  purchaseAttackSchema,
  executeAttackSchema,
  purchaseHintSchema,
  reportFixSchema,
  requestAllianceSchema,
  allianceActionSchema,
  voteSchema,
} from '../schemas';
import {
  getAttackCatalog,
  purchaseAttack,
  executeAttack,
  getAttackHistory,
  getActiveAttacks,
  purchaseHint,
  reportFix,
  listTeamAlliances,
  requestAlliance,
  acceptAlliance,
  breakAlliance,
  getMonitoringStatus,
  castVote,
  getVotingResults,
  GameNotRunningError,
  AttackNotFoundError,
  AttackNotPurchasedError,
  CooldownActiveError,
  SelfAttackError,
  InsufficientScoreError,
  TeamNotFoundError,
  AllianceNotFoundError,
  AllianceUnauthorizedError,
  SelfVoteError,
  AttackAlreadyPurchasedError,
  VoteAlreadyExistsError,
} from '../services/participant-service';

export const participantRoutes = new Hono();

function mapErrorToResponse(error: unknown): {
  error: string;
  status: ContentfulStatusCode;
  remainingSeconds?: number;
} | null {
  if (error instanceof GameNotRunningError) {
    return { error: error.message, status: 409 };
  }
  if (error instanceof AttackNotFoundError) {
    return { error: error.message, status: 404 };
  }
  if (error instanceof AttackNotPurchasedError) {
    return { error: error.message, status: 412 };
  }
  if (error instanceof CooldownActiveError) {
    return {
      error: error.message,
      status: 429,
      remainingSeconds: error.remainingSeconds,
    };
  }
  if (error instanceof SelfAttackError) {
    return { error: error.message, status: 400 };
  }
  if (error instanceof InsufficientScoreError) {
    return { error: error.message, status: 402 };
  }
  if (error instanceof AllianceNotFoundError) {
    return { error: error.message, status: 404 };
  }
  if (error instanceof AllianceUnauthorizedError) {
    return { error: error.message, status: 403 };
  }
  if (error instanceof SelfVoteError) {
    return { error: error.message, status: 400 };
  }
  if (error instanceof VoteAlreadyExistsError) {
    return { error: error.message, status: 409 };
  }
  if (error instanceof AttackAlreadyPurchasedError) {
    return { error: error.message, status: 409 };
  }
  if (error instanceof TeamNotFoundError) {
    return { error: error.message, status: 404 };
  }
  return null;
}

// === 攻撃 ===

// 攻撃カタログ
participantRoutes.get('/attacks/catalog', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  const attacks = await getAttackCatalog(eventId);
  return c.json({ attacks }, StatusCodes.OK);
});

// 攻撃購入
participantRoutes.post('/attacks/purchase', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = purchaseAttackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await purchaseAttack(
      parsed.data.eventId,
      parsed.data.teamId,
      parsed.data.attackId
    );
    return c.json(result, StatusCodes.CREATED);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// 攻撃実行
participantRoutes.post('/attacks/execute', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = executeAttackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await executeAttack(
      parsed.data.eventId,
      parsed.data.teamId,
      parsed.data.targetTeamId,
      parsed.data.attackId
    );
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      const body: Record<string, unknown> = { error: mapped.error };
      if (mapped.remainingSeconds !== undefined) {
        body.remainingSeconds = mapped.remainingSeconds;
      }
      return c.json(body, mapped.status);
    }
    throw error;
  }
});

// 攻撃履歴
participantRoutes.get('/attacks/history', async (c) => {
  const eventId = c.req.query('eventId');
  const teamId = c.req.query('teamId');
  if (!eventId || !teamId) {
    return c.json(
      { error: 'eventId と teamId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const history = await getAttackHistory(eventId, teamId);
  return c.json({ history }, StatusCodes.OK);
});

// === 防御 ===

// 受けている攻撃一覧
participantRoutes.get('/defense/active', async (c) => {
  const eventId = c.req.query('eventId');
  const teamId = c.req.query('teamId');
  if (!eventId || !teamId) {
    return c.json(
      { error: 'eventId と teamId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const attacks = await getActiveAttacks(eventId, teamId);
  return c.json({ attacks }, StatusCodes.OK);
});

// ヒント購入
participantRoutes.post('/defense/hint', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = purchaseHintSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await purchaseHint(
      parsed.data.eventId,
      parsed.data.teamId,
      parsed.data.attackId
    );
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// 脆弱性修正報告
participantRoutes.post('/defense/report-fix', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = reportFixSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await reportFix(
      parsed.data.eventId,
      parsed.data.teamId,
      parsed.data.vulnerabilitySlug
    );
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// === 同盟 ===

// 同盟一覧
participantRoutes.get('/alliances', async (c) => {
  const eventId = c.req.query('eventId');
  const teamId = c.req.query('teamId');
  if (!eventId || !teamId) {
    return c.json(
      { error: 'eventId と teamId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const alliances = await listTeamAlliances(eventId, teamId);
  return c.json({ alliances }, StatusCodes.OK);
});

// 同盟申請
participantRoutes.post('/alliances/request', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = requestAllianceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await requestAlliance(
      parsed.data.eventId,
      parsed.data.teamId,
      parsed.data.targetTeamId
    );
    return c.json(result, StatusCodes.CREATED);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// 同盟承認
participantRoutes.post('/alliances/:id/accept', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = allianceActionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await acceptAlliance(
      parsed.data.eventId,
      id,
      parsed.data.teamId
    );
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// 同盟破棄
participantRoutes.post('/alliances/:id/break', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = allianceActionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    await breakAlliance(parsed.data.eventId, id, parsed.data.teamId);
    return c.json({ success: true }, StatusCodes.OK);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// === モニタリング ===

// ヘルスチェック状態
participantRoutes.get('/monitoring/status', async (c) => {
  const eventId = c.req.query('eventId');
  const teamId = c.req.query('teamId');
  if (!eventId || !teamId) {
    return c.json(
      { error: 'eventId と teamId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const checks = await getMonitoringStatus(eventId, teamId);
  return c.json({ checks }, StatusCodes.OK);
});

// === 投票 ===

// 投票
participantRoutes.post('/voting/vote', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = voteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await castVote(
      parsed.data.eventId,
      parsed.data.teamId,
      parsed.data.votedForTeamId
    );
    return c.json(result, StatusCodes.CREATED);
  } catch (error) {
    const mapped = mapErrorToResponse(error);
    if (mapped) {
      return c.json({ error: mapped.error }, mapped.status);
    }
    throw error;
  }
});

// 投票結果
participantRoutes.get('/voting/results', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  const results = await getVotingResults(eventId);
  return c.json({ results }, StatusCodes.OK);
});
