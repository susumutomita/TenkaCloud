/**
 * 管理画面API
 *
 * - イベント CRUD
 * - 問題 CRUD
 * - コンテスト開始/停止
 * - チーム管理
 * - ダッシュボード（管理者ビュー）
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  authenticateRequest,
  hasRole,
  UserRole,
  type AuthenticatedUser,
} from '../auth';
import {
  startContest,
  stopContest,
  pauseContest,
  resumeContest,
  addChallengeToContest,
  removeChallengeFromContest,
  registerTeamToContest,
  getContestTeams,
} from '../jam/contest';
import {
  getEventDashboard,
  getChallengeStatistics,
  getLeaderboard,
  saveLeaderboardSnapshot,
} from '../jam/dashboard';
import { getEventLogs } from '../jam/eventlog';
import {
  PrismaEventRepository,
  PrismaProblemRepository,
  PrismaMarketplaceRepository,
  getEventWithProblems,
  addProblemToEvent,
  removeProblemFromEvent,
} from '../repositories';
import {
  exportProblem,
  exportProblems,
  importProblem,
  importProblems,
  detectFormat,
  type ExternalFormat,
} from '../problems/converter';

const adminRouter = new Hono();

// リポジトリインスタンス
const eventRepository = new PrismaEventRepository();
const problemRepository = new PrismaProblemRepository();
const marketplaceRepository = new PrismaMarketplaceRepository();

// 認証ミドルウェア
adminRouter.use('*', async (c, next) => {
  const authContext = await authenticateRequest({
    authorization: c.req.header('Authorization'),
    authorizationtoken: c.req.header('AuthorizationToken'),
  });

  if (!authContext.isValid || !authContext.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 管理者権限チェック
  const isAdmin =
    hasRole(authContext.user, UserRole.PLATFORM_ADMIN) ||
    hasRole(authContext.user, UserRole.TENANT_ADMIN) ||
    hasRole(authContext.user, UserRole.ORGANIZER);

  if (!isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }

  c.set('user', authContext.user);
  await next();
});

// ====================
// イベント CRUD
// ====================

// イベントスキーマ
const createEventSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['gameday', 'jam']),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  timezone: z.string().default('Asia/Tokyo'),
  participantType: z.enum(['individual', 'team']),
  maxParticipants: z.number().min(1),
  minTeamSize: z.number().min(1).optional(),
  maxTeamSize: z.number().min(1).optional(),
  cloudProvider: z.enum(['aws', 'gcp', 'azure', 'local']),
  regions: z.array(z.string()).min(1),
  scoringType: z.enum(['realtime', 'batch']),
  scoringIntervalMinutes: z.number().min(1),
  leaderboardVisible: z.boolean().default(true),
  freezeLeaderboardMinutes: z.number().optional(),
  problemIds: z.array(z.string()).optional(),
});

const updateEventSchema = createEventSchema.partial().extend({
  status: z
    .enum(['draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled'])
    .optional(),
});

// イベント一覧取得
adminRouter.get('/events', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const tenantId = user.tenantId || 'default';

  const status = c.req.query('status');
  const type = c.req.query('type');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    const events = await eventRepository.findByTenant(tenantId, {
      status: status as
        | 'draft'
        | 'scheduled'
        | 'active'
        | 'paused'
        | 'completed'
        | 'cancelled'
        | undefined,
      type: type as 'gameday' | 'jam' | undefined,
      limit,
      offset,
    });

    const total = await eventRepository.count({
      tenantId,
      type: type as 'gameday' | 'jam' | undefined,
      status: status as
        | 'draft'
        | 'scheduled'
        | 'active'
        | 'paused'
        | 'completed'
        | 'cancelled'
        | undefined,
    });

    return c.json({ events, total });
  } catch (error) {
    console.error('Failed to get events:', error);
    return c.json({ error: 'Failed to get events' }, 500);
  }
});

// イベント詳細取得
adminRouter.get('/events/:eventId', async (c) => {
  const eventId = c.req.param('eventId');

  try {
    const eventWithProblems = await getEventWithProblems(eventId);
    if (!eventWithProblems) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // レスポンス形式に変換
    const event = {
      id: eventWithProblems.id,
      externalId: eventWithProblems.externalId,
      name: eventWithProblems.name,
      type: eventWithProblems.type.toLowerCase(),
      status: eventWithProblems.status.toLowerCase(),
      tenantId: eventWithProblems.tenantId,
      startTime: eventWithProblems.startTime.toISOString(),
      endTime: eventWithProblems.endTime.toISOString(),
      timezone: eventWithProblems.timezone,
      participantType: eventWithProblems.participantType.toLowerCase(),
      maxParticipants: eventWithProblems.maxParticipants,
      minTeamSize: eventWithProblems.minTeamSize,
      maxTeamSize: eventWithProblems.maxTeamSize,
      cloudProvider: eventWithProblems.cloudProvider.toLowerCase(),
      regions: eventWithProblems.regions,
      scoringType: eventWithProblems.scoringType.toLowerCase(),
      scoringIntervalMinutes: eventWithProblems.scoringIntervalMinutes,
      leaderboardVisible: eventWithProblems.leaderboardVisible,
      freezeLeaderboardMinutes: eventWithProblems.freezeLeaderboardMinutes,
      problemCount: eventWithProblems.problems.length,
      problems: eventWithProblems.problems.map((ep) => ({
        problemId: ep.problemId,
        problemTitle: ep.problem.title,
        order: ep.order,
        unlockTime: ep.unlockTime?.toISOString(),
        pointMultiplier: ep.pointMultiplier,
      })),
      createdAt: eventWithProblems.createdAt.toISOString(),
      updatedAt: eventWithProblems.updatedAt.toISOString(),
    };

    return c.json(event);
  } catch (error) {
    console.error('Failed to get event:', error);
    return c.json({ error: 'Failed to get event' }, 500);
  }
});

// イベント作成
adminRouter.post(
  '/events',
  zValidator('json', createEventSchema),
  async (c) => {
    const user = c.get('user') as AuthenticatedUser;
    const tenantId = user.tenantId || 'default';
    const data = c.req.valid('json');

    try {
      const event = await eventRepository.create({
        tenantId,
        name: data.name,
        type: data.type,
        status: 'draft',
        startTime: new Date(data.startTime),
        endTime: new Date(data.endTime),
        timezone: data.timezone,
        participantType: data.participantType,
        maxParticipants: data.maxParticipants,
        minTeamSize: data.minTeamSize,
        maxTeamSize: data.maxTeamSize,
        cloudProvider: data.cloudProvider,
        regions: data.regions,
        scoringType: data.scoringType,
        scoringIntervalMinutes: data.scoringIntervalMinutes,
        leaderboardVisible: data.leaderboardVisible,
        freezeLeaderboardMinutes: data.freezeLeaderboardMinutes,
        createdBy: user.id,
      });

      // 問題を関連付け
      if (data.problemIds && data.problemIds.length > 0) {
        for (let i = 0; i < data.problemIds.length; i++) {
          await addProblemToEvent(event.id, data.problemIds[i], {
            order: i + 1,
          });
        }
      }

      return c.json(event, 201);
    } catch (error) {
      console.error('Failed to create event:', error);
      return c.json({ error: 'Failed to create event' }, 500);
    }
  }
);

// イベント更新
adminRouter.put(
  '/events/:eventId',
  zValidator('json', updateEventSchema),
  async (c) => {
    const eventId = c.req.param('eventId');
    const data = c.req.valid('json');

    try {
      const updates: Record<string, unknown> = {};

      if (data.name !== undefined) updates.name = data.name;
      if (data.status !== undefined) updates.status = data.status;
      if (data.startTime !== undefined)
        updates.startTime = new Date(data.startTime);
      if (data.endTime !== undefined) updates.endTime = new Date(data.endTime);
      if (data.timezone !== undefined) updates.timezone = data.timezone;
      if (data.participantType !== undefined)
        updates.participantType = data.participantType;
      if (data.maxParticipants !== undefined)
        updates.maxParticipants = data.maxParticipants;
      if (data.minTeamSize !== undefined)
        updates.minTeamSize = data.minTeamSize;
      if (data.maxTeamSize !== undefined)
        updates.maxTeamSize = data.maxTeamSize;
      if (data.cloudProvider !== undefined)
        updates.cloudProvider = data.cloudProvider;
      if (data.regions !== undefined) updates.regions = data.regions;
      if (data.scoringType !== undefined)
        updates.scoringType = data.scoringType;
      if (data.scoringIntervalMinutes !== undefined)
        updates.scoringIntervalMinutes = data.scoringIntervalMinutes;
      if (data.leaderboardVisible !== undefined)
        updates.leaderboardVisible = data.leaderboardVisible;
      if (data.freezeLeaderboardMinutes !== undefined)
        updates.freezeLeaderboardMinutes = data.freezeLeaderboardMinutes;

      const event = await eventRepository.update(eventId, updates);
      return c.json(event);
    } catch (error) {
      console.error('Failed to update event:', error);
      return c.json({ error: 'Failed to update event' }, 500);
    }
  }
);

// イベント削除
adminRouter.delete('/events/:eventId', async (c) => {
  const eventId = c.req.param('eventId');

  try {
    await eventRepository.delete(eventId);
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete event:', error);
    return c.json({ error: 'Failed to delete event' }, 500);
  }
});

// イベントステータス更新
adminRouter.patch(
  '/events/:eventId/status',
  zValidator(
    'json',
    z.object({
      status: z.enum([
        'draft',
        'scheduled',
        'active',
        'paused',
        'completed',
        'cancelled',
      ]),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const { status } = c.req.valid('json');

    try {
      await eventRepository.updateStatus(eventId, status);
      return c.json({ success: true, status });
    } catch (error) {
      console.error('Failed to update event status:', error);
      return c.json({ error: 'Failed to update event status' }, 500);
    }
  }
);

// イベントに問題を追加
adminRouter.post(
  '/events/:eventId/problems',
  zValidator(
    'json',
    z.object({
      problemId: z.string(),
      order: z.number().optional(),
      unlockTime: z.string().datetime().optional(),
      pointMultiplier: z.number().optional(),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const data = c.req.valid('json');

    try {
      const eventProblem = await addProblemToEvent(eventId, data.problemId, {
        order: data.order,
        unlockTime: data.unlockTime ? new Date(data.unlockTime) : undefined,
        pointMultiplier: data.pointMultiplier,
      });
      return c.json(eventProblem, 201);
    } catch (error) {
      console.error('Failed to add problem to event:', error);
      return c.json({ error: 'Failed to add problem to event' }, 500);
    }
  }
);

// イベントから問題を削除
adminRouter.delete('/events/:eventId/problems/:problemId', async (c) => {
  const eventId = c.req.param('eventId');
  const problemId = c.req.param('problemId');

  try {
    await removeProblemFromEvent(eventId, problemId);
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to remove problem from event:', error);
    return c.json({ error: 'Failed to remove problem from event' }, 500);
  }
});

// ====================
// 問題 CRUD
// ====================

// 問題一覧取得
adminRouter.get('/problems', async (c) => {
  const type = c.req.query('type');
  const category = c.req.query('category');
  const difficulty = c.req.query('difficulty');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    const problems = await problemRepository.findAll({
      type: type as 'gameday' | 'jam' | undefined,
      category: category as
        | 'architecture'
        | 'security'
        | 'cost'
        | 'performance'
        | 'reliability'
        | 'operations'
        | undefined,
      difficulty: difficulty as
        | 'easy'
        | 'medium'
        | 'hard'
        | 'expert'
        | undefined,
      limit,
      offset,
    });

    const total = await problemRepository.count({
      type: type as 'gameday' | 'jam' | undefined,
      category: category as
        | 'architecture'
        | 'security'
        | 'cost'
        | 'performance'
        | 'reliability'
        | 'operations'
        | undefined,
      difficulty: difficulty as
        | 'easy'
        | 'medium'
        | 'hard'
        | 'expert'
        | undefined,
    });

    return c.json({ problems, total });
  } catch (error) {
    console.error('Failed to get problems:', error);
    return c.json({ error: 'Failed to get problems' }, 500);
  }
});

// 問題詳細取得
adminRouter.get('/problems/:problemId', async (c) => {
  const problemId = c.req.param('problemId');

  try {
    const problem = await problemRepository.findById(problemId);
    if (!problem) {
      return c.json({ error: 'Problem not found' }, 404);
    }
    return c.json(problem);
  } catch (error) {
    console.error('Failed to get problem:', error);
    return c.json({ error: 'Failed to get problem' }, 500);
  }
});

// マーケットプレイス検索
adminRouter.get('/marketplace', async (c) => {
  const query = c.req.query('query');
  const type = c.req.query('type');
  const category = c.req.query('category');
  const difficulty = c.req.query('difficulty');
  const provider = c.req.query('provider');
  const sortBy = c.req.query('sortBy') || 'relevance';
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');

  try {
    const result = await marketplaceRepository.search({
      query,
      type: type as 'gameday' | 'jam' | undefined,
      category: category as
        | 'architecture'
        | 'security'
        | 'cost'
        | 'performance'
        | 'reliability'
        | 'operations'
        | undefined,
      difficulty: difficulty as
        | 'easy'
        | 'medium'
        | 'hard'
        | 'expert'
        | undefined,
      provider: provider as 'aws' | 'gcp' | 'azure' | 'local' | undefined,
      sortBy: sortBy as 'relevance' | 'rating' | 'downloads' | 'newest',
      page,
      limit,
    });

    return c.json(result);
  } catch (error) {
    console.error('Failed to search marketplace:', error);
    return c.json({ error: 'Failed to search marketplace' }, 500);
  }
});

// 問題をインストール
adminRouter.post('/marketplace/:marketplaceId/install', async (c) => {
  const marketplaceId = c.req.param('marketplaceId');

  try {
    await marketplaceRepository.incrementDownloads(marketplaceId);
    const problem = await marketplaceRepository.findById(marketplaceId);
    if (!problem) {
      return c.json({ error: 'Problem not found' }, 404);
    }
    return c.json({ success: true, installedId: problem.id });
  } catch (error) {
    console.error('Failed to install problem:', error);
    return c.json({ error: 'Failed to install problem' }, 500);
  }
});

// ====================
// 問題インポート/エクスポート
// ====================

// フォーマット検出スキーマ
const formatDetectSchema = z.object({
  filename: z.string(),
});

// エクスポートオプションスキーマ
const exportOptionsSchema = z.object({
  format: z.enum(['tenkacloud-yaml', 'tenkacloud-json']),
  prettyPrint: z.boolean().optional(),
});

// インポートオプションスキーマ
const importOptionsSchema = z.object({
  format: z.enum(['tenkacloud-yaml', 'tenkacloud-json']),
  data: z.string(),
});

// フォーマット検出
adminRouter.post(
  '/problems/detect-format',
  zValidator('json', formatDetectSchema),
  async (c) => {
    const { filename } = c.req.valid('json');
    const format = detectFormat(filename);

    if (!format) {
      return c.json(
        {
          error: 'Unable to detect format from filename',
          supported: ['yaml', 'yml', 'json'],
        },
        400
      );
    }

    return c.json({ format });
  }
);

// 単一問題エクスポート
adminRouter.post(
  '/problems/:problemId/export',
  zValidator('json', exportOptionsSchema),
  async (c) => {
    const problemId = c.req.param('problemId');
    const options = c.req.valid('json');

    try {
      const problem = await problemRepository.findById(problemId);
      if (!problem) {
        return c.json({ error: 'Problem not found' }, 404);
      }

      const result = exportProblem(problem, {
        format: options.format as ExternalFormat,
        prettyPrint: options.prettyPrint,
      });

      if (!result.success) {
        return c.json(
          { error: result.errors.join(', '), warnings: result.warnings },
          400
        );
      }

      return c.json({
        data: result.data,
        format: options.format,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error('Failed to export problem:', error);
      return c.json({ error: 'Failed to export problem' }, 500);
    }
  }
);

// 複数問題エクスポート
adminRouter.post(
  '/problems/export',
  zValidator(
    'json',
    exportOptionsSchema.extend({
      problemIds: z.array(z.string()).min(1),
    })
  ),
  async (c) => {
    const { format, prettyPrint, problemIds } = c.req.valid('json');

    try {
      const problems = await Promise.all(
        problemIds.map((id) => problemRepository.findById(id))
      );

      const validProblems = problems.filter((p) => p !== null);
      if (validProblems.length === 0) {
        return c.json({ error: 'No valid problems found' }, 404);
      }

      const result = exportProblems(validProblems, {
        format: format as ExternalFormat,
        prettyPrint,
      });

      if (!result.success) {
        return c.json(
          { error: result.errors.join(', '), warnings: result.warnings },
          400
        );
      }

      return c.json({
        data: result.data,
        format,
        count: validProblems.length,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error('Failed to export problems:', error);
      return c.json({ error: 'Failed to export problems' }, 500);
    }
  }
);

// 単一問題インポート（プレビューのみ - 保存は行わない）
adminRouter.post(
  '/problems/import/preview',
  zValidator('json', importOptionsSchema),
  async (c) => {
    const { format, data } = c.req.valid('json');

    try {
      const result = importProblem(data, { format: format as ExternalFormat });

      if (!result.success) {
        return c.json(
          { error: result.errors.join(', '), warnings: result.warnings },
          400
        );
      }

      return c.json({
        preview: result.data,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error('Failed to preview problem import:', error);
      return c.json({ error: 'Failed to preview problem import' }, 500);
    }
  }
);

// 複数問題インポート（プレビューのみ - 保存は行わない）
adminRouter.post(
  '/problems/import/batch/preview',
  zValidator('json', importOptionsSchema),
  async (c) => {
    const { format, data } = c.req.valid('json');

    try {
      const result = importProblems(data, { format: format as ExternalFormat });

      if (!result.success) {
        return c.json(
          { error: result.errors.join(', '), warnings: result.warnings },
          400
        );
      }

      return c.json({
        preview: result.data,
        count: result.data?.length ?? 0,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error('Failed to preview batch problem import:', error);
      return c.json({ error: 'Failed to preview batch problem import' }, 500);
    }
  }
);

// ====================
// コンテスト管理
// ====================

// コンテスト開始
adminRouter.post(
  '/events/:eventId/contest/start',
  zValidator(
    'json',
    z.object({
      contestName: z.string(),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const { contestName } = c.req.valid('json');

    const result = await startContest(eventId, contestName);
    return c.json(result);
  }
);

// コンテスト停止
adminRouter.post(
  '/events/:eventId/contest/stop',
  zValidator(
    'json',
    z.object({
      contestName: z.string(),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const { contestName } = c.req.valid('json');

    const result = await stopContest(eventId, contestName);
    return c.json(result);
  }
);

// コンテスト一時停止
adminRouter.post('/events/:eventId/contest/pause', async (c) => {
  const eventId = c.req.param('eventId');
  const result = await pauseContest(eventId);
  return c.json(result);
});

// コンテスト再開
adminRouter.post('/events/:eventId/contest/resume', async (c) => {
  const eventId = c.req.param('eventId');
  const result = await resumeContest(eventId);
  return c.json(result);
});

// ====================
// 問題管理
// ====================

// 問題スキーマ
const challengeSchema = z.object({
  problemId: z.string(),
  challengeId: z.string(),
  title: z.string(),
  category: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  description: z.string(),
  region: z.string().optional(),
  sshKeyPairRequired: z.boolean().optional(),
  tasks: z.array(
    z.object({
      titleId: z.string(),
      title: z.string(),
      content: z.string(),
      taskNumber: z.number(),
      answerKey: z.string(),
      clues: z
        .array(
          z.object({
            title: z.string(),
            description: z.string(),
            order: z.number(),
          })
        )
        .optional(),
      scoring: z.object({
        pointsPossible: z.number(),
        clue1PenaltyPoints: z.number().optional(),
        clue2PenaltyPoints: z.number().optional(),
        clue3PenaltyPoints: z.number().optional(),
      }),
    })
  ),
});

// 問題追加
adminRouter.post(
  '/events/:eventId/challenges',
  zValidator('json', challengeSchema),
  async (c) => {
    const eventId = c.req.param('eventId');
    const challengeData = c.req.valid('json');

    const result = await addChallengeToContest(eventId, challengeData);
    return c.json(result, result.success ? 201 : 400);
  }
);

// 問題削除
adminRouter.delete('/events/:eventId/challenges/:challengeId', async (c) => {
  const eventId = c.req.param('eventId');
  const challengeId = c.req.param('challengeId');

  const result = await removeChallengeFromContest(eventId, challengeId);
  return c.json(result, result.success ? 200 : 400);
});

// ====================
// チーム管理
// ====================

// チーム登録
adminRouter.post(
  '/events/:eventId/teams',
  zValidator(
    'json',
    z.object({
      teamName: z.string(),
      members: z.array(z.string()).optional(),
    })
  ),
  async (c) => {
    const eventId = c.req.param('eventId');
    const teamData = c.req.valid('json');

    const result = await registerTeamToContest(eventId, teamData);
    return c.json(result, result.success ? 201 : 400);
  }
);

// チーム一覧取得
adminRouter.get('/events/:eventId/teams', async (c) => {
  const eventId = c.req.param('eventId');
  const teams = await getContestTeams(eventId);
  return c.json({ teams });
});

// ====================
// ダッシュボード（管理者ビュー）
// ====================

// イベント全体ダッシュボード
adminRouter.get('/events/:eventId/dashboard', async (c) => {
  const eventId = c.req.param('eventId');
  const dashboard = await getEventDashboard(eventId);
  return c.json(dashboard);
});

// リーダーボード
adminRouter.get('/events/:eventId/leaderboard', async (c) => {
  const eventId = c.req.param('eventId');
  const limit = parseInt(c.req.query('limit') || '100');
  const leaderboard = await getLeaderboard(eventId, limit);
  return c.json({ leaderboard });
});

// リーダーボードスナップショット保存
adminRouter.post('/events/:eventId/leaderboard/snapshot', async (c) => {
  const eventId = c.req.param('eventId');
  await saveLeaderboardSnapshot(eventId);
  return c.json({ success: true, message: 'Leaderboard snapshot saved' });
});

// チャレンジ統計
adminRouter.get('/events/:eventId/challenges/stats', async (c) => {
  const eventId = c.req.param('eventId');
  const stats = await getChallengeStatistics(eventId);
  return c.json({ stats });
});

// イベントログ
adminRouter.get('/events/:eventId/logs', async (c) => {
  const eventId = c.req.param('eventId');
  const teamName = c.req.query('teamName');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const result = await getEventLogs(eventId, { teamName, limit, offset });
  return c.json(result);
});

export { adminRouter };
