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
  PrismaProblemTemplateRepository,
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
import type { ProblemCategory, DifficultyLevel, CloudProvider } from '../types';

const adminRouter = new Hono();

// リポジトリインスタンス
const eventRepository = new PrismaEventRepository();
const problemRepository = new PrismaProblemRepository();
const marketplaceRepository = new PrismaMarketplaceRepository();
const templateRepository = new PrismaProblemTemplateRepository();

// ====================
// AI 問題生成ヘルパー
// ====================

interface AiGenerationInput {
  topic: string;
  type: 'gameday' | 'jam';
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  cloudProvider: CloudProvider;
  targetServices?: string[];
  additionalContext?: string;
  language: 'ja' | 'en';
}

interface AiGeneratedProblem {
  title: string;
  description: {
    overview: string;
    objectives: string[];
    hints: string[];
    prerequisites: string[];
    estimatedTime?: number;
  };
  scoring?: {
    criteria: {
      name: string;
      description?: string;
      weight: number;
      maxPoints: number;
    }[];
  };
  suggestedResources?: string[];
}

async function callAnthropicApi(
  input: AiGenerationInput
): Promise<
  | { success: true; data: AiGeneratedProblem }
  | { success: false; error: string }
> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    return {
      success: false,
      error: 'AI generation not configured: ANTHROPIC_API_KEY is missing',
    };
  }

  const systemPrompt = `あなたはクラウド技術の競技問題を作成する専門家です。
TenkaCloud プラットフォーム用の問題を生成してください。

出力は以下の JSON 形式で返してください：
{
  "title": "問題タイトル",
  "description": {
    "overview": "問題の概要（シナリオ背景を含む）",
    "objectives": ["目標1", "目標2", ...],
    "hints": ["ヒント1", "ヒント2", ...],
    "prerequisites": ["前提知識1", "前提知識2", ...],
    "estimatedTime": 60
  },
  "scoring": {
    "criteria": [
      {"name": "criterion_1", "description": "評価基準の説明", "weight": 0.5, "maxPoints": 50},
      ...
    ]
  },
  "suggestedResources": ["参考リソースURL1", ...]
}

注意事項:
- 問題は実践的で、実際のクラウド運用シナリオに基づくこと
- 難易度に応じた適切な複雑さにすること
- セキュリティベストプラクティスを考慮すること`;

  const userPrompt = `以下の条件で問題を生成してください：

トピック: ${input.topic}
タイプ: ${input.type === 'gameday' ? 'GameDay（トラブルシューティング）' : 'Jam（構築課題）'}
カテゴリ: ${input.category}
難易度: ${input.difficulty}
クラウドプロバイダー: ${input.cloudProvider.toUpperCase()}
${input.targetServices ? `使用サービス: ${input.targetServices.join(', ')}` : ''}
${input.additionalContext ? `追加コンテキスト: ${input.additionalContext}` : ''}
言語: ${input.language === 'ja' ? '日本語' : '英語'}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', errorText);
      return { success: false, error: 'AI generation failed' };
    }

    const result = (await response.json()) as {
      content?: { type: string; text: string }[];
    };
    const content = result.content?.[0]?.text;

    if (!content) {
      return { success: false, error: 'AI returned empty response' };
    }

    // JSON を抽出（マークダウンコードブロック対応）
    let jsonContent = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonContent = jsonMatch[1].trim();
    }

    const generatedProblem = JSON.parse(jsonContent) as AiGeneratedProblem;
    return { success: true, data: generatedProblem };
  } catch (error) {
    console.error('Failed to generate problem with AI:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'AI generation request timed out' };
    }
    if (error instanceof SyntaxError) {
      return { success: false, error: 'AI returned invalid JSON format' };
    }
    return { success: false, error: 'Failed to generate problem with AI' };
  }
}

function getAiErrorStatusCode(error: string): 500 | 503 | 504 {
  if (error.includes('not configured')) return 503;
  if (error.includes('timed out')) return 504;
  return 500;
}

interface BuildProblemOptions {
  includeSuggestedResources?: boolean;
  includeTimestamps?: boolean;
  includeAiGeneratedTag?: boolean;
}

function buildProblemFromAiResult(
  input: AiGenerationInput,
  generated: AiGeneratedProblem,
  options: BuildProblemOptions = {}
): Record<string, unknown> {
  const {
    includeSuggestedResources = false,
    includeTimestamps = false,
    includeAiGeneratedTag = false,
  } = options;

  const tags = [input.topic, input.cloudProvider, input.category];
  if (includeAiGeneratedTag) {
    tags.push('ai-generated');
  }

  const metadata: Record<string, unknown> = {
    author: 'AI Generated',
    version: '1.0.0',
    tags,
  };

  if (includeTimestamps) {
    const now = new Date().toISOString();
    metadata.createdAt = now;
    metadata.updatedAt = now;
  }

  const problem: Record<string, unknown> = {
    title: generated.title,
    type: input.type,
    category: input.category,
    difficulty: input.difficulty,
    description: generated.description,
    metadata,
    deployment: {
      providers: [input.cloudProvider],
      timeout: 60,
      templates: {},
      regions: {},
    },
    scoring: {
      type: 'manual' as const,
      path: '',
      timeoutMinutes: 5,
      criteria: generated.scoring?.criteria || [],
    },
  };

  if (includeSuggestedResources) {
    problem.suggestedResources = generated.suggestedResources || [];
  }

  return problem;
}

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
  return next();
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
    const result = await getEventWithProblems(eventId);
    if (!result) {
      return c.json({ error: 'Event not found' }, 404);
    }

    const { event: eventData, problems } = result;

    // レスポンス形式に変換
    const event = {
      id: eventData.id,
      externalId: eventData.externalId,
      name: eventData.name,
      type: eventData.type.toLowerCase(),
      status: eventData.status.toLowerCase(),
      tenantId: eventData.tenantId,
      startTime: eventData.startTime.toISOString(),
      endTime: eventData.endTime.toISOString(),
      timezone: eventData.timezone,
      participantType: eventData.participantType.toLowerCase(),
      maxParticipants: eventData.maxParticipants,
      minTeamSize: eventData.minTeamSize,
      maxTeamSize: eventData.maxTeamSize,
      cloudProvider: eventData.cloudProvider.toLowerCase(),
      regions: eventData.regions,
      scoringType: eventData.scoringType.toLowerCase(),
      scoringIntervalMinutes: eventData.scoringIntervalMinutes,
      leaderboardVisible: eventData.leaderboardVisible,
      freezeLeaderboardMinutes: eventData.freezeLeaderboardMinutes,
      problemCount: problems.length,
      problems: problems.map((ep) => ({
        problemId: ep.problemId,
        problemTitle:
          (ep as { problem?: { title: string } }).problem?.title || 'Unknown',
        order: ep.order,
        unlockTime: ep.unlockTime?.toISOString(),
        pointMultiplier: ep.pointMultiplier,
      })),
      createdAt: eventData.createdAt.toISOString(),
      updatedAt: eventData.updatedAt.toISOString(),
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

// 問題スキーマ
const createProblemSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['gameday', 'jam']),
  category: z.enum([
    'architecture',
    'security',
    'cost',
    'performance',
    'reliability',
    'operations',
  ]),
  difficulty: z.enum(['easy', 'medium', 'hard', 'expert']),
  description: z.object({
    overview: z.string(),
    objectives: z.array(z.string()).default([]),
    hints: z.array(z.string()).default([]),
    prerequisites: z.array(z.string()).default([]),
    estimatedTime: z.number().optional(),
  }),
  metadata: z.object({
    author: z.string(),
    version: z.string().default('1.0.0'),
    tags: z.array(z.string()).default([]),
    license: z.string().optional(),
  }),
  deployment: z.object({
    providers: z.array(z.enum(['aws', 'gcp', 'azure', 'local'])).min(1),
    timeout: z.number().optional(),
    templates: z
      .record(
        z.object({
          type: z.enum([
            'cloudformation',
            'sam',
            'cdk',
            'terraform',
            'deployment-manager',
            'arm',
            'docker-compose',
          ]),
          path: z.string(),
          parameters: z.record(z.string()).optional(),
        })
      )
      .optional(),
    regions: z.record(z.array(z.string())).optional(),
  }),
  scoring: z.object({
    type: z.enum(['lambda', 'container', 'api', 'manual']),
    path: z.string(),
    timeoutMinutes: z.number().default(5),
    intervalMinutes: z.number().optional(),
    criteria: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          weight: z.number(),
          maxPoints: z.number(),
        })
      )
      .default([]),
  }),
});

const updateProblemSchema = createProblemSchema.partial();

// 問題作成
adminRouter.post(
  '/problems',
  zValidator('json', createProblemSchema),
  async (c) => {
    const data = c.req.valid('json');

    try {
      const problem = await problemRepository.create({
        id: crypto.randomUUID(),
        title: data.title,
        type: data.type,
        category: data.category,
        difficulty: data.difficulty,
        description: data.description,
        metadata: {
          author: data.metadata.author,
          version: data.metadata.version,
          tags: data.metadata.tags,
          license: data.metadata.license,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        deployment: {
          providers: data.deployment.providers,
          timeout: data.deployment.timeout,
          templates: data.deployment.templates || {},
          regions: data.deployment.regions || {},
        },
        scoring: data.scoring,
      });
      return c.json(problem, 201);
    } catch (error) {
      console.error('Failed to create problem:', error);
      return c.json({ error: 'Failed to create problem' }, 500);
    }
  }
);

// 問題更新
adminRouter.put(
  '/problems/:problemId',
  zValidator('json', updateProblemSchema),
  async (c) => {
    const problemId = c.req.param('problemId');
    const data = c.req.valid('json');

    try {
      const existing = await problemRepository.findById(problemId);
      if (!existing) {
        return c.json({ error: 'Problem not found' }, 404);
      }

      // Partial<Problem> に変換
      const updates: Partial<{
        title: string;
        type: 'gameday' | 'jam';
        category:
          | 'architecture'
          | 'security'
          | 'cost'
          | 'performance'
          | 'reliability'
          | 'operations';
        difficulty: 'easy' | 'medium' | 'hard' | 'expert';
        description: {
          overview: string;
          objectives: string[];
          hints: string[];
          prerequisites: string[];
          estimatedTime?: number;
        };
        metadata: {
          author: string;
          version: string;
          tags: string[];
          license?: string;
          createdAt: string;
          updatedAt: string;
        };
        deployment: {
          providers: ('aws' | 'gcp' | 'azure' | 'local')[];
          timeout?: number;
          templates: Record<string, unknown>;
          regions: Record<string, unknown>;
        };
        scoring: {
          type: 'lambda' | 'container' | 'api' | 'manual';
          path: string;
          timeoutMinutes: number;
          intervalMinutes?: number;
          criteria: {
            name: string;
            description?: string;
            weight: number;
            maxPoints: number;
          }[];
        };
      }> = {};

      if (data.title) updates.title = data.title;
      if (data.type) updates.type = data.type;
      if (data.category) updates.category = data.category;
      if (data.difficulty) updates.difficulty = data.difficulty;
      if (data.description) updates.description = data.description;
      if (data.metadata) {
        updates.metadata = {
          ...data.metadata,
          createdAt: existing.metadata.createdAt,
          updatedAt: new Date().toISOString(),
        };
      }
      if (data.deployment) {
        updates.deployment = {
          ...data.deployment,
          templates: data.deployment.templates || {},
          regions: data.deployment.regions || {},
        };
      }
      if (data.scoring) updates.scoring = data.scoring;

      const problem = await problemRepository.update(problemId, updates);
      return c.json(problem);
    } catch (error) {
      console.error('Failed to update problem:', error);
      return c.json({ error: 'Failed to update problem' }, 500);
    }
  }
);

// 問題削除
adminRouter.delete('/problems/:problemId', async (c) => {
  const problemId = c.req.param('problemId');

  try {
    const exists = await problemRepository.exists(problemId);
    if (!exists) {
      return c.json({ error: 'Problem not found' }, 404);
    }

    await problemRepository.delete(problemId);
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete problem:', error);
    return c.json({ error: 'Failed to delete problem' }, 500);
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

// ====================
// 問題テンプレート管理
// ====================

// テンプレート変数スキーマ
const templateVariableSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'select']),
  description: z.string(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
});

// テンプレート作成スキーマ
const createTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  type: z.enum(['gameday', 'jam']),
  category: z.enum([
    'architecture',
    'security',
    'cost',
    'performance',
    'reliability',
    'operations',
  ]),
  difficulty: z.enum(['easy', 'medium', 'hard', 'expert']),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  variables: z.array(templateVariableSchema).default([]),
  descriptionTemplate: z.object({
    overviewTemplate: z.string(),
    objectivesTemplate: z.array(z.string()),
    hintsTemplate: z.array(z.string()),
    prerequisites: z.array(z.string()).optional(),
    estimatedTime: z.number().optional(),
  }),
  deployment: z.object({
    providers: z.array(z.enum(['aws', 'gcp', 'azure', 'local'])).min(1),
    templateType: z.enum([
      'cloudformation',
      'sam',
      'cdk',
      'terraform',
      'deployment-manager',
      'arm',
      'docker-compose',
    ]),
    templateContent: z.string(),
    regions: z
      .record(z.enum(['aws', 'gcp', 'azure', 'local']), z.array(z.string()))
      .optional(),
    timeout: z.number().optional(),
  }),
  scoring: z.object({
    type: z.enum(['lambda', 'container', 'api', 'manual']),
    criteriaTemplate: z.array(
      z.object({
        weight: z.number(),
        maxPoints: z.number(),
        description: z.string().optional(),
        validationType: z.string().optional(),
        validationConfig: z.record(z.unknown()).optional(),
      })
    ),
    timeoutMinutes: z.number(),
  }),
  tags: z.array(z.string()).default([]),
  author: z.string(),
  version: z.string().default('1.0.0'),
});

const updateTemplateSchema = createTemplateSchema.partial();

// テンプレート一覧取得
adminRouter.get('/templates', async (c) => {
  const type = c.req.query('type');
  const category = c.req.query('category');
  const difficulty = c.req.query('difficulty');
  const status = c.req.query('status');
  const provider = c.req.query('provider');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    const templates = await templateRepository.findAll({
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
      status: status as 'draft' | 'published' | 'archived' | undefined,
      provider: provider as 'aws' | 'gcp' | 'azure' | 'local' | undefined,
      limit,
      offset,
    });

    const total = await templateRepository.count({
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
      status: status as 'draft' | 'published' | 'archived' | undefined,
      provider: provider as 'aws' | 'gcp' | 'azure' | 'local' | undefined,
    });

    return c.json({ templates, total });
  } catch (error) {
    console.error('Failed to get templates:', error);
    return c.json({ error: 'Failed to get templates' }, 500);
  }
});

// テンプレート検索
adminRouter.get('/templates/search', async (c) => {
  const query = c.req.query('query');
  const type = c.req.query('type');
  const category = c.req.query('category');
  const difficulty = c.req.query('difficulty');
  const status = c.req.query('status');
  const provider = c.req.query('provider');
  const tags = c.req.query('tags')?.split(',').filter(Boolean);
  const sortBy = c.req.query('sortBy') || 'updated';
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');

  try {
    const result = await templateRepository.search({
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
      status: status as 'draft' | 'published' | 'archived' | undefined,
      provider: provider as 'aws' | 'gcp' | 'azure' | 'local' | undefined,
      tags,
      sortBy: sortBy as 'name' | 'usageCount' | 'newest' | 'updated',
      page,
      limit,
    });

    return c.json(result);
  } catch (error) {
    console.error('Failed to search templates:', error);
    return c.json({ error: 'Failed to search templates' }, 500);
  }
});

// テンプレート詳細取得
adminRouter.get('/templates/:templateId', async (c) => {
  const templateId = c.req.param('templateId');

  try {
    const template = await templateRepository.findById(templateId);
    if (!template) {
      return c.json({ error: 'Template not found' }, 404);
    }
    return c.json(template);
  } catch (error) {
    console.error('Failed to get template:', error);
    return c.json({ error: 'Failed to get template' }, 500);
  }
});

// テンプレート作成
adminRouter.post(
  '/templates',
  zValidator('json', createTemplateSchema),
  async (c) => {
    const data = c.req.valid('json');

    try {
      const template = await templateRepository.create({
        ...data,
        usageCount: 0,
      });
      return c.json(template, 201);
    } catch (error) {
      console.error('Failed to create template:', error);
      return c.json({ error: 'Failed to create template' }, 500);
    }
  }
);

// テンプレート更新
adminRouter.put(
  '/templates/:templateId',
  zValidator('json', updateTemplateSchema),
  async (c) => {
    const templateId = c.req.param('templateId');
    const data = c.req.valid('json');

    try {
      const exists = await templateRepository.exists(templateId);
      if (!exists) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const template = await templateRepository.update(templateId, data);
      return c.json(template);
    } catch (error) {
      console.error('Failed to update template:', error);
      return c.json({ error: 'Failed to update template' }, 500);
    }
  }
);

// テンプレート削除
adminRouter.delete('/templates/:templateId', async (c) => {
  const templateId = c.req.param('templateId');

  try {
    const exists = await templateRepository.exists(templateId);
    if (!exists) {
      return c.json({ error: 'Template not found' }, 404);
    }

    await templateRepository.delete(templateId);
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete template:', error);
    return c.json({ error: 'Failed to delete template' }, 500);
  }
});

// テンプレートから問題を生成
const createProblemFromTemplateSchema = z.object({
  title: z.string().min(1),
  variables: z.record(z.union([z.string(), z.number(), z.boolean()])),
  overrides: z
    .object({
      category: z
        .enum([
          'architecture',
          'security',
          'cost',
          'performance',
          'reliability',
          'operations',
        ])
        .optional(),
      difficulty: z.enum(['easy', 'medium', 'hard', 'expert']).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

adminRouter.post(
  '/templates/:templateId/create-problem',
  zValidator('json', createProblemFromTemplateSchema),
  async (c) => {
    const templateId = c.req.param('templateId');
    const data = c.req.valid('json');

    try {
      const template = await templateRepository.findById(templateId);
      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      // 必須変数のバリデーション
      const missingVariables = template.variables
        .filter((v) => v.required && !(v.name in data.variables))
        .map((v) => v.name);

      if (missingVariables.length > 0) {
        return c.json(
          {
            error: `Missing required variables: ${missingVariables.join(', ')}`,
          },
          400
        );
      }

      // 変数を置換する関数
      const replaceVariables = (text: string): string => {
        let result = text;
        for (const [key, value] of Object.entries(data.variables)) {
          result = result.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            String(value)
          );
        }
        return result;
      };

      // テンプレートから問題を生成
      const problemData = {
        id: crypto.randomUUID(),
        title: data.title,
        type: template.type,
        category: data.overrides?.category || template.category,
        difficulty: data.overrides?.difficulty || template.difficulty,
        metadata: {
          author: template.author,
          version: template.version,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: data.overrides?.tags || template.tags,
        },
        description: {
          overview: replaceVariables(
            template.descriptionTemplate.overviewTemplate
          ),
          objectives:
            template.descriptionTemplate.objectivesTemplate.map(
              replaceVariables
            ),
          hints:
            template.descriptionTemplate.hintsTemplate.map(replaceVariables),
          prerequisites: template.descriptionTemplate.prerequisites,
          estimatedTime: template.descriptionTemplate.estimatedTime,
        },
        deployment: {
          providers: template.deployment.providers,
          templates: Object.fromEntries(
            template.deployment.providers.map((provider) => [
              provider,
              {
                type: template.deployment.templateType,
                path: '',
                parameters: data.variables as Record<string, string>,
              },
            ])
          ),
          regions: template.deployment.regions || {},
          timeout: template.deployment.timeout,
        },
        scoring: {
          type: template.scoring.type,
          path: '',
          criteria: template.scoring.criteriaTemplate.map(
            (criterion, index) => ({
              name: `criterion_${index + 1}`,
              ...criterion,
            })
          ),
          timeoutMinutes: template.scoring.timeoutMinutes,
        },
      };

      // 問題を作成
      const problem = await problemRepository.create(problemData);

      // テンプレートの使用回数をインクリメント
      await templateRepository.incrementUsageCount(templateId);

      return c.json(problem, 201);
    } catch (error) {
      console.error('Failed to create problem from template:', error);
      return c.json({ error: 'Failed to create problem from template' }, 500);
    }
  }
);

// ====================
// AI 問題生成
// ====================

// AI 問題生成リクエストスキーマ
const aiGenerateProblemSchema = z.object({
  topic: z.string().min(1).max(200).describe('生成する問題のトピック'),
  type: z.enum(['gameday', 'jam']),
  category: z.enum([
    'architecture',
    'security',
    'cost',
    'performance',
    'reliability',
    'operations',
  ]),
  difficulty: z.enum(['easy', 'medium', 'hard', 'expert']),
  cloudProvider: z.enum(['aws', 'gcp', 'azure', 'local']),
  targetServices: z
    .array(z.string().max(100))
    .max(20)
    .optional()
    .describe('使用するクラウドサービス'),
  additionalContext: z
    .string()
    .max(4000)
    .optional()
    .describe('追加のコンテキスト'),
  language: z.enum(['ja', 'en']).default('ja'),
});

// AI 問題生成（プレビュー）
adminRouter.post(
  '/ai/generate/preview',
  zValidator('json', aiGenerateProblemSchema),
  async (c) => {
    const input = c.req.valid('json');
    const result = await callAnthropicApi(input);

    if (!result.success) {
      return c.json(
        { error: result.error },
        getAiErrorStatusCode(result.error)
      );
    }

    const preview = buildProblemFromAiResult(input, result.data, {
      includeSuggestedResources: true,
    });
    return c.json({
      preview,
      rawResponse: result.data,
      inputParameters: input,
    });
  }
);

// AI 問題生成（作成）
adminRouter.post(
  '/ai/generate',
  zValidator('json', aiGenerateProblemSchema),
  async (c) => {
    const input = c.req.valid('json');
    const result = await callAnthropicApi(input);

    if (!result.success) {
      return c.json(
        { error: result.error },
        getAiErrorStatusCode(result.error)
      );
    }

    const problemData = buildProblemFromAiResult(input, result.data, {
      includeTimestamps: true,
      includeAiGeneratedTag: true,
    });

    try {
      const problem = await problemRepository.create({
        id: crypto.randomUUID(),
        ...(problemData as Omit<
          Parameters<typeof problemRepository.create>[0],
          'id'
        >),
      });

      return c.json(problem, 201);
    } catch (error) {
      console.error('Failed to save AI-generated problem:', error);
      return c.json(
        { error: 'Failed to save generated problem to database' },
        500
      );
    }
  }
);

export { adminRouter };
