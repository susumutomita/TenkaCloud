import { describe, it, expect } from 'vitest';
import { adminRoutes } from './admin';

describe('管理者 API', () => {
  describe('POST /game/start', () => {
    it('有効なリクエストで 501 を返すべき', async () => {
      const res = await adminRoutes.request('/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1', durationMinutes: 240 }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toBe('未実装です');
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('POST /game/stop', () => {
    it('有効なリクエストで 501 を返すべき', async () => {
      const res = await adminRoutes.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toBe('未実装です');
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/game/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('GET /game/status', () => {
    it('eventId 付きでゲーム状態を返すべき', async () => {
      const res = await adminRoutes.request('/game/status?eventId=event-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.eventId).toBe('event-1');
      expect(body.scoreWeight).toBe('normal');
    });

    it('eventId がない場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/game/status');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /score-weight/toggle', () => {
    it('有効なリクエストで 501 を返すべき', async () => {
      const res = await adminRoutes.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toBe('未実装です');
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/score-weight/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('POST /blackout/toggle', () => {
    it('有効なリクエストで 501 を返すべき', async () => {
      const res = await adminRoutes.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toBe('未実装です');
    });

    it('eventId が空の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/blackout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('POST /fault-injection/execute', () => {
    it('有効なリクエストで 501 を返すべき', async () => {
      const res = await adminRoutes.request('/fault-injection/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: 'event-1',
          teamId: 'team-1',
          attackSlug: 'sql-injection',
        }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toBe('未実装です');
    });

    it('不正なリクエストで 400 を返すべき', async () => {
      const res = await adminRoutes.request('/fault-injection/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'event-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('不正な JSON の場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/fault-injection/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('JSON の解析に失敗しました');
    });
  });

  describe('GET /teams', () => {
    it('eventId 付きでチーム一覧を返すべき', async () => {
      const res = await adminRoutes.request('/teams?eventId=event-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.teams).toEqual([]);
    });

    it('eventId がない場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/teams');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /attack-logs', () => {
    it('eventId 付きで攻撃履歴を返すべき', async () => {
      const res = await adminRoutes.request('/attack-logs?eventId=event-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toEqual([]);
    });

    it('eventId がない場合 400 を返すべき', async () => {
      const res = await adminRoutes.request('/attack-logs');
      expect(res.status).toBe(400);
    });
  });
});
