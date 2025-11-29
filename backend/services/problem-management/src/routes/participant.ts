/**
 * 参加者API
 *
 * - イベント参照・登録
 * - チャレンジ取得
 * - 採点リクエスト
 * - リーダーボード
 * - チーム管理
 * - プロフィール
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
  PrismaEventRepository,
  getEventWithProblems,
  prisma,
} from '../repositories';
import { getLeaderboard } from '../jam/dashboard';
import type { EventStatus, EventType } from '../types';

const participantRouter = new Hono();

// リポジトリインスタンス
const eventRepository = new PrismaEventRepository();

// 認証ミドルウェア
participantRouter.use('*', async (c, next) => {
  const authContext = await authenticateRequest({
    authorization: c.req.header('Authorization'),
    authorizationtoken: c.req.header('AuthorizationToken'),
  });

  if (!authContext.isValid || !authContext.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 参加者権限チェック（COMPETITOR, PLATFORM_ADMIN, TENANT_ADMIN, ORGANIZER）
  const isParticipant =
    hasRole(authContext.user, UserRole.COMPETITOR) ||
    hasRole(authContext.user, UserRole.PLATFORM_ADMIN) ||
    hasRole(authContext.user, UserRole.TENANT_ADMIN) ||
    hasRole(authContext.user, UserRole.ORGANIZER);

  if (!isParticipant) {
    return c.json({ error: 'Forbidden: Participant access required' }, 403);
  }

  c.set('user', authContext.user);
  await next();
});

// ====================
// イベント一覧・詳細
// ====================

/**
 * 参加可能なイベント一覧を取得
 */
participantRouter.get('/events', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { status, type, limit = '50', offset = '0' } = c.req.query();

  try {
    // EventFilterOptions に合わせた型
    const options: {
      type?: EventType;
      status?: EventStatus | EventStatus[];
      limit?: number;
      offset?: number;
    } = {
      limit: Number.parseInt(limit, 10),
      offset: Number.parseInt(offset, 10),
    };

    if (status) {
      options.status = status.split(',') as EventStatus[];
    }
    if (type === 'gameday' || type === 'jam') {
      options.type = type as EventType;
    }

    // tenantId でフィルタするには findByTenant を使用
    const events = user.tenantId
      ? await eventRepository.findByTenant(user.tenantId, options)
      : await eventRepository.findAll(options);
    const total = await eventRepository.count({
      ...options,
      tenantId: user.tenantId,
    });

    // 参加状況を追加
    const eventsWithRegistration = events.map((event) => ({
      ...event,
      isRegistered: false, // TODO: 実際の登録状況を確認
      myRank: undefined,
      myScore: undefined,
    }));

    return c.json({ events: eventsWithRegistration, total });
  } catch (error) {
    console.error('Failed to fetch events:', error);
    return c.json({ error: 'Failed to fetch events' }, 500);
  }
});

/**
 * 参加中のイベント一覧を取得
 */
participantRouter.get('/events/me', async (c) => {
  const user = c.get('user') as AuthenticatedUser;

  try {
    // TODO: 実際の参加イベントを取得（Team/Participantテーブルから）
    const events = user.tenantId
      ? await eventRepository.findByTenant(user.tenantId, {
          status: ['active', 'scheduled'] as EventStatus[],
          limit: 50,
        })
      : [];

    return c.json({ events });
  } catch (error) {
    console.error('Failed to fetch my events:', error);
    return c.json({ error: 'Failed to fetch events' }, 500);
  }
});

/**
 * イベント詳細を取得
 */
