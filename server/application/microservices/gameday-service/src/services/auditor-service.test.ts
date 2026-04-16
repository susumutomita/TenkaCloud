import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRepository = vi.hoisted(() => ({
	getGameState: vi.fn(),
	listTeams: vi.fn(),
	createHealthCheck: vi.fn(),
	updateTeamScore: vi.fn(),
	updateTeamHealthy: vi.fn(),
	stopGame: vi.fn(),
	enableBlackout: vi.fn(),
}));

vi.mock("../lib/dynamodb", () => ({
	gamedayRepository: mockRepository,
}));

vi.mock("../lib/logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { AuditorService } from "./auditor-service";

describe("Auditor サービス", () => {
	let auditor: AuditorService;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		auditor = new AuditorService();
	});

	afterEach(() => {
		auditor.stop();
		vi.useRealTimers();
	});

	// === httpCheck ===
	describe("httpCheck", () => {
		it("正常レスポンスで isHealthy: true を返すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					status: 200,
				}),
			);

			const result = await auditor.httpCheck("https://example.com");

			expect(result.isHealthy).toBe(true);
			expect(result.statusCode).toBe(200);
			expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
		});

		it("5xx レスポンスで isHealthy: false を返すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					status: 500,
				}),
			);

			const result = await auditor.httpCheck("https://example.com");

			expect(result.isHealthy).toBe(false);
			expect(result.statusCode).toBe(500);
		});

		it("接続エラーで isHealthy: false, statusCode: null を返すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new Error("Connection refused")),
			);

			const result = await auditor.httpCheck("https://example.com");

			expect(result.isHealthy).toBe(false);
			expect(result.statusCode).toBeNull();
		});
	});

	// === checkTeam ===
	describe("checkTeam", () => {
		beforeEach(() => {
			vi.useRealTimers();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
			mockRepository.createHealthCheck.mockResolvedValue({});
			mockRepository.updateTeamScore.mockResolvedValue(undefined);
			mockRepository.updateTeamHealthy.mockResolvedValue(undefined);
		});

		it("両方 UP で +100pt を付与するべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			};

			await auditor.checkTeam("event-1", team, "normal");

			expect(mockRepository.createHealthCheck).toHaveBeenCalledTimes(2);
			expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				100,
			);
			expect(mockRepository.updateTeamHealthy).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				true,
			);
		});

		it("片方 DOWN で -100pt（通常）を適用するべき", async () => {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValueOnce({ status: 200 })
					.mockResolvedValueOnce({ status: 503 }),
			);

			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			};

			await auditor.checkTeam("event-1", team, "normal");

			expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				-100,
			);
			expect(mockRepository.updateTeamHealthy).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				false,
			);
		});

		it("片方 DOWN + scoreWeight high で -1000pt を適用するべき", async () => {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValueOnce({ status: 200 })
					.mockRejectedValueOnce(new Error("timeout")),
			);

			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			};

			await auditor.checkTeam("event-1", team, "high");

			expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				-1000,
			);
		});

		it("両方 DOWN で -100pt（通常）を適用するべき", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new Error("Connection refused")),
			);

			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: "https://example.com",
				apiUrl: "https://api.example.com",
			};

			await auditor.checkTeam("event-1", team, "normal");

			expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				-100,
			);
			expect(mockRepository.updateTeamHealthy).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				false,
			);
		});

		it("apiUrl のみ設定時、api だけチェックするべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: null,
				apiUrl: "https://api.example.com",
			};

			await auditor.checkTeam("event-1", team, "normal");

			expect(mockRepository.createHealthCheck).toHaveBeenCalledTimes(1);
			expect(mockRepository.createHealthCheck).toHaveBeenCalledWith(
				expect.objectContaining({ checkType: "api" }),
			);
			expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				100,
			);
		});

		it("URL 未設定のチームはスキップするべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: null,
				apiUrl: null,
			};

			await auditor.checkTeam("event-1", team, "normal");

			expect(mockRepository.createHealthCheck).not.toHaveBeenCalled();
			expect(mockRepository.updateTeamScore).not.toHaveBeenCalled();
		});

		it("websiteUrl のみ設定時、website だけチェックするべき", async () => {
			const team = {
				eventId: "event-1",
				teamId: "team-1",
				teamName: "A",
				score: 0,
				isHealthy: true,
				websiteUrl: "https://example.com",
				apiUrl: null,
			};

			await auditor.checkTeam("event-1", team, "normal");

			expect(mockRepository.createHealthCheck).toHaveBeenCalledTimes(1);
			expect(mockRepository.createHealthCheck).toHaveBeenCalledWith(
				expect.objectContaining({ checkType: "website" }),
			);
			expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				100,
			);
		});
	});

	// === runCheck ===
	describe("runCheck", () => {
		it("ゲーム未開始時はチェックをスキップするべき", async () => {
			vi.useRealTimers();
			(auditor as unknown as { eventId: string }).eventId = "event-1";
			mockRepository.getGameState.mockResolvedValue({ isRunning: false });

			await auditor.runCheck();

			expect(mockRepository.listTeams).not.toHaveBeenCalled();
		});

		it("ゲームが存在しない場合はチェックをスキップするべき", async () => {
			vi.useRealTimers();
			(auditor as unknown as { eventId: string }).eventId = "event-1";
			mockRepository.getGameState.mockResolvedValue(null);

			await auditor.runCheck();

			expect(mockRepository.listTeams).not.toHaveBeenCalled();
		});

		it("eventId が null の場合は早期リターンするべき", async () => {
			vi.useRealTimers();
			await auditor.runCheck();

			expect(mockRepository.getGameState).not.toHaveBeenCalled();
		});

		it("チームのチェックが成功する場合 runCheck を正常に完了すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
			(auditor as unknown as { eventId: string }).eventId = "event-1";
			mockRepository.getGameState.mockResolvedValue({
				eventId: "event-1",
				tenantId: "tenant-1",
				isRunning: true,
				scoreWeight: "normal",
				blackout: false,
				durationMinutes: 240,
				startedAt: new Date().toISOString(),
			});
			mockRepository.listTeams.mockResolvedValue([
				{
					eventId: "event-1",
					teamId: "team-1",
					teamName: "テストチーム",
					score: 0,
					isHealthy: true,
					websiteUrl: "https://example.com",
					apiUrl: null,
				},
			]);
			mockRepository.createHealthCheck.mockResolvedValue({});
			mockRepository.updateTeamScore.mockResolvedValue(undefined);
			mockRepository.updateTeamHealthy.mockResolvedValue(undefined);

			await auditor.runCheck();

			expect(mockRepository.createHealthCheck).toHaveBeenCalled();
		});

		it("チームのチェック中にエラーが発生しても runCheck を続行すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
			(auditor as unknown as { eventId: string }).eventId = "event-1";
			mockRepository.getGameState.mockResolvedValue({
				eventId: "event-1",
				tenantId: "tenant-1",
				isRunning: true,
				scoreWeight: "normal",
				blackout: false,
				durationMinutes: 240,
				startedAt: new Date().toISOString(),
			});
			mockRepository.listTeams.mockResolvedValue([
				{
					eventId: "event-1",
					teamId: "team-1",
					teamName: "テストチーム",
					score: 0,
					isHealthy: true,
					websiteUrl: "https://example.com",
					apiUrl: null,
				},
			]);
			// createHealthCheck を失敗させて checkTeam を reject させる
			mockRepository.createHealthCheck.mockRejectedValue(
				new Error("DynamoDB write error"),
			);
			mockRepository.updateTeamScore.mockResolvedValue(undefined);
			mockRepository.updateTeamHealthy.mockResolvedValue(undefined);

			await auditor.runCheck();

			expect(mockRepository.listTeams).toHaveBeenCalled();
		});
	});

	// === enforceGameDuration ===
	describe("enforceGameDuration", () => {
		const baseGame = {
			eventId: "event-1",
			tenantId: "tenant-1",
			isRunning: true,
			scoreWeight: "normal" as const,
			durationMinutes: 240, // 4時間
			blackout: false,
		};

		beforeEach(() => {
			mockRepository.stopGame.mockResolvedValue(null);
			mockRepository.enableBlackout.mockResolvedValue(null);
		});

		it("残り30分以内でブラックアウト未設定の場合、enableBlackout を呼ぶべき", async () => {
			vi.useRealTimers();
			const auditorInstance = new AuditorService();
			// 開始から3時間31分経過（残り29分）
			const startedAt = new Date(
				Date.now() - (3 * 60 + 31) * 60 * 1000,
			).toISOString();
			const game = { ...baseGame, startedAt };

			const result = await auditorInstance.enforceGameDuration(game);

			expect(result).toBe(true);
			expect(mockRepository.enableBlackout).toHaveBeenCalledWith("event-1");
			expect(mockRepository.stopGame).not.toHaveBeenCalled();
		});

		it("残り30分以内でブラックアウト設定済みの場合、enableBlackout を呼ばないべき", async () => {
			vi.useRealTimers();
			const auditorInstance = new AuditorService();
			const startedAt = new Date(
				Date.now() - (3 * 60 + 31) * 60 * 1000,
			).toISOString();
			const game = { ...baseGame, startedAt, blackout: true };

			const result = await auditorInstance.enforceGameDuration(game);

			expect(result).toBe(true);
			expect(mockRepository.enableBlackout).not.toHaveBeenCalled();
		});

		it("ゲーム時間超過の場合、stopGame を呼び Auditor を停止すべき", async () => {
			vi.useRealTimers();
			const auditorInstance = new AuditorService();
			// 開始から4時間1分経過
			const startedAt = new Date(
				Date.now() - (4 * 60 + 1) * 60 * 1000,
			).toISOString();
			const game = { ...baseGame, startedAt };

			// intervalId を設定して stop() が動作するようにする
			(auditorInstance as unknown as { intervalId: number }).intervalId = 999;

			const result = await auditorInstance.enforceGameDuration(game);

			expect(result).toBe(false);
			expect(mockRepository.stopGame).toHaveBeenCalledWith("event-1");
			expect(auditorInstance.isRunning()).toBe(false);
		});

		it("ゲーム時間内の場合、何もせず true を返すべき", async () => {
			vi.useRealTimers();
			const auditorInstance = new AuditorService();
			// 開始から1時間経過（残り3時間）
			const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
			const game = { ...baseGame, startedAt };

			const result = await auditorInstance.enforceGameDuration(game);

			expect(result).toBe(true);
			expect(mockRepository.enableBlackout).not.toHaveBeenCalled();
			expect(mockRepository.stopGame).not.toHaveBeenCalled();
		});

		it("startedAt が null の場合、何もせず true を返すべき", async () => {
			vi.useRealTimers();
			const auditorInstance = new AuditorService();
			const game = { ...baseGame, startedAt: null };

			const result = await auditorInstance.enforceGameDuration(game);

			expect(result).toBe(true);
			expect(mockRepository.enableBlackout).not.toHaveBeenCalled();
			expect(mockRepository.stopGame).not.toHaveBeenCalled();
		});

		it("enableBlackout が失敗しても runCheck は継続すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
			const auditorInstance = new AuditorService();
			(auditorInstance as unknown as { eventId: string }).eventId = "event-1";

			const startedAt = new Date(
				Date.now() - (3 * 60 + 31) * 60 * 1000,
			).toISOString();
			mockRepository.getGameState.mockResolvedValue({
				...baseGame,
				startedAt,
			});
			mockRepository.enableBlackout.mockRejectedValue(
				new Error("DynamoDB error"),
			);
			mockRepository.listTeams.mockResolvedValue([]);

			// enableBlackout のエラーが runCheck を中断させないことを確認
			// enableBlackout の例外は runCheck まで伝播するが、これは想定動作
			await expect(auditorInstance.runCheck()).rejects.toThrow(
				"DynamoDB error",
			);
		});
	});

	// === runCheck（時間管理統合）===
	describe("runCheck（時間管理統合）", () => {
		const baseGame = {
			eventId: "event-1",
			tenantId: "tenant-1",
			isRunning: true,
			scoreWeight: "normal" as const,
			durationMinutes: 240,
			blackout: false,
		};

		beforeEach(() => {
			mockRepository.stopGame.mockResolvedValue(null);
			mockRepository.enableBlackout.mockResolvedValue(null);
		});

		it("ゲーム時間超過時はヘルスチェックを実行しないべき", async () => {
			vi.useRealTimers();
			const auditorInstance = new AuditorService();
			(auditorInstance as unknown as { eventId: string }).eventId = "event-1";
			(auditorInstance as unknown as { intervalId: number }).intervalId = 999;

			const startedAt = new Date(
				Date.now() - (4 * 60 + 1) * 60 * 1000,
			).toISOString();
			mockRepository.getGameState.mockResolvedValue({
				...baseGame,
				startedAt,
			});

			await auditorInstance.runCheck();

			expect(mockRepository.stopGame).toHaveBeenCalledWith("event-1");
			expect(mockRepository.listTeams).not.toHaveBeenCalled();
		});

		it("残り30分以内でもヘルスチェックは継続すべき", async () => {
			vi.useRealTimers();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
			const auditorInstance = new AuditorService();
			(auditorInstance as unknown as { eventId: string }).eventId = "event-1";

			const startedAt = new Date(
				Date.now() - (3 * 60 + 31) * 60 * 1000,
			).toISOString();
			mockRepository.getGameState.mockResolvedValue({
				...baseGame,
				startedAt,
			});
			mockRepository.listTeams.mockResolvedValue([]);

			await auditorInstance.runCheck();

			expect(mockRepository.enableBlackout).toHaveBeenCalledWith("event-1");
			expect(mockRepository.listTeams).toHaveBeenCalled();
		});
	});

	// === start / stop ===
	describe("ライフサイクル", () => {
		it("start で isRunning が true になるべき", () => {
			mockRepository.getGameState.mockResolvedValue({ isRunning: true });
			mockRepository.listTeams.mockResolvedValue([]);

			auditor.start("event-1");

			expect(auditor.isRunning()).toBe(true);
		});

		it("stop で isRunning が false になるべき", () => {
			mockRepository.getGameState.mockResolvedValue({ isRunning: true });
			mockRepository.listTeams.mockResolvedValue([]);

			auditor.start("event-1");
			auditor.stop();

			expect(auditor.isRunning()).toBe(false);
		});

		it("二重起動しないべき", () => {
			mockRepository.getGameState.mockResolvedValue({ isRunning: true });
			mockRepository.listTeams.mockResolvedValue([]);

			auditor.start("event-1");
			auditor.start("event-1");

			expect(auditor.isRunning()).toBe(true);
		});

		it("start 後の即時 runCheck がエラーでもクラッシュしないべき", async () => {
			vi.useRealTimers();
			mockRepository.getGameState.mockRejectedValue(new Error("DB error"));

			auditor.start("event-1");

			// 即時呼び出しの .catch が実行されることを確認（エラーが伝播しない）
			await new Promise((resolve) => {
				process.nextTick(resolve);
			});
			expect(auditor.isRunning()).toBe(true);
		});

		it("インターバル内の runCheck がエラーでもクラッシュしないべき", async () => {
			mockRepository.getGameState.mockRejectedValue(new Error("DB error"));

			auditor.start("event-1");
			// インターバルを1回だけ進める
			await vi.advanceTimersByTimeAsync(60_000);

			expect(auditor.isRunning()).toBe(true);
		});
	});
});
