import { Hono } from "hono";
import { z } from "zod";
import { battleRepository } from "../lib/dynamodb";
import { getLeaderboard } from "../services/leaderboard";

export const leaderboardRoutes = new Hono();

const querySchema = z.object({
	freezeMinutes: z.coerce.number().int().min(0).optional(),
});

leaderboardRoutes.get("/api/leaderboards/:battleId", async (c) => {
	const auth = c.get("auth");
	const battleId = c.req.param("battleId");

	const queryResult = querySchema.safeParse({
		freezeMinutes: c.req.query("freezeMinutes"),
	});

	const freezeMinutes = queryResult.success
		? queryResult.data.freezeMinutes
		: undefined;

	try {
		const result = await getLeaderboard(
			battleId,
			auth.tenantId,
			battleRepository,
			freezeMinutes,
		);

		if (!result) {
			return c.json({ error: "バトルが見つかりません" }, 404);
		}

		return c.json(result);
	} catch (error) {
		if (error instanceof Error) {
			return c.json({ error: error.message }, 500);
		}
		return c.json({ error: "リーダーボードの取得に失敗しました" }, 500);
	}
});

// `/api/leaderboards/:battleId/stream` (SSE) was removed. Clients now poll
// the non-streaming endpoint above at whatever interval they choose. Rationale:
// Lambda cannot cheaply hold long-lived SSE connections and in-memory subscriber
// state does not survive horizontal scale-out.