participantRouter.get('/events/:eventId', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { eventId } = c.req.param();

  try {
    const event = await getEventWithProblems(eventId);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // テナントチェック
    if (event.tenantId !== user.tenantId) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // 問題情報を参加者向けに変換（解答は含めない）
    const problems = event.problems.map((ep) => {
      // ScoringCriterion の maxPoints を合計して maxScore を計算
      const maxScore =
        ep.problem.criteria?.reduce((sum, c) => sum + c.maxPoints, 0) || 0;

      return {
        id: ep.problem.id,
        title: ep.problem.title,
        type: ep.problem.type.toLowerCase(),
        category: ep.problem.category.toLowerCase(),
        difficulty: ep.problem.difficulty.toLowerCase(),
        overview: ep.problem.overview,
        objectives: ep.problem.objectives,
        order: ep.order,
        unlockTime: ep.unlockTime?.toISOString(),
        isUnlocked: !ep.unlockTime || new Date() >= ep.unlockTime,
        pointMultiplier: ep.pointMultiplier,
        maxScore,
        myScore: undefined, // TODO: 実際のスコアを取得
        isCompleted: false, // TODO: 実際の完了状態を取得
        estimatedTimeMinutes: ep.problem.estimatedTimeMinutes,
      };
    });

    // participantCount を取得（TODO: 実際の参加者数）
    const participantCount = 0;

    return c.json({
      id: event.id,
      name: event.name,
      type: event.type.toLowerCase(),
      status: event.status.toLowerCase(),
      startTime: event.startTime.toISOString(),
      endTime: event.endTime.toISOString(),
      timezone: event.timezone,
      participantType: event.participantType.toLowerCase(),
      cloudProvider: event.cloudProvider.toLowerCase(),
      regions: event.regions,
      scoringType: event.scoringType.toLowerCase(),
      leaderboardVisible: event.leaderboardVisible,
      problemCount: problems.length,
      participantCount,
      isRegistered: false, // TODO: 実際の登録状況を確認
      problems,
      teamInfo: undefined, // TODO: チーム情報を取得
    });
  } catch (error) {
    console.error('Failed to fetch event:', error);
    return c.json({ error: 'Failed to fetch event' }, 500);
  }
});

/**
 * イベントに登録
 */
participantRouter.post('/events/:eventId/register', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { eventId } = c.req.param();

  try {
    const event = await eventRepository.findById(eventId);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    if (event.tenantId !== user.tenantId) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // status は lowercase に変換済み
    if (event.status !== 'scheduled' && event.status !== 'active') {
      return c.json({ error: 'Event is not open for registration' }, 400);
    }

    // TODO: 実際の登録処理（Participantテーブルに追加）

    return c.json({
      success: true,
      message: 'Successfully registered for the event',
    });
  } catch (error) {
    console.error('Failed to register for event:', error);
    return c.json({ error: 'Failed to register' }, 500);
  }
});

/**
 * イベント登録をキャンセル
 */
participantRouter.post('/events/:eventId/unregister', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { eventId } = c.req.param();

  try {
    const event = await eventRepository.findById(eventId);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // テナント分離チェック
    if (event.tenantId !== user.tenantId) {
      return c.json({ error: 'Event not found' }, 404);
    }

    // status は lowercase
    if (event.status === 'active') {
      return c.json({ error: 'Cannot unregister from an active event' }, 400);
    }

    // TODO: 実際の登録解除処理

    return c.json({
      success: true,
      message: 'Successfully unregistered from the event',
    });
  } catch (error) {
    console.error('Failed to unregister from event:', error);
    return c.json({ error: 'Failed to unregister' }, 500);
  }
});

/**
 * リーダーボードを取得
 */
participantRouter.get('/events/:eventId/leaderboard', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { eventId } = c.req.param();

  try {
    const event = await eventRepository.findById(eventId);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    if (!event.leaderboardVisible) {
      return c.json({ error: 'Leaderboard is not visible' }, 403);
    }

    // getLeaderboard は LeaderboardEntry[] を返す
    const entries = await getLeaderboard(eventId);

    // 自分のポジションをマーク
    const entriesWithMe = entries.map((entry) => ({
      ...entry,
      isMe: entry.teamId === user.teamId,
    }));

    const myPosition = entriesWithMe.findIndex((e) => e.isMe) + 1;

    return c.json({
      eventId,
      entries: entriesWithMe,
      isFrozen: false, // TODO: 実際の frozen 状態を取得
      updatedAt: new Date().toISOString(),
      myPosition: myPosition > 0 ? myPosition : undefined,
    });
  } catch (error) {
    console.error('Failed to fetch leaderboard:', error);
    return c.json({ error: 'Failed to fetch leaderboard' }, 500);
  }
});

