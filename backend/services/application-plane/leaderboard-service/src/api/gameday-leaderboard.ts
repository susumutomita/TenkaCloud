/**
 * GameDay Leaderboard API
 *
 * GameDay イベントのリーダーボードエンドポイント
 * - GET /api/leaderboards/gameday/:eventId — リーダーボード取得
 * - GET /api/leaderboards/gameday/:eventId/stream — SSE ストリーム
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getGameDayLeaderboard } from '../services/gameday-leaderboard';

export const gamedayLeaderboardRoutes = new Hono();

const SSE_INTERVAL_MS = 3000;

gamedayLeaderboardRoutes.get(
  '/api/leaderboards/gameday/:eventId',
  async (c) => {
    const eventId = c.req.param('eventId');
    const auth = c.get('auth');

    try {
      const result = await getGameDayLeaderboard(
        eventId,
        auth?.token,
      );

      if (!result) {
        return c.json(
          { error: 'GameDay イベントが見つかりません' },
          404,
        );
      }

      return c.json(result);
    } catch (error) {
      if (error instanceof Error) {
        return c.json({ error: error.message }, 500);
      }
      return c.json(
        { error: 'GameDay リーダーボードの取得に失敗しました' },
        500,
      );
    }
  },
);

gamedayLeaderboardRoutes.get(
  '/api/leaderboards/gameday/:eventId/stream',
  async (c) => {
    const eventId = c.req.param('eventId');
    const auth = c.get('auth');

    return streamSSE(c, async (stream) => {
      let running = true;

      stream.onAbort(() => {
        running = false;
      });

      while (running) {
        const result = await getGameDayLeaderboard(
          eventId,
          auth?.token,
        );

        if (!result) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              error: 'GameDay イベントが見つかりません',
            }),
          });
          break;
        }

        await stream.writeSSE({
          event: 'leaderboard',
          data: JSON.stringify(result),
        });

        await stream.sleep(SSE_INTERVAL_MS);
      }
    });
  },
);
