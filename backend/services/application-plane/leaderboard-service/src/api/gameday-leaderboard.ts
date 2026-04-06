import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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

const SSE_INTERVAL_MS = 3000;

gamedayLeaderboardRoutes.get(
	"/api/leaderboards/gameday/:eventId/stream",
	async (c) => {
		const eventId = c.req.param("eventId");

		return streamSSE(c, async (stream) => {
			let running = true;

			stream.onAbort(/* istanbul ignore next */ () => {
				running = false;
			});

			while (running) {
				try {
					const result = await getGameDayLeaderboard(eventId, repository);

					await stream.writeSSE({
						event: "leaderboard",
						data: JSON.stringify(result),
					});

					await stream.sleep(SSE_INTERVAL_MS);
				} catch (error) {
					await stream.writeSSE({
						event: "error",
						data: JSON.stringify({
							error:
								error instanceof Error
									? error.message
									: "GameDayリーダーボードの取得に失敗しました",
						}),
					});
					break;
				}
			}
		});
	},
);
