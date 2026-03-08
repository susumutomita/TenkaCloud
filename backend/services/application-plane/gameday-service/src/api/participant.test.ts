import { describe, it, expect } from 'vitest';
import { participantRoutes } from './participant';

describe('プレーヤー API', () => {
  describe('攻撃', () => {
    it('GET /attacks/catalog で攻撃カタログを返すべき', async () => {
      const res = await participantRoutes.request('/attacks/catalog');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.attacks).toEqual([]);
    });

    it('POST /attacks/purchase で攻撃を購入できるべき', async () => {
      const res = await participantRoutes.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attackId: 'atk-1' }),
      });
      expect(res.status).toBe(200);
    });

    it('POST /attacks/purchase で不正なリクエストに 400 を返すべき', async () => {
      const res = await participantRoutes.request('/attacks/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /attacks/execute で攻撃を実行できるべき', async () => {
      const res = await participantRoutes.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attackId: 'atk-1', targetTeamId: 'team-2' }),
      });
      expect(res.status).toBe(200);
    });

    it('POST /attacks/execute で不正なリクエストに 400 を返すべき', async () => {
      const res = await participantRoutes.request('/attacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attackId: 'atk-1' }),
      });
      expect(res.status).toBe(400);
    });

    it('GET /attacks/history で攻撃履歴を返すべき', async () => {
      const res = await participantRoutes.request('/attacks/history');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.history).toEqual([]);
    });
  });

  describe('防御', () => {
    it('GET /defense/active で受攻撃一覧を返すべき', async () => {
      const res = await participantRoutes.request('/defense/active');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.attacks).toEqual([]);
    });

    it('POST /defense/hint で不正なリクエストに 400 を返すべき', async () => {
      const res = await participantRoutes.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /defense/hint でヒントを購入できるべき', async () => {
      const res = await participantRoutes.request('/defense/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attackId: 'atk-1' }),
      });
      expect(res.status).toBe(200);
    });

    it('POST /defense/report-fix で不正なリクエストに 400 を返すべき', async () => {
      const res = await participantRoutes.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /defense/report-fix で修正を報告できるべき', async () => {
      const res = await participantRoutes.request('/defense/report-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vulnerabilitySlug: 'sql-injection' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('同盟', () => {
    it('GET /alliances で同盟一覧を返すべき', async () => {
      const res = await participantRoutes.request('/alliances');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alliances).toEqual([]);
    });

    it('POST /alliances/request で不正なリクエストに 400 を返すべき', async () => {
      const res = await participantRoutes.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /alliances/request で同盟を申請できるべき', async () => {
      const res = await participantRoutes.request('/alliances/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetTeamId: 'team-2' }),
      });
      expect(res.status).toBe(200);
    });

    it('POST /alliances/:id/accept で同盟を承認できるべき', async () => {
      const res = await participantRoutes.request(
        '/alliances/alliance-1/accept',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allianceId).toBe('alliance-1');
    });

    it('POST /alliances/:id/break で同盟を破棄できるべき', async () => {
      const res = await participantRoutes.request(
        '/alliances/alliance-1/break',
        {
          method: 'POST',
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allianceId).toBe('alliance-1');
    });
  });

  describe('モニタリング', () => {
    it('GET /monitoring/status でヘルスチェック状態を返すべき', async () => {
      const res = await participantRoutes.request('/monitoring/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checks).toEqual([]);
    });
  });

  describe('投票', () => {
    it('POST /voting/vote で不正なリクエストに 400 を返すべき', async () => {
      const res = await participantRoutes.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /voting/vote で投票できるべき', async () => {
      const res = await participantRoutes.request('/voting/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-2' }),
      });
      expect(res.status).toBe(200);
    });

    it('GET /voting/results で投票結果を返すべき', async () => {
      const res = await participantRoutes.request('/voting/results');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
    });
  });
});
