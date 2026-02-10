import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { battleRepository } from '../lib/dynamodb';
import { getLeaderboard } from '../services/leaderboard';

export const leaderboardRoutes = new Hono();

const querySchema = z.object({
  freezeMinutes: z.coerce.number().int().min(0).optional(),
});

leaderboardRoutes.get('/api/leaderboards/:battleId', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('battleId');

  const queryResult = querySchema.safeParse({
    freezeMinutes: c.req.query('freezeMinutes'),
  });

  const freezeMinutes = queryResult.success
    ? queryResult.data.freezeMinutes
    : undefined;

  try {
    const result = await getLeaderboard(
      battleId,
      auth.tenantId,
      battleRepository,
      freezeMinutes
    );

    if (!result) {
      return c.json({ error: 'バトルが見つかりません' }, 404);
    }

    return c.json(result);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 500);
    }
    return c.json({ error: 'リーダーボードの取得に失敗しました' }, 500);
  }
});

const SSE_INTERVAL_MS = 3000;

leaderboardRoutes.get('/api/leaderboards/:battleId/stream', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('battleId');

  return streamSSE(c, async (stream) => {
    let running = true;

    /* v8 ignore next 3 */
    stream.onAbort(() => {
      running = false;
    });

    while (running) {
      const result = await getLeaderboard(
        battleId,
        auth.tenantId,
        battleRepository
      );

      if (!result) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'バトルが見つかりません' }),
        });
        break;
      }

      await stream.writeSSE({
        event: 'leaderboard',
        data: JSON.stringify(result),
      });

      if (result.status === 'FINISHED' || result.status === 'ARCHIVED') {
        break;
      }

      await stream.sleep(SSE_INTERVAL_MS);
    }
  });
});