/**
 * 自分のランキングを取得
 */
participantRouter.get('/events/:eventId/my-ranking', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { eventId } = c.req.param();

  try {
    const entries = await getLeaderboard(eventId);
    const myEntry = entries.find((e) => e.teamId === user.teamId);

    if (!myEntry) {
      return c.json({ error: 'Not found in leaderboard' }, 404);
    }

    return c.json({
      rank: myEntry.rank,
      totalScore: myEntry.score,
      completedChallenges: myEntry.completedChallenges,
    });
  } catch (error) {
    console.error('Failed to fetch ranking:', error);
    return c.json({ error: 'Failed to fetch ranking' }, 500);
  }
});

// ====================
// チャレンジ（問題）
// ====================

/**
 * チャレンジ詳細を取得
 */
participantRouter.get('/events/:eventId/challenges/:challengeId', async (c) => {
  const user = c.get('user') as AuthenticatedUser;
  const { eventId, challengeId } = c.req.param();

  try {
    const event = await getEventWithProblems(eventId);

    if (!event || event.tenantId !== user.tenantId) {
      return c.json({ error: 'Event not found' }, 404);
    }

    const eventProblem = event.problems.find(
      (ep) => ep.problemId === challengeId
    );
    if (!eventProblem) {
      return c.json({ error: 'Challenge not found' }, 404);
    }

    const problem = eventProblem.problem;

    // ロック状態チェック
    if (eventProblem.unlockTime && new Date() < eventProblem.unlockTime) {
      return c.json({ error: 'Challenge is locked' }, 403);
    }

    // イベントがアクティブかチェック（Prisma の enum は大文字）
    if (event.status !== 'ACTIVE') {
      return c.json({ error: 'Event is not active' }, 403);
    }

    // maxScore を criteria から計算
    const maxScore =
      problem.criteria?.reduce((sum, c) => sum + c.maxPoints, 0) || 0;

    return c.json({
      id: problem.id,
      title: problem.title,
      type: problem.type.toLowerCase(),
      category: problem.category.toLowerCase(),
      difficulty: problem.difficulty.toLowerCase(),
      overview: problem.overview,
      objectives: problem.objectives,
      order: eventProblem.order,
      pointMultiplier: eventProblem.pointMultiplier,
      maxScore,
      isUnlocked: true,
      isCompleted: false, // TODO: 実際の完了状態
      myScore: undefined, // TODO: 実際のスコア
      estimatedTimeMinutes: problem.estimatedTimeMinutes,
      description: problem.overview, // Prisma の Problem には description がないので overview を使用
      instructions: problem.objectives || [],
      hints: (problem.hints || []).map((hint, index) => ({
        id: `hint-${index}`,
        content: '', // 公開されていない場合は空
        costPoints: 10, // デフォルト値
        isRevealed: false, // TODO: 実際の公開状態
      })),
      resources: [], // TODO: 静的ファイルから取得
      scoringCriteria: (problem.criteria || []).map((sc) => ({
        name: sc.name,
        description: sc.description || '',
        maxPoints: sc.maxPoints,
        currentPoints: undefined, // TODO: 実際のスコア
        isPassed: undefined,
      })),
      awsAccountId: undefined, // TODO: 割り当てられたアカウントID
      awsConsoleUrl: undefined, // TODO: コンソールURL生成
    });
  } catch (error) {
    console.error('Failed to fetch challenge:', error);
    return c.json({ error: 'Failed to fetch challenge' }, 500);
  }
});

/**
 * JAMチャレンジ詳細を取得（クルー付き）
 */
