import { Hono } from 'hono';
import {
  purchaseAttackSchema,
  executeAttackSchema,
  purchaseHintSchema,
  reportFixSchema,
  requestAllianceSchema,
  voteSchema,
} from '../schemas';

export const participantRoutes = new Hono();

// === 攻撃 ===

// 攻撃カタログ
participantRoutes.get('/attacks/catalog', async (c) => {
  // TODO: 攻撃カタログ取得ロジック実装
  return c.json({ attacks: [] }, 200);
});

// 攻撃購入
participantRoutes.post('/attacks/purchase', async (c) => {
  const body = await c.req.json();
  const parsed = purchaseAttackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: 攻撃購入ロジック実装
  return c.json({ message: '攻撃を購入しました' }, 200);
});

// 攻撃実行
participantRoutes.post('/attacks/execute', async (c) => {
  const body = await c.req.json();
  const parsed = executeAttackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: 攻撃実行ロジック実装
  return c.json({ message: '攻撃を実行しました', success: false }, 200);
});

// 攻撃履歴
participantRoutes.get('/attacks/history', async (c) => {
  // TODO: 攻撃履歴取得ロジック実装
  return c.json({ history: [] }, 200);
});

// === 防御 ===

// 受けている攻撃一覧
participantRoutes.get('/defense/active', async (c) => {
  // TODO: 受攻撃一覧取得ロジック実装
  return c.json({ attacks: [] }, 200);
});

// ヒント購入
participantRoutes.post('/defense/hint', async (c) => {
  const body = await c.req.json();
  const parsed = purchaseHintSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: ヒント購入ロジック実装
  return c.json({ hint: '' }, 200);
});

// 脆弱性修正報告
participantRoutes.post('/defense/report-fix', async (c) => {
  const body = await c.req.json();
  const parsed = reportFixSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: 脆弱性修正報告ロジック実装
  return c.json({ message: '修正を報告しました', verified: false }, 200);
});

// === 同盟 ===

// 同盟一覧
participantRoutes.get('/alliances', async (c) => {
  // TODO: 同盟一覧取得ロジック実装
  return c.json({ alliances: [] }, 200);
});

// 同盟申請
participantRoutes.post('/alliances/request', async (c) => {
  const body = await c.req.json();
  const parsed = requestAllianceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: 同盟申請ロジック実装
  return c.json({ message: '同盟を申請しました' }, 200);
});

// 同盟承認
participantRoutes.post('/alliances/:id/accept', async (c) => {
  const { id } = c.req.param();
  // TODO: 同盟承認ロジック実装
  return c.json({ message: '同盟を承認しました', allianceId: id }, 200);
});

// 同盟破棄
participantRoutes.post('/alliances/:id/break', async (c) => {
  const { id } = c.req.param();
  // TODO: 同盟破棄ロジック実装
  return c.json({ message: '同盟を破棄しました', allianceId: id }, 200);
});

// === モニタリング ===

// ヘルスチェック状態
participantRoutes.get('/monitoring/status', async (c) => {
  // TODO: ヘルスチェック状態取得ロジック実装
  return c.json({ checks: [] }, 200);
});

// === 投票 ===

// 投票
participantRoutes.post('/voting/vote', async (c) => {
  const body = await c.req.json();
  const parsed = voteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: 投票ロジック実装
  return c.json({ message: '投票しました' }, 200);
});

// 投票結果
participantRoutes.get('/voting/results', async (c) => {
  // TODO: 投票結果取得ロジック実装
  return c.json({ results: [] }, 200);
});
