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
  updateTeamUrlSchema,
} from '../schemas';
import { getGameStatus } from '../services/game-controller';
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
import {
  updateTeamUrl,
  getLeaderboard,
  getAttackStatistics,
  getTeamDashboard,
  listTeams,
  registerTeam,
  joinTeamByInviteCode,
  BlackoutActiveError,
  TeamNotFoundError as DashboardTeamNotFoundError,
  TeamAlreadyExistsError,
} from '../services/dashboard-service';
import {
  getAllAttackLogs,
  getAttackHistory,
} from '../services/participant-service';
import { GamedayRepository } from '../repositories/gameday-repository';

const gamedayRepo = new GamedayRepository();

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

// チーム一覧
participantRoutes.get('/teams', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }

  const teams = await listTeams(eventId);
  return c.json({ teams }, StatusCodes.OK);
});

// ゲーム状態
participantRoutes.get('/game/status', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }

  const gameState = await getGameStatus(eventId);
  if (!gameState) {
    return c.json({ error: 'ゲームが見つかりません' }, StatusCodes.NOT_FOUND);
  }

  return c.json(gameState, StatusCodes.OK);
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

// === ダッシュボード ===

// リーダーボード
participantRoutes.get('/dashboard/leaderboard', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  try {
    const [teams, allLogs] = await Promise.all([
      getLeaderboard(eventId),
      getAllAttackLogs(eventId).catch(() => []),
    ]);
    // 全ログを使ってチームごとの攻撃統計を集計
    const attacksSent = new Map<string, number>();
    const attacksReceived = new Map<string, number>();
    const vulnsFixed = new Map<string, number>();
    for (const log of allLogs) {
      attacksSent.set(
        log.attackerTeamId,
        (attacksSent.get(log.attackerTeamId) ?? 0) + 1
      );
      attacksReceived.set(
        log.defenderTeamId,
        (attacksReceived.get(log.defenderTeamId) ?? 0) + 1
      );
    }
    const leaderboard = teams.map((team, index) => ({
      teamId: team.teamId,
      teamName: team.teamName,
      score: team.score,
      rank: index + 1,
      attacksLaunched: attacksSent.get(team.teamId) ?? 0,
      attacksReceived: attacksReceived.get(team.teamId) ?? 0,
      vulnerabilitiesFixed: vulnsFixed.get(team.teamId) ?? 0,
    }));
    return c.json({ leaderboard }, StatusCodes.OK);
  } catch (error) {
    if (error instanceof BlackoutActiveError) {
      return c.json({ error: error.message }, StatusCodes.FORBIDDEN);
    }
    throw error;
  }
});

// 攻撃統計
participantRoutes.get('/dashboard/attack-stats', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  // 全ログから攻撃スラグごとに集計
  const allLogs = await getAllAttackLogs(eventId).catch(() => []);
  const statsMap = new Map<
    string,
    { attackName: string; total: number; successes: number }
  >();
  for (const log of allLogs) {
    if (!log.attackSlug) continue;
    const entry = statsMap.get(log.attackSlug) ?? {
      attackName: log.attackSlug,
      total: 0,
      successes: 0,
    };
    entry.total++;
    if (log.success) entry.successes++;
    statsMap.set(log.attackSlug, entry);
  }
  const stats = Array.from(statsMap.entries()).map(([slug, s]) => ({
    attackSlug: slug,
    attackName: s.attackName,
    totalExecutions: s.total,
    successRate: s.total > 0 ? s.successes / s.total : 0,
  }));
  return c.json({ stats }, StatusCodes.OK);
});

// チーム詳細ダッシュボード
participantRoutes.get('/dashboard/team', async (c) => {
  const eventId = c.req.query('eventId');
  const teamId = c.req.query('teamId');
  if (!eventId || !teamId) {
    return c.json(
      { error: 'eventId と teamId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const dashboard = await getTeamDashboard(eventId, teamId);
  if (!dashboard) {
    return c.json(
      {
        team: {
          teamId,
          teamName: '',
          score: 0,
          isHealthy: true,
          websiteUrl: null,
          apiUrl: null,
        },
        score: 0,
        recentAttacks: [],
        recentHealthChecks: [],
        attackHistory: [],
      },
      StatusCodes.OK
    );
  }
  return c.json(dashboard, StatusCodes.OK);
});

// === チーム URL 更新 ===

participantRoutes.post('/teams/update-url', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = updateTeamUrlSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  const { eventId, teamId, websiteUrl, apiUrl } = parsed.data;
  try {
    await updateTeamUrl(eventId, teamId, { websiteUrl, apiUrl });
    return c.json({ success: true }, StatusCodes.OK);
  } catch (error) {
    if (error instanceof DashboardTeamNotFoundError) {
      return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
    }
    throw error;
  }
});

// === チーム作成 ===

participantRoutes.post('/teams/create', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const { eventId, teamId, teamName, userId } = body as {
    eventId?: string;
    teamId?: string;
    teamName?: string;
    userId?: string;
  };
  if (!eventId || !teamId || !teamName) {
    return c.json(
      { error: 'eventId, teamId, teamName は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const team = await registerTeam({ eventId, teamId, teamName });
    if (userId) {
      await gamedayRepo.addMember({
        eventId,
        userId,
        teamId: team.teamId,
        teamName: team.teamName,
        mode: 'team',
      });
    }
    return c.json(
      {
        teamId: team.teamId,
        teamName: team.teamName,
        inviteCode: team.inviteCode,
      },
      StatusCodes.CREATED
    );
  } catch (error) {
    if (error instanceof TeamAlreadyExistsError) {
      return c.json({ error: error.message }, StatusCodes.CONFLICT);
    }
    throw error;
  }
});

// === 招待コードでチーム参加 ===

participantRoutes.post('/teams/join', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const { eventId, inviteCode, userId } = body as {
    eventId?: string;
    inviteCode?: string;
    userId?: string;
  };
  if (!eventId || !inviteCode) {
    return c.json(
      { error: 'eventId, inviteCode は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const team = await joinTeamByInviteCode(eventId, inviteCode);
  if (!team) {
    return c.json({ error: '招待コードが無効です' }, StatusCodes.NOT_FOUND);
  }
  if (userId) {
    await gamedayRepo.addMember({
      eventId,
      userId,
      teamId: team.teamId,
      teamName: team.teamName,
      mode: 'team',
    });
  }
  return c.json(
    { teamId: team.teamId, teamName: team.teamName },
    StatusCodes.OK
  );
});

// === ソロ参加登録 ===

participantRoutes.post('/teams/solo', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const { eventId, userId } = body as { eventId?: string; userId?: string };
  if (!eventId || !userId) {
    return c.json(
      { error: 'eventId, userId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  await gamedayRepo.addMember({
    eventId,
    userId,
    teamId: `solo-${userId}`,
    teamName: 'ソロ参加',
    mode: 'solo',
  });
  return c.json({ mode: 'solo' }, StatusCodes.CREATED);
});

// === メンバーシップ取得 ===

participantRoutes.get('/teams/my-membership', async (c) => {
  const eventId = c.req.query('eventId');
  const userId = c.req.query('userId');
  if (!eventId || !userId) {
    return c.json(
      { error: 'eventId, userId は必須です' },
      StatusCodes.BAD_REQUEST
    );
  }
  const membership = await gamedayRepo.getMembership(eventId, userId);
  if (!membership) {
    return c.json({ membership: null }, StatusCodes.OK);
  }
  return c.json({ membership }, StatusCodes.OK);
});
