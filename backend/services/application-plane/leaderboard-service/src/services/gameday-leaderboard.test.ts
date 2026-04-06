import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	buildGameDayLeaderboard,
	getGameDayLeaderboard,
	DynamoDBGameDayLeaderboardRepository,
	type GameDayLeaderboardRepository,
} from "./gameday-leaderboard";

const mockSend = vi.fn();

vi.mock("@tenkacloud/dynamodb", () => ({
	getDocClient: () => ({ send: mockSend }),
	getTableName: () => "TestTable",
}));

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

describe("DynamoDBGameDayLeaderboardRepository", () => {
	let repo: DynamoDBGameDayLeaderboardRepository;

	beforeEach(() => {
		vi.clearAllMocks();
		repo = new DynamoDBGameDayLeaderboardRepository();
	});

	it("DynamoDB からチーム一覧を取得するべき", async () => {
		mockSend.mockResolvedValue({
			Items: [
				{
					PK: "GAMEDAY#event-1",
					SK: "TEAM#team-1",
					EntityType: "TEAM",
					eventId: "event-1",
					teamId: "team-1",
					teamName: "Alpha",
					score: 200,
				},
				{
					PK: "GAMEDAY#event-1",
					SK: "TEAM#team-2",
					EntityType: "TEAM",
					eventId: "event-1",
					teamId: "team-2",
					teamName: "Beta",
					score: 100,
				},
			],
			LastEvaluatedKey: undefined,
		});

		const teams = await repo.listTeams("event-1");

		expect(teams).toHaveLength(2);
		expect(teams[0].teamName).toBe("Alpha");
		expect(teams[1].teamName).toBe("Beta");
	});

	it("Items が空の場合は空配列を返すべき", async () => {
		mockSend.mockResolvedValue({
			Items: undefined,
			LastEvaluatedKey: undefined,
		});

		const teams = await repo.listTeams("event-1");

		expect(teams).toEqual([]);
	});

	it("ページネーションで全件取得するべき", async () => {
		mockSend
			.mockResolvedValueOnce({
				Items: [
					{
						PK: "GAMEDAY#event-1",
						SK: "TEAM#team-1",
						EntityType: "TEAM",
						eventId: "event-1",
						teamId: "team-1",
						teamName: "Alpha",
						score: 200,
					},
				],
				LastEvaluatedKey: { PK: "GAMEDAY#event-1", SK: "TEAM#team-1" },
			})
			.mockResolvedValueOnce({
				Items: [
					{
						PK: "GAMEDAY#event-1",
						SK: "TEAM#team-2",
						EntityType: "TEAM",
						eventId: "event-1",
						teamId: "team-2",
						teamName: "Beta",
						score: 100,
					},
				],
				LastEvaluatedKey: undefined,
			});

		const teams = await repo.listTeams("event-1");

		expect(teams).toHaveLength(2);
		expect(mockSend).toHaveBeenCalledTimes(2);
	});

	it("TEAM# プレフィックスのサブキーを除外するべき", async () => {
		mockSend.mockResolvedValue({
			Items: [
				{
					PK: "GAMEDAY#event-1",
					SK: "TEAM#team-1",
					EntityType: "TEAM",
					eventId: "event-1",
					teamId: "team-1",
					teamName: "Alpha",
					score: 200,
				},
				{
					PK: "GAMEDAY#event-1",
					SK: "TEAM#team-1#MEMBER#user-1",
					EntityType: "MEMBER",
					eventId: "event-1",
					teamId: "team-1",
					teamName: "Alpha",
					score: 0,
				},
			],
			LastEvaluatedKey: undefined,
		});

		const teams = await repo.listTeams("event-1");

		expect(teams).toHaveLength(1);
		expect(teams[0].teamId).toBe("team-1");
	});
});
