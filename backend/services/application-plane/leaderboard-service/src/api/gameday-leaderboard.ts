import { Hono } from "hono";
import {
	getGameDayLeaderboard,
	DynamoDBGameDayLeaderboardRepository,
} from "../services/gameday-leaderboard";

export const gamedayLeaderboardRoutes = new Hono();

const repository = new DynamoDBGameDayLeaderboardRepository();

gamedayLeaderboardRoutes.get(
	"/api/leaderboards/gameday/:eventId",
	async (c) => {
		const eventId = c.req.param("eventId");

		try {
			const result = await getGameDayLeaderboard(eventId, repository);
			return c.json(result);
		} catch (error) {
			if (error instanceof Error) {
				return c.json({ error: error.message }, 500);
			}
			return c.json(
				{ error: "GameDayリーダーボードの取得に失敗しました" },
				500,
			);
		}
	},
);
