import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { gamedayLeaderboardRoutes } from "./gameday-leaderboard";
import * as gamedayLeaderboardService from "../services/gameday-leaderboard";

vi.mock("../services/gameday-leaderboard", async () => {
	const actual = await vi.importActual("../services/gameday-leaderboard");
	return {
		...actual,
		getGameDayLeaderboard: vi.fn(),
		DynamoDBGameDayLeaderboardRepository: vi.fn(),
	};
});

function createApp() {
	const app = new Hono();
	app.use("/*", async (c, next) => {
		c.set("auth", {
			userId: "user-123",
			tenantId: "tenant-456",
			roles: ["user"],
		});
		await next();
	});
	app.route("/", gamedayLeaderboardRoutes);
	return app;
}

describe("GameDay リーダーボード API", () => {
	let app: Hono;

	beforeEach(() => {
		vi.clearAllMocks();
		app = createApp();
	});

	describe("GET /api/leaderboards/gameday/:eventId", () => {
		it("GameDayリーダーボードを正常に取得するべき", async () => {
			const mockResult = {
				eventId: "event-1",
				entries: [
					{ rank: 1, teamId: "team-1", teamName: "Alpha", score: 300 },
					{ rank: 2, teamId: "team-2", teamName: "Beta", score: 200 },
				],
			};

			vi.mocked(
				gamedayLeaderboardService.getGameDayLeaderboard,
			).mockResolvedValue(mockResult);

			const res = await app.request("/api/leaderboards/gameday/event-1");

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.eventId).toBe("event-1");
			expect(body.entries).toHaveLength(2);
			expect(body.entries[0].rank).toBe(1);
			expect(body.entries[0].teamName).toBe("Alpha");
		});

		it("チームがない場合は空のエントリを返すべき", async () => {
			const mockResult = {
				eventId: "event-1",
				entries: [],
			};

			vi.mocked(
				gamedayLeaderboardService.getGameDayLeaderboard,
			).mockResolvedValue(mockResult);

			const res = await app.request("/api/leaderboards/gameday/event-1");

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.entries).toEqual([]);
		});

		it("Errorが発生した場合は500を返すべき", async () => {
			vi.mocked(
				gamedayLeaderboardService.getGameDayLeaderboard,
			).mockRejectedValue(new Error("DynamoDB接続エラー"));

			const res = await app.request("/api/leaderboards/gameday/event-1");

			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe("DynamoDB接続エラー");
		});

		it("Error以外のthrowの場合は500を返すべき", async () => {
			vi.mocked(
				gamedayLeaderboardService.getGameDayLeaderboard,
			).mockRejectedValue("unexpected");

			const res = await app.request("/api/leaderboards/gameday/event-1");

			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.error).toBe("GameDayリーダーボードの取得に失敗しました");
		});
	});
});