participantRouter.get(
  '/events/:eventId/challenges/:challengeId/jam',
  async (c) => {
    const user = c.get('user') as AuthenticatedUser;
    const { eventId, challengeId } = c.req.param();

    try {
      const event = await getEventWithProblems(eventId);

      if (!event || event.tenantId !== user.tenantId) {
        return c.json({ error: 'Event not found' }, 404);
      }

      // Prisma の enum は大文字
      if (event.type !== 'JAM') {
        return c.json({ error: 'Not a JAM event' }, 400);
      }

      const eventProblem = event.problems.find(
        (ep) => ep.problemId === challengeId
      );
      if (!eventProblem) {
        return c.json({ error: 'Challenge not found' }, 404);
      }

      const problem = eventProblem.problem;
      const maxScore =
        problem.criteria?.reduce((sum, c) => sum + c.maxPoints, 0) || 0;

      return c.json({
        id: problem.id,
        title: problem.title,
        type: problem.type.toLowerCase(),
        category: problem.category.toLowerCase(),
        difficulty: problem.difficulty.toLowerCase(),
        overview: problem.overview,
        objectives: problem.objectives,
        order: eventProblem.order,
        pointMultiplier: eventProblem.pointMultiplier,
        maxScore,
        isUnlocked:
          !eventProblem.unlockTime || new Date() >= eventProblem.unlockTime,
        isCompleted: false, // TODO: 実際の完了状態
        myScore: undefined, // TODO: 実際のスコア
        description: problem.overview,
        instructions: problem.objectives || [],
        clues: [], // TODO: Challenge モデルから取得
        resources: [],
        scoringCriteria: problem.criteria || [],
        answerFormat: 'text',
        answerValidation: undefined,
      });
    } catch (error) {
      console.error('Failed to fetch JAM challenge:', error);
      return c.json({ error: 'Failed to fetch challenge' }, 500);
    }
  }
);

/**
 * AWS クレデンシャルを取得
 */
participantRouter.get(
  '/events/:eventId/challenges/:challengeId/credentials',
  async (c) => {
    const user = c.get('user') as AuthenticatedUser;
    const { eventId, challengeId } = c.req.param();

    try {
      // イベントとチャレンジの存在確認
      const event = await getEventWithProblems(eventId);
      if (!event || event.tenantId !== user.tenantId) {
        return c.json({ error: 'Event not found' }, 404);
      }

      const eventProblem = event.problems.find(
        (ep) => ep.problemId === challengeId
      );
      if (!eventProblem) {
        return c.json({ error: 'Challenge not found' }, 404);
      }

      // TODO: 実際のクレデンシャル発行処理
      // - 参加者に割り当てられたAWSアカウントからSTSでセッショントークンを取得
      // - CompetitorAccount テーブルから暗号化されたクレデンシャルを取得
      // - セキュリティ制約を適用

      // 現在は未実装のため 501 を返す
      return c.json(
        {
          error: 'Credential provisioning not yet implemented',
          message:
            'AWS credentials will be provided when the competition infrastructure is deployed',
        },
        501
      );
    } catch (error) {
      console.error('Failed to get credentials:', error);
      return c.json({ error: 'Failed to get credentials' }, 500);
    }
  }
);

/**
 * ヒントを公開
 */
participantRouter.post(
  '/events/:eventId/challenges/:challengeId/hints/:hintId/reveal',
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const {
      eventId: _eventId,
      challengeId: _challengeId,
      hintId,
    } = c.req.param();

    try {
      // TODO: 実際のヒント公開処理
      // - ポイント減点を記録
      // - ヒント公開状態を保存

      return c.json({
        id: hintId,
        content: 'ヒントの内容がここに表示されます',
        costPoints: 10,
        isRevealed: true,
      });
    } catch (error) {
      console.error('Failed to reveal hint:', error);
      return c.json({ error: 'Failed to reveal hint' }, 500);
    }
  }
);

/**
 * クルーを公開（JAM）
 */
