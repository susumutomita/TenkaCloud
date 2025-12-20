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
      vi.mocked(battleService.listBattles).mockResolvedValue(mockResult);

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

      await app.request('/battles?status=IN_PROGRESS');

      expect(battleService.listBattles).toHaveBeenCalledWith(
        'tenant-456',
        expect.objectContaining({ status: BattleStatus.IN_PROGRESS })
      );
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
        status: BattleStatus.WAITING,
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
          title: '', // 空文字は不可
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
        teams: [],
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

    it('進行中バトルの更新で400を返すべき', async () => {
      vi.mocked(battleService.updateBattle).mockRejectedValue(
        new Error('進行中のバトルは更新できません')
      );

      const res = await app.request('/battles/battle-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新タイトル' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('進行中のバトルは更新できません');
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

    it('進行中バトルの削除で400を返すべき', async () => {
      vi.mocked(battleService.deleteBattle).mockRejectedValue(
        new Error('進行中のバトルは削除できません')
      );

      const res = await app.request('/battles/battle-1', {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('進行中のバトルは削除できません');
    });
  });

  describe('POST /battles/:id/start', () => {
    it('バトルを開始できるべき', async () => {
      const battle = {
        id: 'battle-1',
        status: BattleStatus.IN_PROGRESS,
        startedAt: new Date(),
      };
      vi.mocked(battleService.startBattle).mockResolvedValue(battle as never);

      const res = await app.request('/battles/battle-1/start', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('IN_PROGRESS');
    });

    it('参加者なしで400を返すべき', async () => {
      vi.mocked(battleService.startBattle).mockRejectedValue(
        new Error('参加者がいないためバトルを開始できません')
      );

      const res = await app.request('/battles/battle-1/start', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /battles/:id/end', () => {
    it('バトルを終了できるべき', async () => {
      const battle = {
        id: 'battle-1',
        status: BattleStatus.FINISHED,
        endedAt: new Date(),
      };
      vi.mocked(battleService.endBattle).mockResolvedValue(battle as never);

      const res = await app.request('/battles/battle-1/end', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('FINISHED');
    });
  });

  describe('POST /battles/:id/join', () => {
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

      const res = await app.request('/battles/battle-1/join', {
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

      const res = await app.request('/battles/battle-1/join', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
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
  });

  describe('GET /battles - 追加ケース', () => {
    it('無効なステータスで400を返すべき', async () => {
      const res = await app.request('/battles?status=INVALID');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('パラメータが不正です');
    });
  });

  describe('PATCH /battles/:id - 追加ケース', () => {
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
        body: JSON.stringify({ title: '' }), // 空文字は不可
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });
  });

  describe('POST /battles/:id/start - 追加ケース', () => {
    it('バトルが見つからない場合404を返すべき', async () => {
      vi.mocked(battleService.startBattle).mockResolvedValue(null);

      const res = await app.request('/battles/non-existent/start', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });
  });

  describe('POST /battles/:id/end - 追加ケース', () => {
    it('バトルが見つからない場合404を返すべき', async () => {
      vi.mocked(battleService.endBattle).mockResolvedValue(null);

      const res = await app.request('/battles/non-existent/end', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('バトルが見つかりません');
    });

    it('サービスエラーで400を返すべき', async () => {
      vi.mocked(battleService.endBattle).mockRejectedValue(
        new Error('進行中でないバトルは終了できません')
      );

      const res = await app.request('/battles/battle-1/end', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('進行中でないバトルは終了できません');
    });
  });

  describe('POST /battles/:id/leave - 追加ケース', () => {
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

  describe('POST /battles/:id/join - 非Errorケース', () => {
    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.joinBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/join', { method: 'POST' })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/score - 非Errorケース', () => {
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

  describe('POST /battles/:id/start - 非Errorケース', () => {
    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.startBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/start', { method: 'POST' })
      ).rejects.toThrow();
    });
  });

  describe('POST /battles/:id/end - 非Errorケース', () => {
    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.endBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1/end', { method: 'POST' })
      ).rejects.toThrow();
    });
  });

  describe('PATCH /battles/:id - 非Errorケース', () => {
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

  describe('DELETE /battles/:id - 非Errorケース', () => {
    it('非Errorがスローされた場合は再スローするべき', async () => {
      vi.mocked(battleService.deleteBattle).mockRejectedValue('string error');

      await expect(
        app.request('/battles/battle-1', { method: 'DELETE' })
      ).rejects.toThrow();
    });
  });
});
