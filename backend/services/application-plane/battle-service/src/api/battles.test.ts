import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { battlesRoutes } from './battles';
import { BattleMode, BattleStatus } from '@tenkacloud/dynamodb';
import * as battleService from '../services/battle';

vi.mock('../services/battle');

const mockAuth = {
  userId: 'user-123',
  tenantId: 'tenant-456',
  roles: ['user'],
};

describe('バトル API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/*', async (c, next) => {
      c.set('auth', mockAuth);
      await next();
    });
    app.route('/', battlesRoutes);
  });

  describe('GET /battles', () => {
    it('バトル一覧を取得できるべき', async () => {
      const mockResult = {
        data: [{ id: 'battle-1', title: 'テストバトル' }],
        total: 1,
        page: 1,
        limit: 20,
      };
      vi.mocked(battleService.listBattles).mockResolvedValue(
        mockResult as never
      );

      const res = await app.request('/battles');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockResult);
    });

    it('ステータスでフィルタできるべき', async () => {
      vi.mocked(battleService.listBattles).mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      await app.request('/battles?status=RUNNING');

      expect(battleService.listBattles).toHaveBeenCalledWith(
        'tenant-456',
        expect.objectContaining({ status: BattleStatus.RUNNING })
      );
    });

    it('無効なステータスで400を返すべき', async () => {
      const res = await app.request('/battles?status=INVALID');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('パラメータが不正です');
    });
  });

  describe('POST /battles', () => {
    it('バトルを作成できるべき', async () => {
      const newBattle = {
        id: 'battle-1',
        tenantId: 'tenant-456',
        title: '新しいバトル',
        mode: BattleMode.INDIVIDUAL,
        maxParticipants: 10,
        timeLimit: 3600,
        status: BattleStatus.DRAFT,
      };
      vi.mocked(battleService.createBattle).mockResolvedValue(
        newBattle as never
      );

      const res = await app.request('/battles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '新しいバトル',
          mode: 'INDIVIDUAL',
          maxParticipants: 10,
          timeLimit: 3600,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('新しいバトル');
    });

    it('不正なJSONで400を返すべき', async () => {
      const res = await app.request('/battles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('リクエストボディが不正です');
    });

    it('バリデーションエラーで400を返すべき', async () => {
      const res = await app.request('/battles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '',
          mode: 'INDIVIDUAL',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });
  });

  describe('GET /battles/:id', () => {
    it('バトル詳細を取得できるべき', async () => {
      const battle = {
        id: 'battle-1',
        tenantId: 'tenant-456',
        title: 'テストバトル',
        participants: [],
      };
      vi.mocked(battleService.getBattle).mockResolvedValue(battle as never);

      const res = await app.request('/battles/battle-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('テストバトル');
    });

    it('存在しないバトルで404を返すべき', async () => {
      vi.mocked(battleService.getBattle).mockResolvedValue(null);

      const res = await app.request('/battles/non-existent');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });
  });

  describe('PATCH /battles/:id', () => {
    it('バトルを更新できるべき', async () => {
      const updatedBattle = {
        id: 'battle-1',
        tenantId: 'tenant-456',
        title: '更新されたタイトル',
      };
      vi.mocked(battleService.updateBattle).mockResolvedValue(
        updatedBattle as never
      );

      const res = await app.request('/battles/battle-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '更新されたタイトル' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe('更新されたタイトル');
    });

    it('実行中バトルの更新で400を返すべき', async () => {
      vi.mocked(battleService.updateBattle).mockRejectedValue(
        new Error('実行中・終了済み・アーカイブ済みのバトルは更新できません')
      );

      const res = await app.request('/battles/battle-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新タイトル' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        '実行中・終了済み・アーカイブ済みのバトルは更新できません'
      );
    });

    it('バトルが見つからない場合404を返すべき', async () => {
      vi.mocked(battleService.updateBattle).mockResolvedValue(null);

      const res = await app.request('/battles/non-existent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新タイトル' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });

    it('不正なJSONで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('リクエストボディが不正です');
    });

    it('バリデーションエラーで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.updateBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '新タイトル' }),
        })
      ).rejects.toThrow();
    });
  });

  describe('DELETE /battles/:id', () => {
    it('バトルを削除できるべき', async () => {
      vi.mocked(battleService.deleteBattle).mockResolvedValue(undefined);

      const res = await app.request('/battles/battle-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(204);
    });

    it('下書き以外の削除で400を返すべき', async () => {
      vi.mocked(battleService.deleteBattle).mockRejectedValue(
        new Error('下書き状態のバトルのみ削除できます')
      );

      const res = await app.request('/battles/battle-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('下書き状態のバトルのみ削除できます');
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.deleteBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1', { method: 'DELETE' })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/transition', () => {
    it('バトルの状態を遷移できるべき', async () => {
      const battle = {
        id: 'battle-1',
        status: BattleStatus.OPEN,
      };
      vi.mocked(battleService.transitionBattle).mockResolvedValue(
        battle as never
      );

      const res = await app.request('/battles/battle-1/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'OPEN' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('OPEN');
    });

    it('バトルが見つからない場合404を返すべき', async () => {
      vi.mocked(battleService.transitionBattle).mockResolvedValue(null);

      const res = await app.request('/battles/non-existent/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'OPEN' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });

    it('無効な遷移で400を返すべき', async () => {
      vi.mocked(battleService.transitionBattle).mockRejectedValue(
        new Error('DRAFT から RUNNING への遷移はできません')
      );

      const res = await app.request('/battles/battle-1/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'RUNNING' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('DRAFT から RUNNING への遷移はできません');
    });

    it('不正なJSONで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('リクエストボディが不正です');
    });

    it('バリデーションエラーで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'INVALID' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.transitionBattle).mockRejectedValue(
        'string error'
      );

      await expect(
        app.request('/battles/battle-1/transition', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'OPEN' }),
        })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/participants', () => {
    it('バトルに参加できるべき', async () => {
      const participant = {
        id: 'participant-1',
        battleId: 'battle-1',
        userId: 'user-123',
        score: 0,
      };
      vi.mocked(battleService.joinBattle).mockResolvedValue(
        participant as never
      );

      const res = await app.request('/battles/battle-1/participants', {
        method: 'POST',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.userId).toBe('user-123');
    });

    it('定員オーバーで400を返すべき', async () => {
      vi.mocked(battleService.joinBattle).mockRejectedValue(
        new Error('バトルの定員に達しています')
      );

      const res = await app.request('/battles/battle-1/participants', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.joinBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/participants', { method: 'POST' })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/leave', () => {
    it('バトルから退出できるべき', async () => {
      vi.mocked(battleService.leaveBattle).mockResolvedValue(undefined);

      const res = await app.request('/battles/battle-1/leave', {
        method: 'POST',
      });

      expect(res.status).toBe(204);
    });

    it('サービスエラーで400を返すべき', async () => {
      vi.mocked(battleService.leaveBattle).mockRejectedValue(
        new Error('バトルが見つかりません')
      );

      const res = await app.request('/battles/battle-1/leave', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.leaveBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/leave', { method: 'POST' })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/score', () => {
    it('スコアを更新できるべき', async () => {
      const participant = {
        id: 'participant-1',
        battleId: 'battle-1',
        userId: 'user-123',
        score: 100,
      };
      vi.mocked(battleService.updateScore).mockResolvedValue(
        participant as never
      );

      const res = await app.request('/battles/battle-1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 100 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.score).toBe(100);
    });

    it('不正なJSONで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid',
      });

      expect(res.status).toBe(400);
    });

    it('不正なスコアで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: -10 }),
      });

      expect(res.status).toBe(400);
    });

    it('サービスエラーで400を返すべき', async () => {
      vi.mocked(battleService.updateScore).mockRejectedValue(
        new Error('バトルが見つかりません')
      );

      const res = await app.request('/battles/battle-1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 100 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.updateScore).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score: 100 }),
        })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/problems', () => {
    it('バトルに問題を追加できるべき', async () => {
      vi.mocked(battleService.addProblem).mockResolvedValue(undefined);

      const res = await app.request('/battles/battle-1/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemId: 'problem-1' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('不正なJSONで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('リクエストボディが不正です');
    });

    it('バリデーションエラーで400を返すべき', async () => {
      const res = await app.request('/battles/battle-1/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemId: '' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('サービスエラーで400を返すべき', async () => {
      vi.mocked(battleService.addProblem).mockRejectedValue(
        new Error('下書きまたは募集中のバトルにのみ問題を追加できます')
      );

      const res = await app.request('/battles/battle-1/problems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemId: 'problem-1' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        '下書きまたは募集中のバトルにのみ問題を追加できます'
      );
    });

    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.addProblem).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/problems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ problemId: 'problem-1' }),
        })
      ).rejects.toThrow();
    });
  });
});