participantRouter.post(
  '/events/:eventId/challenges/:challengeId/clues/:clueId/reveal',
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const {
      eventId: _eventId,
      challengeId: _challengeId,
      clueId,
    } = c.req.param();

    try {
      // TODO: 実際のクルー公開処理

      return c.json({
        id: clueId,
        order: 1,
        title: 'クルータイトル',
        content: 'クルーの内容がここに表示されます',
        costPoints: 50,
        isRevealed: true,
        revealedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to reveal clue:', error);
      return c.json({ error: 'Failed to reveal clue' }, 500);
    }
  }
);

/**
 * 採点をリクエスト（GameDay）
 */
participantRouter.post(
  '/events/:eventId/challenges/:challengeId/score',
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId, challengeId: _challengeId } = c.req.param();

    try {
      // TODO: 実際の採点リクエスト処理
      // - 採点キューに追加
      // - 提出IDを返す

      const submissionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      return c.json({
        submissionId,
        message: '採点リクエストを受け付けました。結果は数分後に反映されます。',
      });
    } catch (error) {
      console.error('Failed to request scoring:', error);
      return c.json({ error: 'Failed to request scoring' }, 500);
    }
  }
);

/**
 * 回答を提出（JAM）
 */
const submitAnswerSchema = z.object({
  answer: z.string().min(1),
  titleId: z.string().min(1), // タスク識別子（どのタスクへの回答か）
});

participantRouter.post(
  '/events/:eventId/challenges/:challengeId/submit',
  zValidator('json', submitAnswerSchema),
  async (c) => {
    const user = c.get('user') as AuthenticatedUser;
    const { eventId, challengeId } = c.req.param();
    const { answer, titleId } = c.req.valid('json');

    try {
      // イベントとチャレンジの存在確認
      const challenge = await prisma.challenge.findFirst({
        where: {
          id: challengeId,
          event: { id: eventId },
        },
        include: {
          event: true,
        },
      });

      if (!challenge) {
        return c.json({ error: 'Challenge not found' }, 404);
      }

      // テナント分離チェック
      if (challenge.event.tenantId !== user.tenantId) {
        return c.json({ error: 'Challenge not found' }, 404);
      }

      // 正解データを取得
      const correctAnswer = await prisma.answer.findUnique({
        where: {
          challengeId_titleId: { challengeId, titleId },
        },
      });

      if (!correctAnswer) {
        return c.json(
          { error: 'Answer configuration not found for this task' },
          404
        );
      }

      // 回答の検証（大文字小文字を無視、前後の空白を除去）
      const isCorrect =
        answer.toLowerCase().trim() ===
        correctAnswer.answerKey.toLowerCase().trim();

      // 提出IDを生成
      const submissionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // TODO: TeamChallengeAnswer に提出を記録
      // TODO: 使用したクルー数から減点計算

      return c.json({
        id: submissionId,
        problemId: challengeId,
        eventId,
        titleId,
        submittedAt: new Date().toISOString(),
        status: 'completed',
        score: isCorrect ? 100 : 0,
        maxScore: 100,
        answer,
        isCorrect,
        cluesUsed: 0, // TODO: 実際の使用クルー数
        clueDeduction: 0, // TODO: 実際の減点
      });
    } catch (error) {
      console.error('Failed to submit answer:', error);
      return c.json({ error: 'Failed to submit answer' }, 500);
    }
  }
);

/**
 * 提出履歴を取得
 */
participantRouter.get(
  '/events/:eventId/challenges/:challengeId/submissions',
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId, challengeId: _challengeId } = c.req.param();

    try {
      // TODO: 実際の提出履歴を取得

      return c.json({ submissions: [] });
    } catch (error) {
      console.error('Failed to fetch submissions:', error);
      return c.json({ error: 'Failed to fetch submissions' }, 500);
    }
  }
);

/**
 * 最新の提出結果を取得
 */
