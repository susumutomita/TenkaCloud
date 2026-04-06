import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameState, AttackLog } from "../types";
import { POINT_ECONOMY } from "@tenkacloud/dynamodb";

const { mockGamedayRepository } = vi.hoisted(() => ({
	mockGamedayRepository: {
		createGameState: vi.fn(),
		initGameState: vi.fn(),
		getGameState: vi.fn(),
		stopGame: vi.fn(),
		toggleScoreWeight: vi.fn(),
		toggleBlackout: vi.fn(),
		addAttackLog: vi.fn(),
		listAttackLogs: vi.fn(),
		listTeams: vi.fn(),
		getTeamState: vi.fn(),
		seedAttackCatalog: vi.fn(),
		updateTeamScore: vi.fn(),
	},
}));

vi.mock("../lib/dynamodb", () => ({
	gamedayRepository: mockGamedayRepository,
}));

import {
	initGame,
	startGame,
	stopGame,
	getGameStatus,
	toggleScoreWeight,
	toggleBlackout,
	executeFaultInjection,
	listTeams,
	listAttackLogs,
	seedAttackCatalog,
	GameNotFoundError,
	CrossTenantAccessError,
} from "./game-controller";

const TENANT_ID = "tenant-1";
const OTHER_TENANT_ID = "tenant-other";

const baseGameState: GameState = {
	eventId: "event-1",
	tenantId: TENANT_ID,
	isRunning: true,
	startedAt: "2026-03-09T00:00:00.000Z",
	scoreWeight: "normal",
	blackout: false,
	durationMinutes: 240,
};

