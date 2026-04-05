import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRepository = vi.hoisted(() => ({
	createTeam: vi.fn(),
	updateTeamUrls: vi.fn(),
	getGameState: vi.fn(),
	listTeams: vi.fn(),
	listAttackLogs: vi.fn(),
	getTeamState: vi.fn(),
	listHealthChecks: vi.fn(),
	findTeamByInviteCode: vi.fn(),
}));

vi.mock("../lib/dynamodb", () => ({
	gamedayRepository: mockRepository,
}));

// TeamAlreadyExistsError は実際のクラスを使うためモック不要
const mockTeamAlreadyExistsError = vi.hoisted(() => {
	class TeamAlreadyExistsError extends Error {
		constructor(teamId: string) {
			super(`チームは既に登録済みです: ${teamId}`);
			this.name = "TeamAlreadyExistsError";
		}
	}
	return { TeamAlreadyExistsError };
});

vi.mock("../repositories/gameday-repository", () => mockTeamAlreadyExistsError);

import {
	registerTeam,
	updateTeamUrl,
	getLeaderboard,
	getAttackStatistics,
	getTeamDashboard,
	joinTeamByInviteCode,
	BlackoutActiveError,
	TeamAlreadyExistsError,
} from "./dashboard-service";

describe("ダッシュボードサービス", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// === チーム登録 ===
	describe("registerTeam", () => {
		it("チームを登録できるべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "チームA",
				score: 0,
				isHealthy: true,
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			};
			mockRepository.createTeam.mockResolvedValue(team);

			const result = await registerTeam({
				eventId: "event-1",
				teamId: "team-1",
				teamName: "チームA",
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			});

			expect(result).toEqual(team);
			expect(mockRepository.createTeam).toHaveBeenCalledWith({
				eventId: "event-1",
				teamId: "team-1",
				teamName: "チームA",
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			});
		});

		it("重複チーム登録で TeamAlreadyExistsError を投げるべき", async () => {
			mockRepository.createTeam.mockRejectedValue(
				new TeamAlreadyExistsError("team-1"),
			);

			await expect(
				registerTeam({
					eventId: "event-1",
					teamId: "team-1",
					teamName: "チームA",
				}),
			).rejects.toThrow(TeamAlreadyExistsError);
		});
	});

	// === チーム URL 更新 ===
	describe("updateTeamUrl", () => {
		it("チーム URL を更新できるべき", async () => {
			mockRepository.getTeamState.mockResolvedValue({
				teamId: "team-1",
				teamName: "A",
			});
			mockRepository.updateTeamUrls.mockResolvedValue(undefined);

			await updateTeamUrl("event-1", "team-1", {
				websiteUrl: "https://new.example.com",
			});

			expect(mockRepository.updateTeamUrls).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				{ websiteUrl: "https://new.example.com" },
			);
		});

		it("チームが存在しない場合 TeamNotFoundError を投げるべき", async () => {
			mockRepository.getTeamState.mockResolvedValue(null);

			await expect(
				updateTeamUrl("event-1", "nonexistent", {
					websiteUrl: "https://example.com",
				}),
			).rejects.toThrow("チームが見つかりません");
		});
	});

	// === リーダーボード ===
	describe("getLeaderboard", () => {
		it("スコア降順でチーム一覧を返すべき", async () => {
			mockRepository.getGameState.mockResolvedValue({
				eventId: "event-1",
				blackout: false,
			});
			mockRepository.listTeams.mockResolvedValue([
				{
					teamId: "team-1",
					teamName: "A",
					score: 1000,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
				{
					teamId: "team-2",
					teamName: "B",
					score: 5000,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
				{
					teamId: "team-3",
					teamName: "C",
					score: 3000,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
			]);

			const result = await getLeaderboard("event-1");

			expect(result[0].teamId).toBe("team-2");
			expect(result[1].teamId).toBe("team-3");
			expect(result[2].teamId).toBe("team-1");
		});

		it("ブラックアウト中は BlackoutActiveError を投げるべき", async () => {
			mockRepository.getGameState.mockResolvedValue({
				eventId: "event-1",
				blackout: true,
			});

			await expect(getLeaderboard("event-1")).rejects.toThrow(
				BlackoutActiveError,
			);
		});

		it("ゲーム未作成時は空配列を返すべき", async () => {
			mockRepository.getGameState.mockResolvedValue(null);
			mockRepository.listTeams.mockResolvedValue([]);

			const result = await getLeaderboard("event-1");
			expect(result).toEqual([]);
		});
	});

	// === 攻撃統計 ===
	describe("getAttackStatistics", () => {
		it("チームごとの攻撃統計を集計するべき", async () => {
			mockRepository.listTeams.mockResolvedValue([
				{
					teamId: "team-1",
					teamName: "A",
					score: 0,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
				{
					teamId: "team-2",
					teamName: "B",
					score: 0,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
			]);
			mockRepository.listAttackLogs.mockResolvedValue([
				{ attackerTeamId: "team-1", defenderTeamId: "team-2", success: true },
				{ attackerTeamId: "team-1", defenderTeamId: "team-2", success: false },
				{ attackerTeamId: "team-2", defenderTeamId: "team-1", success: true },
			]);

			const result = await getAttackStatistics("event-1");

			const team1Stats = result.find((s) => s.teamId === "team-1")!;
			expect(team1Stats.attacksSent).toBe(2);
			expect(team1Stats.attacksReceived).toBe(1);
			expect(team1Stats.successRate).toBe(0.5);

			const team2Stats = result.find((s) => s.teamId === "team-2")!;
			expect(team2Stats.attacksSent).toBe(1);
			expect(team2Stats.attacksReceived).toBe(2);
			expect(team2Stats.successRate).toBe(1);
		});

		it("ADMIN 攻撃は統計に含まれないべき", async () => {
			mockRepository.listTeams.mockResolvedValue([
				{
					teamId: "team-1",
					teamName: "A",
					score: 0,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
			]);
			mockRepository.listAttackLogs.mockResolvedValue([
				{ attackerTeamId: "ADMIN", defenderTeamId: "team-1", success: true },
			]);

			const result = await getAttackStatistics("event-1");

			const team1Stats = result.find((s) => s.teamId === "team-1")!;
			expect(team1Stats.attacksSent).toBe(0);
			expect(team1Stats.attacksReceived).toBe(0);
			expect(team1Stats.successRate).toBe(0);
		});

		it("攻撃がないチームの成功率は 0 であるべき", async () => {
			mockRepository.listTeams.mockResolvedValue([
				{
					teamId: "team-1",
					teamName: "A",
					score: 0,
					isHealthy: true,
					websiteUrl: null,
					apiUrl: null,
				},
			]);
			mockRepository.listAttackLogs.mockResolvedValue([]);

			const result = await getAttackStatistics("event-1");
			expect(result[0].successRate).toBe(0);
		});
	});

	// === チームダッシュボード ===
	describe("getTeamDashboard", () => {
		it("チーム詳細ダッシュボードを返すべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 5000,
				isHealthy: true,
				websiteUrl: null,
				apiUrl: null,
			};
			mockRepository.getTeamState.mockResolvedValue(team);
			mockRepository.listHealthChecks.mockResolvedValue([
				{ id: "hc-1", checkType: "website", isHealthy: true },
			]);
			mockRepository.listAttackLogs.mockResolvedValue([
				{ attackerTeamId: "team-1", defenderTeamId: "team-2", success: true },
				{ attackerTeamId: "team-3", defenderTeamId: "team-1", success: false },
				{ attackerTeamId: "team-2", defenderTeamId: "team-3", success: true },
			]);

			const result = await getTeamDashboard("event-1", "team-1");

			expect(result).not.toBeNull();
			expect(result!.team).toEqual(team);
			expect(result!.recentHealthChecks).toHaveLength(1);
			expect(result!.attackHistory).toHaveLength(2);
		});

		it("チームが存在しない場合は null を返すべき", async () => {
			mockRepository.getTeamState.mockResolvedValue(null);

			const result = await getTeamDashboard("event-1", "nonexistent");
			expect(result).toBeNull();
		});
	});

	// === 招待コードでチーム参加 ===
	describe("joinTeamByInviteCode", () => {
		it("有効な招待コードでチームを返すべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "チームA",
				score: 0,
				isHealthy: true,
				websiteUrl: null,
				apiUrl: null,
				inviteCode: "ABC123",
			};
			mockRepository.findTeamByInviteCode.mockResolvedValue(team);

			const result = await joinTeamByInviteCode("event-1", "ABC123");

			expect(result).toEqual(team);
			expect(mockRepository.findTeamByInviteCode).toHaveBeenCalledWith(
				"event-1",
				"ABC123",
			);
		});

		it("無効な招待コードで null を返すべき", async () => {
			mockRepository.findTeamByInviteCode.mockResolvedValue(null);

			const result = await joinTeamByInviteCode("event-1", "XXXXXX");

			expect(result).toBeNull();
		});
	});
});