participantRouter.get(
  '/events/:eventId/challenges/:challengeId/submissions/latest',
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId, challengeId: _challengeId } = c.req.param();

    try {
      // TODO: 実際の最新提出を取得

      return c.json({ error: 'No submissions found' }, 404);
    } catch (error) {
      console.error('Failed to fetch latest submission:', error);
      return c.json({ error: 'Failed to fetch submission' }, 500);
    }
  }
);

// ====================
// チーム管理
// ====================

/**
 * 自分のチーム情報を取得
 */
participantRouter.get('/events/:eventId/team', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { eventId: _eventId } = c.req.param();

  try {
    // TODO: 実際のチーム情報を取得

    return c.json({ error: 'Team not found' }, 404);
  } catch (error) {
    console.error('Failed to fetch team:', error);
    return c.json({ error: 'Failed to fetch team' }, 500);
  }
});

/**
 * チームを作成
 */
const createTeamSchema = z.object({
  name: z.string().min(1).max(50),
});

participantRouter.post(
  '/events/:eventId/team',
  zValidator('json', createTeamSchema),
  async (c) => {
    const user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId } = c.req.param();
    const { name } = c.req.valid('json');

    try {
      // TODO: 実際のチーム作成処理

      const inviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();

      return c.json({
        id: `team_${Date.now()}`,
        name,
        members: [
          {
            id: user.id,
            name: user.username || 'Unknown',
            email: user.email || '',
            role: 'captain',
            joinedAt: new Date().toISOString(),
          },
        ],
        captainId: user.id,
        inviteCode,
      });
    } catch (error) {
      console.error('Failed to create team:', error);
      return c.json({ error: 'Failed to create team' }, 500);
    }
  }
);

/**
 * チームに参加
 */
const joinTeamSchema = z.object({
  inviteCode: z.string().min(1),
});

participantRouter.post(
  '/events/:eventId/team/join',
  zValidator('json', joinTeamSchema),
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId } = c.req.param();
    const { inviteCode: _inviteCode } = c.req.valid('json');

    try {
      // TODO: 実際のチーム参加処理

      return c.json({
        id: 'team_example',
        name: 'Example Team',
        members: [],
        captainId: 'captain_id',
      });
    } catch (error) {
      console.error('Failed to join team:', error);
      return c.json({ error: 'Failed to join team' }, 500);
    }
  }
);

/**
 * チームから離脱
 */
participantRouter.post('/events/:eventId/team/leave', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { eventId: _eventId } = c.req.param();

  try {
    // TODO: 実際の離脱処理

    return c.json({ success: true, message: 'Successfully left the team' });
  } catch (error) {
    console.error('Failed to leave team:', error);
    return c.json({ error: 'Failed to leave team' }, 500);
  }
});

/**
 * 招待コードを再生成
 */
participantRouter.post('/events/:eventId/team/invite-code', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { eventId: _eventId } = c.req.param();

  try {
    // TODO: キャプテン権限チェック + 実際の再生成処理

    const newInviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();

    return c.json({ inviteCode: newInviteCode });
  } catch (error) {
    console.error('Failed to regenerate invite code:', error);
    return c.json({ error: 'Failed to regenerate invite code' }, 500);
  }
});

/**
 * キャプテンを移譲
 */
const transferCaptainSchema = z.object({
  newCaptainId: z.string().min(1),
});

participantRouter.post(
  '/events/:eventId/team/transfer-captain',
  zValidator('json', transferCaptainSchema),
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId } = c.req.param();
    const { newCaptainId } = c.req.valid('json');

    try {
      // TODO: 実際の移譲処理

      return c.json({
        id: 'team_example',
        name: 'Example Team',
        members: [],
        captainId: newCaptainId,
      });
    } catch (error) {
      console.error('Failed to transfer captain:', error);
      return c.json({ error: 'Failed to transfer captain' }, 500);
    }
  }
);

/**
 * チームメンバー一覧を取得
 */