describe("ゲームコントローラーサービス", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("initGame", () => {
		describe("有効なパラメータの場合", () => {
			it("isRunning: false でゲームを初期化すべき", async () => {
				const initState: GameState = {
					...baseGameState,
					isRunning: false,
					startedAt: null,
				};
				mockGamedayRepository.initGameState.mockResolvedValue(initState);

				const result = await initGame("event-1", TENANT_ID, 240);

				expect(result).toEqual(initState);
				expect(result.isRunning).toBe(false);
				expect(result.startedAt).toBeNull();
				expect(mockGamedayRepository.initGameState).toHaveBeenCalledWith({
					eventId: "event-1",
					tenantId: TENANT_ID,
					durationMinutes: 240,
				});
			});
		});
	});

	describe("startGame", () => {
		describe("有効なパラメータの場合", () => {
			it("新しいゲームを作成して返すべき", async () => {
				mockGamedayRepository.createGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.listTeams.mockResolvedValue([]);

				const result = await startGame("event-1", TENANT_ID, 240);

				expect(result).toEqual(baseGameState);
				expect(mockGamedayRepository.createGameState).toHaveBeenCalledWith({
					eventId: "event-1",
					tenantId: TENANT_ID,
					durationMinutes: 240,
				});
			});

			it("登録済みチームに初期ポイントを付与すべき", async () => {
				const teams = [
					{
						eventId: "event-1",
						teamId: "team-1",
						teamName: "チームA",
						score: 0,
						isHealthy: true,
						websiteUrl: null,
						apiUrl: null,
						inviteCode: "ABC123",
					},
					{
						eventId: "event-1",
						teamId: "team-2",
						teamName: "チームB",
						score: 0,
						isHealthy: true,
						websiteUrl: null,
						apiUrl: null,
						inviteCode: "DEF456",
					},
				];
				mockGamedayRepository.createGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.listTeams.mockResolvedValue(teams);
				mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);

				await startGame("event-1", TENANT_ID, 240);

				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledTimes(2);
				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
					"event-1",
					"team-1",
					POINT_ECONOMY.INITIAL_POINTS,
				);
				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
					"event-1",
					"team-2",
					POINT_ECONOMY.INITIAL_POINTS,
				);
			});

			it("登録チームがいない場合はスコア更新しないべき", async () => {
				mockGamedayRepository.createGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.listTeams.mockResolvedValue([]);

				await startGame("event-1", TENANT_ID, 240);

				expect(mockGamedayRepository.updateTeamScore).not.toHaveBeenCalled();
			});
		});
	});

	describe("stopGame", () => {
		describe("ゲームが存在する場合", () => {
			it("ゲームを停止して返すべき", async () => {
				const expected: GameState = { ...baseGameState, isRunning: false };
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.stopGame.mockResolvedValue(expected);

				const result = await stopGame("event-1", TENANT_ID);

				expect(result).toEqual(expected);
				expect(mockGamedayRepository.stopGame).toHaveBeenCalledWith("event-1");
			});
		});

		describe("ゲームが存在しない場合", () => {
			it("GameNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(null);

				await expect(stopGame("nonexistent", TENANT_ID)).rejects.toThrow(
					GameNotFoundError,
				);
				await expect(stopGame("nonexistent", TENANT_ID)).rejects.toThrow(
					"ゲームが見つかりません",
				);
			});
		});

		describe("リポジトリが null を返す場合", () => {
			it("GameNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.stopGame.mockResolvedValue(null);

				await expect(stopGame("event-1", TENANT_ID)).rejects.toThrow(
					GameNotFoundError,
				);
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(stopGame("event-1", OTHER_TENANT_ID)).rejects.toThrow(
					CrossTenantAccessError,
				);
			});
		});
	});

	describe("getGameStatus", () => {
		describe("ゲームが存在する場合", () => {
			it("ゲーム状態を返すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				const result = await getGameStatus("event-1", TENANT_ID);

				expect(result).toEqual(baseGameState);
			});
		});

		describe("ゲームが存在しない場合", () => {
			it("null を返すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(null);

				const result = await getGameStatus("nonexistent", TENANT_ID);

				expect(result).toBeNull();
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(getGameStatus("event-1", OTHER_TENANT_ID)).rejects.toThrow(
					CrossTenantAccessError,
				);
			});
		});
	});

	describe("toggleScoreWeight", () => {
		describe("ゲームが存在する場合", () => {
			it("切替後のゲーム状態を返すべき", async () => {
				const expected: GameState = {
					...baseGameState,
					scoreWeight: "high",
				};
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.toggleScoreWeight.mockResolvedValue(expected);

				const result = await toggleScoreWeight("event-1", TENANT_ID);

				expect(result).toEqual(expected);
			});
		});

		describe("ゲームが存在しない場合", () => {
			it("GameNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(null);

				await expect(
					toggleScoreWeight("nonexistent", TENANT_ID),
				).rejects.toThrow(GameNotFoundError);
			});
		});

		describe("リポジトリが null を返す場合", () => {
			it("GameNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.toggleScoreWeight.mockResolvedValue(null);

				await expect(
					toggleScoreWeight("event-1", TENANT_ID),
				).rejects.toThrow(GameNotFoundError);
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(
					toggleScoreWeight("event-1", OTHER_TENANT_ID),
				).rejects.toThrow(CrossTenantAccessError);
			});
		});
	});

	describe("toggleBlackout", () => {
		describe("ゲームが存在する場合", () => {
			it("切替後のゲーム状態を返すべき", async () => {
				const expected: GameState = {
					...baseGameState,
					blackout: true,
				};
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.toggleBlackout.mockResolvedValue(expected);

				const result = await toggleBlackout("event-1", TENANT_ID);

				expect(result).toEqual(expected);
			});
		});

		describe("ゲームが存在しない場合", () => {
			it("GameNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(null);

				await expect(toggleBlackout("nonexistent", TENANT_ID)).rejects.toThrow(
					GameNotFoundError,
				);
			});
		});

		describe("リポジトリが null を返す場合", () => {
			it("GameNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.toggleBlackout.mockResolvedValue(null);

				await expect(
					toggleBlackout("event-1", TENANT_ID),
				).rejects.toThrow(GameNotFoundError);
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(
					toggleBlackout("event-1", OTHER_TENANT_ID),
				).rejects.toThrow(CrossTenantAccessError);
			});
		});
	});

	describe("executeFaultInjection", () => {
		describe("有効なパラメータの場合", () => {
			it("管理者として攻撃ログを作成すべき", async () => {
				const expected: AttackLog = {
					id: "log-1",
					eventId: "event-1",
					attackerTeamId: "ADMIN",
					defenderTeamId: "team-1",
					attackId: "sql-injection",
					attackSlug: "sql-injection",
					success: true,
					neutralized: false,
					damage: 0,
					reward: 0,
					details: "管理者による障害注入: sql-injection",
					createdAt: "2026-03-09T00:00:00.000Z",
				};
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.addAttackLog.mockResolvedValue(expected);

				const result = await executeFaultInjection(
					"event-1",
					"team-1",
					"sql-injection",
					TENANT_ID,
				);

				expect(result).toEqual(expected);
				expect(mockGamedayRepository.addAttackLog).toHaveBeenCalledWith({
					eventId: "event-1",
					attackerTeamId: "ADMIN",
					defenderTeamId: "team-1",
					attackId: "sql-injection",
					attackSlug: "sql-injection",
					success: true,
					damage: 0,
					reward: 0,
					details: "管理者による障害注入: sql-injection",
				});
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(
					executeFaultInjection(
						"event-1",
						"team-1",
						"sql-injection",
						OTHER_TENANT_ID,
					),
				).rejects.toThrow(CrossTenantAccessError);
			});
		});
	});

	describe("listTeams", () => {
		describe("チームが存在する場合", () => {
			it("チーム一覧を返すべき", async () => {
				const expected = [
					{
						eventId: "event-1",
						teamId: "team-1",
						teamName: "チームA",
						score: 5000,
						isHealthy: true,
					},
				];
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.listTeams.mockResolvedValue(expected);

				const result = await listTeams("event-1", TENANT_ID);

				expect(result).toEqual(expected);
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(listTeams("event-1", OTHER_TENANT_ID)).rejects.toThrow(
					CrossTenantAccessError,
				);
			});
		});
	});

	describe("listAttackLogs", () => {
		describe("攻撃履歴が存在する場合", () => {
			it("攻撃履歴一覧を返すべき", async () => {
				const expected: AttackLog[] = [
					{
						id: "log-1",
						eventId: "event-1",
						attackerTeamId: "team-1",
						defenderTeamId: "team-2",
						attackId: "atk-1",
						attackSlug: "atk-1",
						success: true,
						neutralized: false,
						damage: 1000,
						reward: 1000,
						details: "",
						createdAt: "2026-03-09T00:00:00.000Z",
					},
				];
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.listAttackLogs.mockResolvedValue(expected);

				const result = await listAttackLogs("event-1", TENANT_ID);

				expect(result).toEqual(expected);
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(
					listAttackLogs("event-1", OTHER_TENANT_ID),
				).rejects.toThrow(CrossTenantAccessError);
			});
		});
	});

	describe("seedAttackCatalog", () => {
		describe("有効なパラメータの場合", () => {
			it("デフォルト攻撃カタログをシードして件数を返すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);
				mockGamedayRepository.seedAttackCatalog.mockResolvedValue(undefined);

				const result = await seedAttackCatalog("event-1", TENANT_ID);

				expect(result).toBe(12);
				expect(mockGamedayRepository.seedAttackCatalog).toHaveBeenCalledWith(
					"event-1",
					expect.arrayContaining([
						expect.objectContaining({ slug: "sql-injection" }),
						expect.objectContaining({ slug: "remote-code-execution" }),
						expect.objectContaining({ slug: "password-rotation" }),
						expect.objectContaining({ slug: "ssrf-attack" }),
						expect.objectContaining({ slug: "leaked-credentials" }),
						expect.objectContaining({ slug: "ha-resilience" }),
					]),
				);
			});
		});

		describe("別テナントのゲームにアクセスした場合", () => {
			it("CrossTenantAccessError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(baseGameState);

				await expect(
					seedAttackCatalog("event-1", OTHER_TENANT_ID),
				).rejects.toThrow(CrossTenantAccessError);
			});
		});
	});
});
