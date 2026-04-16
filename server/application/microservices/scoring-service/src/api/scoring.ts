import { Hono } from 'hono';
import { z } from 'zod';
import { EvaluationCategory } from '@tenkacloud/dynamodb';
import * as scoringService from '../services/scoring';

export const scoringRoutes = new Hono();

// ========== バリデーションスキーマ ==========

const evaluationCategoryValues = [
  EvaluationCategory.INFRASTRUCTURE,
  EvaluationCategory.COST,
  EvaluationCategory.SECURITY,
  EvaluationCategory.PERFORMANCE,
  EvaluationCategory.RELIABILITY,
] as const;

const createCriteriaSchema = z.object({
  name: z.string().min(1, '名前は必須です'),
  description: z.string().optional(),
  category: z.enum(evaluationCategoryValues),
  weight: z.number().int().min(1).max(10).optional(),
  maxScore: z.number().int().min(1).optional(),
});

const updateCriteriaSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.enum(evaluationCategoryValues).optional(),
  weight: z.number().int().min(1).max(10).optional(),
  maxScore: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
});

const createSessionSchema = z.object({
  participantId: z.string().min(1, '参加者IDは必須です'),
  battleId: z.string().optional(),
});

const submitSchema = z.object({
  terraformState: z.object({
    version: z.number(),
    resources: z.array(z.any()).optional(),
  }),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

// ========== 評価基準 API ==========

// POST /criteria - 評価基準作成
scoringRoutes.post('/criteria', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();

  const parsed = createCriteriaSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }

  const criteria = await scoringService.createEvaluationCriteria({
    tenantId: auth.tenantId,
    ...parsed.data,
  });

  return c.json(criteria, 201);
});

// GET /criteria - 評価基準一覧取得
scoringRoutes.get('/criteria', async (c) => {
  const auth = c.get('auth');
  const query = c.req.query();

  const pagination = paginationSchema.parse(query);
  const category = query.category as EvaluationCategory | undefined;

  const result = await scoringService.listEvaluationCriteria(auth.tenantId, {
    ...pagination,
    category,
  });

  return c.json(result);
});

// GET /criteria/:id - 評価基準取得
scoringRoutes.get('/criteria/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const criteria = await scoringService.getEvaluationCriteria(
    id,
    auth.tenantId
  );

  if (!criteria) {
    return c.json({ error: '評価基準が見つかりません' }, 404);
  }

  return c.json(criteria);
});

// PUT /criteria/:id - 評価基準更新
scoringRoutes.put('/criteria/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const body = await c.req.json();

  const parsed = updateCriteriaSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }

  const criteria = await scoringService.updateEvaluationCriteria(
    id,
    auth.tenantId,
    parsed.data
  );

  if (!criteria) {
    return c.json({ error: '評価基準が見つかりません' }, 404);
  }

  return c.json(criteria);
});

// DELETE /criteria/:id - 評価基準削除
scoringRoutes.delete('/criteria/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  await scoringService.deleteEvaluationCriteria(id, auth.tenantId);

  return c.body(null, 204);
});

// ========== 採点セッション API ==========

// POST /sessions - セッション作成
scoringRoutes.post('/sessions', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }

  const session = await scoringService.createScoringSession({
    tenantId: auth.tenantId,
    ...parsed.data,
  });

  return c.json(session, 201);
});

// GET /sessions - セッション一覧取得
scoringRoutes.get('/sessions', async (c) => {
  const auth = c.get('auth');
  const query = c.req.query();

  const pagination = paginationSchema.parse(query);

  const result = await scoringService.listScoringSessions(auth.tenantId, {
    ...pagination,
    battleId: query.battleId,
    participantId: query.participantId,
  });

  return c.json(result);
});

// GET /sessions/:id - セッション取得
scoringRoutes.get('/sessions/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const session = await scoringService.getScoringSession(id, auth.tenantId);

  if (!session) {
    return c.json({ error: 'セッションが見つかりません' }, 404);
  }

  return c.json(session);
});

// POST /sessions/:id/submit - Terraform State 提出
scoringRoutes.post('/sessions/:id/submit', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const body = await c.req.json();

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }

  try {
    const session = await scoringService.submitForEvaluation(
      id,
      auth.tenantId,
      parsed.data.terraformState
    );

    if (!session) {
      return c.json({ error: 'セッションが見つかりません' }, 404);
    }

    return c.json(session);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// POST /sessions/:id/evaluate - 採点実行
scoringRoutes.post('/sessions/:id/evaluate', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  try {
    const session = await scoringService.evaluateSubmission(id, auth.tenantId);

    if (!session) {
      return c.json({ error: 'セッションが見つかりません' }, 404);
    }

    return c.json(session);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// GET /sessions/:id/feedback - フィードバック取得
scoringRoutes.get('/sessions/:id/feedback', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const feedbacks = await scoringService.getSessionFeedback(id, auth.tenantId);

  if (feedbacks === null) {
    return c.json({ error: 'セッションが見つかりません' }, 404);
  }

  return c.json(feedbacks);
});