participantRouter.get('/events/:eventId/team/members', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { eventId: _eventId } = c.req.param();

  try {
    // TODO: 実際のメンバー一覧を取得

    return c.json({ members: [] });
  } catch (error) {
    console.error('Failed to fetch team members:', error);
    return c.json({ error: 'Failed to fetch members' }, 500);
  }
});

/**
 * チームメンバーを削除
 */
participantRouter.delete(
  '/events/:eventId/team/members/:memberId',
  async (c) => {
    const _user = c.get('user') as AuthenticatedUser;
    const { eventId: _eventId, memberId: _memberId } = c.req.param();

    try {
      // TODO: キャプテン権限チェック + 実際の削除処理

      return c.json({ success: true, message: 'Member removed from team' });
    } catch (error) {
      console.error('Failed to remove member:', error);
      return c.json({ error: 'Failed to remove member' }, 500);
    }
  }
);

/**
 * チームを解散
 */
participantRouter.delete('/events/:eventId/team', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { eventId: _eventId } = c.req.param();

  try {
    // TODO: キャプテン権限チェック + 実際の解散処理

    return c.json({ success: true, message: 'Team disbanded' });
  } catch (error) {
    console.error('Failed to disband team:', error);
    return c.json({ error: 'Failed to disband team' }, 500);
  }
});

// ====================
// プロフィール
// ====================

/**
 * 自分のプロフィールを取得
 */
participantRouter.get('/profile', async (c) => {
  const user = c.get('user') as AuthenticatedUser;

  try {
    // TODO: 実際のプロフィール情報を取得

    return c.json({
      id: user.id,
      name: user.username || 'Unknown',
      email: user.email || '',
      avatarUrl: undefined,
      totalEventsParticipated: 0,
      totalScore: 0,
      rank: undefined,
      badges: [],
      recentEvents: [],
    });
  } catch (error) {
    console.error('Failed to fetch profile:', error);
    return c.json({ error: 'Failed to fetch profile' }, 500);
  }
});

/**
 * プロフィールを更新
 */
const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().optional(),
});

participantRouter.put(
  '/profile',
  zValidator('json', updateProfileSchema),
  async (c) => {
    const user = c.get('user') as AuthenticatedUser;
    const data = c.req.valid('json');

    try {
      // TODO: 実際の更新処理

      return c.json({
        id: user.id,
        name: data.name || user.username || 'Unknown',
        email: user.email || '',
        avatarUrl: data.avatarUrl,
        totalEventsParticipated: 0,
        totalScore: 0,
        rank: undefined,
        badges: [],
        recentEvents: [],
      });
    } catch (error) {
      console.error('Failed to update profile:', error);
      return c.json({ error: 'Failed to update profile' }, 500);
    }
  }
);

/**
 * バッジ一覧を取得
 */
participantRouter.get('/profile/badges', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;

  try {
    // TODO: 実際のバッジ一覧を取得

    return c.json({ badges: [] });
  } catch (error) {
    console.error('Failed to fetch badges:', error);
    return c.json({ error: 'Failed to fetch badges' }, 500);
  }
});

/**
 * 参加イベント履歴を取得
 */
participantRouter.get('/profile/history', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { limit: _limit = '20', offset: _offset = '0' } = c.req.query();

  try {
    // TODO: 実際の履歴を取得

    return c.json({
      events: [],
      total: 0,
    });
  } catch (error) {
    console.error('Failed to fetch history:', error);
    return c.json({ error: 'Failed to fetch history' }, 500);
  }
});

/**
 * グローバルランキングを取得
 */
participantRouter.get('/rankings', async (c) => {
  const _user = c.get('user') as AuthenticatedUser;
  const { limit: _limit = '50', offset: _offset = '0' } = c.req.query();

  try {
    // TODO: 実際のランキングを取得

    return c.json({
      rankings: [],
      total: 0,
      myRank: undefined,
    });
  } catch (error) {
    console.error('Failed to fetch rankings:', error);
    return c.json({ error: 'Failed to fetch rankings' }, 500);
  }
});

export { participantRouter };
