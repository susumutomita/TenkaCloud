/**
 * 競技者画面API（Player Portal）
 *
 * - チャレンジ一覧/詳細
 * - チャレンジ開始
 * - 回答検証
 * - クルー開示
 * - チームダッシュボード
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  authenticateRequest,
  canAccessTeam,
  hasAnyRole,
  UserRole,
} from '../auth';
import {
  startChallenge,
  getChallengesForTeam,
  getChallengeDetail,
} from '../jam/challenge';
import { validateAnswer, openClue } from '../jam/scoring';
import { getTeamDashboard, getLeaderboard } from '../jam/dashboard';

const playerRouter = new Hono();

// 認証ミドルウェア
playerRouter.use('*', async (c, next) => {
  const authContext = await authenticateRequest({
    authorization: c.req.header('Authorization'),
    authorizationtoken: c.req.header('AuthorizationToken'),
  });

  if (!authContext.isValid || !authContext.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 競技者またはそれ以上の権限が必要
  const hasAccess = hasAnyRole(authContext.user, [
    UserRole.COMPETITOR,
    UserRole.ORGANIZER,
    UserRole.TENANT_ADMIN,
    UserRole.PLATFORM_ADMIN,
  ]);

  if (!hasAccess) {
    return c.json({ error: 'Forbidden: Competitor access required' }, 403);
  }

  c.set('user', authContext.user);
  await next();
});

// チームアクセス検証ミドルウェア
const validateTeamAccess = async (
  c: Parameters<Parameters<typeof playerRouter.use>[1]>[0],
  next: () => Promise<void>
) => {
  const user = c.get('user');
  const teamId = c.req.param('teamId');

  if (teamId && !canAccessTeam(user, teamId)) {
    return c.json({ error: 'Forbidden: Cannot access this team' }, 403);
  }

  await next();
};

// ====================
// チャレンジ一覧/詳細
// ====================

// チャレンジ一覧取得
playerRouter.get(
  '/events/:eventId/teams/:teamId/challenges',
  validateTeamAccess,
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamId = c.req.param('teamId');

    const result = await getChallengesForTeam(eventId, teamId);
    return c.json(result);
  }
);

// チャレンジ詳細取得
playerRouter.get(
  '/events/:eventId/teams/:teamId/challenges/:challengeId',
  validateTeamAccess,
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamId = c.req.param('teamId');
    const challengeId = c.req.param('challengeId');

    const result = await getChallengeDetail(eventId, teamId, challengeId);
    return c.json(result);
  }
);

// ====================
// チャレンジ操作
// ====================

// チャレンジ開始
playerRouter.post(
  '/events/:eventId/teams/:teamId/challenges/:challengeId/start',
  validateTeamAccess,
  zValidator(
    'json',
    z.object({
      taskId: z.string(),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamId = c.req.param('teamId');
    const challengeId = c.req.param('challengeId');
    const { taskId } = c.req.valid('json');

    const result = await startChallenge(eventId, teamId, challengeId, taskId);
    return c.json(result);
  }
);

// 回答検証
playerRouter.post(
  '/events/:eventId/teams/:teamId/challenges/:challengeId/tasks/:taskId/validate',
  validateTeamAccess,
  zValidator(
    'json',
    z.object({
      answer: z.string(),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamId = c.req.param('teamId');
    const challengeId = c.req.param('challengeId');
    const taskId = c.req.param('taskId');
    const { answer } = c.req.valid('json');

    const result = await validateAnswer(
      eventId,
      teamId,
      challengeId,
      taskId,
      answer
    );
    return c.json(result);
  }
);

// クルー開示
playerRouter.post(
  '/events/:eventId/teams/:teamId/challenges/:challengeId/tasks/:taskId/clue',
  validateTeamAccess,
  zValidator(
    'json',
    z.object({
      clueOrder: z.number().min(1).max(3),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamId = c.req.param('teamId');
    const challengeId = c.req.param('challengeId');
    const taskId = c.req.param('taskId');
    const { clueOrder } = c.req.valid('json');

    const result = await openClue(
      eventId,
      teamId,
      challengeId,
      taskId,
      clueOrder
    );
    return c.json(result);
  }
);

// ====================
// チームダッシュボード
// ====================

// チームダッシュボード取得
playerRouter.get(
  '/events/:eventId/teams/:teamId/dashboard',
  validateTeamAccess,
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamId = c.req.param('teamId');

    const dashboard = await getTeamDashboard(eventId, teamId);
    return c.json(dashboard);
  }
);

// リーダーボード（競技者ビュー）
playerRouter.get('/events/:eventId/leaderboard', async (c) => {
  const eventId = c.req.param('eventId');
  const limit = parseInt(c.req.query('limit') || '50');
  const leaderboard = await getLeaderboard(eventId, limit);

  // 競技者向けには簡略化したリーダーボードを返す
  const publicLeaderboard = leaderboard.map((entry) => ({
    rank: entry.rank,
    teamName: entry.teamName,
    score: entry.score,
    completedChallenges: entry.completedChallenges,
  }));

  return c.json({ leaderboard: publicLeaderboard });
});

export { playerRouter };
