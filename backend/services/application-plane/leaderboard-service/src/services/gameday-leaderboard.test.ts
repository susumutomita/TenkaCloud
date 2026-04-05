import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	buildGameDayLeaderboard,
	getGameDayLeaderboard,
	type GameDayLeaderboardRepository,
} from "./gameday-leaderboard";

function createTeamItem(overrides: Record<string, unknown> = {}) {
	return {
		PK: "GAMEDAY#event-1",
		SK: `TEAM#${overrides.teamId ?? "team-1"}`,
		EntityType: "TEAM",
		eventId: "event-1",
		teamId: "team-1",
		teamName: "チームAlpha",
		score: 100,
		...overrides,
	};
}

describe("buildGameDayLeaderboard", () => {
	it("スコア降順でランキングを構築するべき", () => {
		const teams = [
			createTeamItem({ teamId: "team-1", teamName: "Alpha", score: 50 }),
			createTeamItem({ teamId: "team-2", teamName: "Beta", score: 200 }),
			createTeamItem({ teamId: "team-3", teamName: "Gamma", score: 100 }),
		];

		const entries = buildGameDayLeaderboard(teams);

		expect(entries).toHaveLength(3);
		expect(entries[0]).toEqual({
			rank: 1,
			teamId: "team-2",
			teamName: "Beta",
			score: 200,
		});
		expect(entries[1]).toEqual({
			rank: 2,
			teamId: "team-3",
			teamName: "Gamma",
			score: 100,
		});
		expect(entries[2]).toEqual({
			rank: 3,
			teamId: "team-1",
			teamName: "Alpha",
			score: 50,
		});
	});

	it("チームがない場合は空配列を返すべき", () => {
		const entries = buildGameDayLeaderboard([]);
		expect(entries).toEqual([]);
	});

	it("同スコアのチームにも順位を振るべき", () => {
		const teams = [
			createTeamItem({ teamId: "team-1", teamName: "Alpha", score: 100 }),
			createTeamItem({ teamId: "team-2", teamName: "Beta", score: 100 }),
		];

		const entries = buildGameDayLeaderboard(teams);

		expect(entries).toHaveLength(2);
		expect(entries[0].rank).toBe(1);
		expect(entries[1].rank).toBe(2);
		expect(entries[0].score).toBe(100);
		expect(entries[1].score).toBe(100);
	});

	it("1チームの場合はrank 1を返すべき", () => {
		const teams = [
			createTeamItem({ teamId: "team-1", teamName: "Solo", score: 300 }),
		];

		const entries = buildGameDayLeaderboard(teams);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			rank: 1,
			teamId: "team-1",
			teamName: "Solo",
			score: 300,
		});
	});
});

describe("getGameDayLeaderboard", () => {
	let repository: GameDayLeaderboardRepository;

	beforeEach(() => {
		repository = {
			listTeams: vi.fn(),
		};
	});

	it("イベントIDでチーム一覧を取得しリーダーボードを返すべき", async () => {
		const teams = [
			createTeamItem({ teamId: "team-1", teamName: "Alpha", score: 150 }),
			createTeamItem({ teamId: "team-2", teamName: "Beta", score: 300 }),
		];

		vi.mocked(repository.listTeams).mockResolvedValue(teams);

		const result = await getGameDayLeaderboard("event-1", repository);

		expect(result.eventId).toBe("event-1");
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].teamId).toBe("team-2");
		expect(result.entries[0].rank).toBe(1);
		expect(result.entries[1].teamId).toBe("team-1");
		expect(result.entries[1].rank).toBe(2);
		expect(repository.listTeams).toHaveBeenCalledWith("event-1");
	});

	it("チームがない場合は空のエントリを返すべき", async () => {
		vi.mocked(repository.listTeams).mockResolvedValue([]);

		const result = await getGameDayLeaderboard("event-1", repository);

		expect(result.eventId).toBe("event-1");
		expect(result.entries).toEqual([]);
	});
});
