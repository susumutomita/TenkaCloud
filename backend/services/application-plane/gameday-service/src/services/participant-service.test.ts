import { describe, it, expect, vi, beforeEach } from "vitest";
import { POINT_ECONOMY } from "@tenkacloud/dynamodb";

const { mockGamedayRepository } = vi.hoisted(() => ({
	mockGamedayRepository: {
		getGameState: vi.fn(),
		getTeamState: vi.fn(),
		listAttackCatalog: vi.fn(),
		getAttack: vi.fn(),
		seedAttackCatalog: vi.fn(),
		getAttackPurchase: vi.fn(),
		createAttackPurchase: vi.fn(),
		updatePurchaseLastUsedAt: vi.fn(),
		updateTeamScore: vi.fn(),
		updateMultipleTeamScores: vi.fn(),
		getTeamVulnerability: vi.fn(),
		upsertTeamVulnerability: vi.fn(),
		listAttackLogs: vi.fn(),
		addAttackLog: vi.fn(),
		listAlliances: vi.fn(),
		listTeamActiveAlliances: vi.fn(),
		getAlliance: vi.fn(),
		createAlliance: vi.fn(),
		updateAllianceStatus: vi.fn(),
		deleteAlliance: vi.fn(),
		listHealthChecks: vi.fn(),
		castVote: vi.fn(),
		listVotes: vi.fn(),
	},
}));

vi.mock("../lib/dynamodb", () => ({
	gamedayRepository: mockGamedayRepository,
}));

// AttackAlreadyPurchasedError/VoteAlreadyExistsError のモック
const { MockAttackAlreadyPurchasedError, MockVoteAlreadyExistsError } =
	vi.hoisted(() => {
		class MockAttackAlreadyPurchasedError extends Error {
			constructor() {
				super("この攻撃は既に購入済みです");
				this.name = "AttackAlreadyPurchasedError";
			}
		}
		class MockVoteAlreadyExistsError extends Error {
			constructor() {
				super("既に投票済みです");
				this.name = "VoteAlreadyExistsError";
			}
		}
		return { MockAttackAlreadyPurchasedError, MockVoteAlreadyExistsError };
	});

vi.mock("../repositories/gameday-repository", () => ({
	AttackAlreadyPurchasedError: MockAttackAlreadyPurchasedError,
	VoteAlreadyExistsError: MockVoteAlreadyExistsError,
}));

import {
	getAttackCatalog,
	purchaseAttack,
	executeAttack,
	getAttackHistory,
	getActiveAttacks,
	purchaseHint,
	reportFix,
	listTeamAlliances,
	requestAlliance,
	acceptAlliance,
	breakAlliance,
	getMonitoringStatus,
	castVote,
	getVotingResults,
	GameNotRunningError,
	AttackNotFoundError,
	AttackNotPurchasedError,
	CooldownActiveError,
	SelfAttackError,
	InsufficientScoreError,
	TeamNotFoundError,
	AllianceNotFoundError,
	AllianceUnauthorizedError,
	SelfVoteError,
	VOTE_BONUS_POINTS,
} from "./participant-service";

const runningGame = {
	eventId: "event-1",
	tenantId: "tenant-1",
	isRunning: true,
	startedAt: "2026-03-09T00:00:00.000Z",
	scoreWeight: "normal" as const,
	blackout: false,
	durationMinutes: 240,
};

const stoppedGame = { ...runningGame, isRunning: false };

const sampleAttack = {
	id: "atk-1",
	name: "SQL Injection",
	slug: "sql-injection",
	attackType: "vulnerability" as const,
	targetVulnerability: "sql-injection",
	description: "SQL Injection攻撃",
	purchaseCost: 3000,
	damage: 1000,
	reward: 1000,
	cooldownSeconds: 300,
	defenseHint: "パラメータ化クエリを使う",
	hintCost: 0,
};

const sampleTeam = {
	eventId: "event-1",
	teamId: "team-1",
	teamName: "チームA",
	score: 10000,
	isHealthy: true,
};

describe("プレーヤーサービス", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// === 攻撃カタログ ===
	describe("getAttackCatalog", () => {
		it("攻撃カタログを返すべき", async () => {
			mockGamedayRepository.listAttackCatalog.mockResolvedValue([sampleAttack]);
			const result = await getAttackCatalog("event-1");
			expect(result).toEqual([sampleAttack]);
		});
	});

	// === 攻撃購入 ===
	describe("purchaseAttack", () => {
		describe("正常系", () => {
			it("攻撃を購入しスコアを減算すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getTeamState.mockResolvedValue(sampleTeam);
				const purchase = {
					id: "p-1",
					eventId: "event-1",
					teamId: "team-1",
					attackId: "atk-1",
					attackSlug: "sql-injection",
					purchasedAt: "2026-03-09T00:00:00.000Z",
					lastUsedAt: null,
				};
				mockGamedayRepository.createAttackPurchase.mockResolvedValue(purchase);
				mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);

				const result = await purchaseAttack(
					"event-1",
					"team-1",
					"sql-injection",
				);

				expect(result).toEqual(purchase);
				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
					"event-1",
					"team-1",
					-3000,
				);
			});
		});

		describe("ゲームが開始されていない場合", () => {
			it("GameNotRunningError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(stoppedGame);
				await expect(
					purchaseAttack("event-1", "team-1", "sql-injection"),
				).rejects.toThrow(GameNotRunningError);
			});
		});

		describe("ゲームが存在しない場合", () => {
			it("GameNotRunningError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(null);
				await expect(
					purchaseAttack("event-1", "team-1", "sql-injection"),
				).rejects.toThrow(GameNotRunningError);
			});
		});

		describe("攻撃が見つからない場合", () => {
			it("AttackNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(null);
				await expect(
					purchaseAttack("event-1", "team-1", "nonexistent"),
				).rejects.toThrow(AttackNotFoundError);
			});
		});

		describe("チームが見つからない場合", () => {
			it("TeamNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getTeamState.mockResolvedValue(null);
				await expect(
					purchaseAttack("event-1", "team-1", "sql-injection"),
				).rejects.toThrow(TeamNotFoundError);
			});
		});

		describe("スコアが不足している場合", () => {
			it("InsufficientScoreError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					score: 100,
				});
				await expect(
					purchaseAttack("event-1", "team-1", "sql-injection"),
				).rejects.toThrow(InsufficientScoreError);
			});
		});
	});

	// === 攻撃実行 ===
	describe("executeAttack", () => {
		describe("正常系（攻撃成功）", () => {
			it("ダメージと報酬を原子的に適用すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: null,
				});
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					teamId: "team-2",
				});
				mockGamedayRepository.getTeamVulnerability.mockResolvedValue(null);
				mockGamedayRepository.updatePurchaseLastUsedAt.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.updateMultipleTeamScores.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.listTeamActiveAlliances.mockResolvedValue([]);
				const attackLog = {
					id: "log-1",
					success: true,
					damage: 1000,
					reward: 1000,
				};
				mockGamedayRepository.addAttackLog.mockResolvedValue(attackLog);

				const result = await executeAttack(
					"event-1",
					"team-1",
					"team-2",
					"sql-injection",
				);

				expect(result).toEqual(attackLog);
				expect(
					mockGamedayRepository.updateMultipleTeamScores,
				).toHaveBeenCalledWith("event-1", [
					{ teamId: "team-2", delta: -1000 },
					{ teamId: "team-1", delta: 1000 },
				]);
			});
		});

		describe("攻撃成功時に同盟がある場合（攻撃者がリクエスター）", () => {
			it("報酬を同盟メンバーと原子的に分配すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: null,
				});
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					teamId: "team-2",
				});
				mockGamedayRepository.getTeamVulnerability.mockResolvedValue(null);
				mockGamedayRepository.updatePurchaseLastUsedAt.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.updateMultipleTeamScores.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.listTeamActiveAlliances.mockResolvedValue([
					{
						id: "a-1",
						eventId: "event-1",
						requesterTeamId: "team-1",
						targetTeamId: "team-3",
						status: "ACTIVE",
					},
				]);
				mockGamedayRepository.addAttackLog.mockResolvedValue({
					id: "log-1",
					success: true,
				});

				await executeAttack("event-1", "team-1", "team-2", "sql-injection");

				// 1000 / 2 = 500 per member, remainder 0
				expect(
					mockGamedayRepository.updateMultipleTeamScores,
				).toHaveBeenCalledWith("event-1", [
					{ teamId: "team-2", delta: -1000 },
					{ teamId: "team-1", delta: 500 },
					{ teamId: "team-3", delta: 500 },
				]);
			});
		});

		describe("攻撃成功時に同盟がある場合（攻撃者がターゲット）", () => {
			it("報酬を同盟メンバーと原子的に分配すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: null,
				});
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					teamId: "team-2",
				});
				mockGamedayRepository.getTeamVulnerability.mockResolvedValue(null);
				mockGamedayRepository.updatePurchaseLastUsedAt.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.updateMultipleTeamScores.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.listTeamActiveAlliances.mockResolvedValue([
					{
						id: "a-1",
						eventId: "event-1",
						requesterTeamId: "team-3",
						targetTeamId: "team-1",
						status: "ACTIVE",
					},
				]);
				mockGamedayRepository.addAttackLog.mockResolvedValue({
					id: "log-1",
					success: true,
				});

				await executeAttack("event-1", "team-1", "team-2", "sql-injection");

				// 1000 / 2 = 500 per member, remainder 0
				expect(
					mockGamedayRepository.updateMultipleTeamScores,
				).toHaveBeenCalledWith("event-1", [
					{ teamId: "team-2", delta: -1000 },
					{ teamId: "team-1", delta: 500 },
					{ teamId: "team-3", delta: 500 },
				]);
			});
		});

		describe("攻撃成功時に同盟が2つある場合（端数処理）", () => {
			it("端数を攻撃者に付与すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: null,
				});
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					teamId: "team-2",
				});
				mockGamedayRepository.getTeamVulnerability.mockResolvedValue(null);
				mockGamedayRepository.updatePurchaseLastUsedAt.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.updateMultipleTeamScores.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.listTeamActiveAlliances.mockResolvedValue([
					{
						id: "a-1",
						eventId: "event-1",
						requesterTeamId: "team-1",
						targetTeamId: "team-3",
						status: "ACTIVE",
					},
					{
						id: "a-2",
						eventId: "event-1",
						requesterTeamId: "team-4",
						targetTeamId: "team-1",
						status: "ACTIVE",
					},
				]);
				mockGamedayRepository.addAttackLog.mockResolvedValue({
					id: "log-1",
					success: true,
				});

				await executeAttack("event-1", "team-1", "team-2", "sql-injection");

				// 1000 / 3 = 333, remainder = 1 → 攻撃者に付与
				expect(
					mockGamedayRepository.updateMultipleTeamScores,
				).toHaveBeenCalledWith("event-1", [
					{ teamId: "team-2", delta: -1000 },
					{ teamId: "team-1", delta: 334 },
					{ teamId: "team-3", delta: 333 },
					{ teamId: "team-4", delta: 333 },
				]);
			});
		});

		describe("脆弱性が修正済みの場合", () => {
			it("攻撃が防御され被害者に報酬を付与すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: null,
				});
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					teamId: "team-2",
				});
				mockGamedayRepository.getTeamVulnerability.mockResolvedValue({
					isFixed: true,
				});
				mockGamedayRepository.updatePurchaseLastUsedAt.mockResolvedValue(
					undefined,
				);
				mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);
				mockGamedayRepository.addAttackLog.mockResolvedValue({
					id: "log-1",
					success: false,
				});

				const result = await executeAttack(
					"event-1",
					"team-1",
					"team-2",
					"sql-injection",
				);

				expect(result.success).toBe(false);
				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
					"event-1",
					"team-2",
					1000,
				);
			});
		});

		describe("自チーム攻撃の場合", () => {
			it("SelfAttackError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				await expect(
					executeAttack("event-1", "team-1", "team-1", "sql-injection"),
				).rejects.toThrow(SelfAttackError);
			});
		});

		describe("攻撃が見つからない場合", () => {
			it("AttackNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(null);
				await expect(
					executeAttack("event-1", "team-1", "team-2", "nonexistent"),
				).rejects.toThrow(AttackNotFoundError);
			});
		});

		describe("未購入攻撃の場合", () => {
			it("AttackNotPurchasedError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue(null);
				await expect(
					executeAttack("event-1", "team-1", "team-2", "sql-injection"),
				).rejects.toThrow(AttackNotPurchasedError);
			});
		});

		describe("クールダウン中の場合", () => {
			it("CooldownActiveError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: new Date().toISOString(), // 今使ったばかり
				});
				await expect(
					executeAttack("event-1", "team-1", "team-2", "sql-injection"),
				).rejects.toThrow(CooldownActiveError);
			});
		});

		describe("ターゲットチームが見つからない場合", () => {
			it("TeamNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);
				mockGamedayRepository.getAttackPurchase.mockResolvedValue({
					id: "p-1",
					lastUsedAt: null,
				});
				mockGamedayRepository.getTeamState.mockResolvedValue(null);
				await expect(
					executeAttack("event-1", "team-1", "team-2", "sql-injection"),
				).rejects.toThrow(TeamNotFoundError);
			});
		});
	});

	// === 攻撃履歴 ===
	describe("getAttackHistory", () => {
		it("自チームの攻撃履歴のみ返すべき", async () => {
			mockGamedayRepository.listAttackLogs.mockResolvedValue([
				{ attackerTeamId: "team-1", defenderTeamId: "team-2" },
				{ attackerTeamId: "team-2", defenderTeamId: "team-1" },
			]);
			const result = await getAttackHistory("event-1", "team-1");
			expect(result).toHaveLength(1);
			expect(result[0].attackerTeamId).toBe("team-1");
		});
	});

	// === 被攻撃一覧 ===
	describe("getActiveAttacks", () => {
		it("自チームへの成功かつ未無効化攻撃のみ返すべき", async () => {
			mockGamedayRepository.listAttackLogs.mockResolvedValue([
				{
					defenderTeamId: "team-1",
					success: true,
					neutralized: false,
				},
				{
					defenderTeamId: "team-1",
					success: false,
					neutralized: false,
				},
				{
					defenderTeamId: "team-1",
					success: true,
					neutralized: true,
				},
				{
					defenderTeamId: "team-2",
					success: true,
					neutralized: false,
				},
			]);
			const result = await getActiveAttacks("event-1", "team-1");
			expect(result).toHaveLength(1);
		});
	});

	// === ヒント購入 ===
	describe("purchaseHint", () => {
		describe("無料ヒントの場合", () => {
			it("スコア減算なしでヒントを返すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(sampleAttack);

				const result = await purchaseHint("event-1", "team-1", "sql-injection");

				expect(result.hint).toBe("パラメータ化クエリを使う");
				expect(result.cost).toBe(0);
				expect(mockGamedayRepository.updateTeamScore).not.toHaveBeenCalled();
			});
		});

		describe("有料ヒントの場合", () => {
			it("スコアを減算してヒントを返すべき", async () => {
				const paidAttack = { ...sampleAttack, hintCost: 3000 };
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(paidAttack);
				mockGamedayRepository.getTeamState.mockResolvedValue(sampleTeam);
				mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);

				const result = await purchaseHint("event-1", "team-1", "sql-injection");

				expect(result.cost).toBe(3000);
				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
					"event-1",
					"team-1",
					-3000,
				);
			});
		});

		describe("スコア不足の場合", () => {
			it("InsufficientScoreError を投げるべき", async () => {
				const paidAttack = { ...sampleAttack, hintCost: 3000 };
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(paidAttack);
				mockGamedayRepository.getTeamState.mockResolvedValue({
					...sampleTeam,
					score: 100,
				});
				await expect(
					purchaseHint("event-1", "team-1", "sql-injection"),
				).rejects.toThrow(InsufficientScoreError);
			});
		});

		describe("攻撃が見つからない場合", () => {
			it("AttackNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(null);
				await expect(
					purchaseHint("event-1", "team-1", "nonexistent"),
				).rejects.toThrow(AttackNotFoundError);
			});
		});

		describe("有料ヒントでチームが見つからない場合", () => {
			it("TeamNotFoundError を投げるべき", async () => {
				const paidAttack = { ...sampleAttack, hintCost: 3000 };
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAttack.mockResolvedValue(paidAttack);
				mockGamedayRepository.getTeamState.mockResolvedValue(null);
				await expect(
					purchaseHint("event-1", "team-1", "sql-injection"),
				).rejects.toThrow(TeamNotFoundError);
			});
		});
	});

	// === 脆弱性修正報告 ===
	describe("reportFix", () => {
		it("脆弱性修正報告を登録すべき", async () => {
			mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
			const vuln = {
				id: "v-1",
				eventId: "event-1",
				teamId: "team-1",
				vulnerabilitySlug: "sql-injection",
				isFixed: true,
			};
			mockGamedayRepository.upsertTeamVulnerability.mockResolvedValue(vuln);
			mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);

			const result = await reportFix("event-1", "team-1", "sql-injection");

			expect(result).toEqual(vuln);
		});

		it("防御修正で ADR-003 準拠のポイントを付与すべき", async () => {
			mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
			const vuln = {
				id: "v-1",
				eventId: "event-1",
				teamId: "team-1",
				vulnerabilitySlug: "sql-injection",
				isFixed: true,
			};
			mockGamedayRepository.upsertTeamVulnerability.mockResolvedValue(vuln);
			mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);

			await reportFix("event-1", "team-1", "sql-injection");

			expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
				"event-1",
				"team-1",
				POINT_ECONOMY.DEFENSE_FIX,
			);
		});
	});

	// === 同盟 ===
	describe("listTeamAlliances", () => {
		it("自チームに関連する同盟のみ返すべき", async () => {
			mockGamedayRepository.listAlliances.mockResolvedValue([
				{ requesterTeamId: "team-1", targetTeamId: "team-2" },
				{ requesterTeamId: "team-3", targetTeamId: "team-1" },
				{ requesterTeamId: "team-2", targetTeamId: "team-3" },
			]);
			const result = await listTeamAlliances("event-1", "team-1");
			expect(result).toHaveLength(2);
		});
	});

	describe("requestAlliance", () => {
		it("同盟申請を作成すべき", async () => {
			mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
			const alliance = {
				id: "a-1",
				eventId: "event-1",
				requesterTeamId: "team-1",
				targetTeamId: "team-2",
				status: "PENDING",
			};
			mockGamedayRepository.createAlliance.mockResolvedValue(alliance);

			const result = await requestAlliance("event-1", "team-1", "team-2");

			expect(result).toEqual(alliance);
		});
	});

	describe("acceptAlliance", () => {
		describe("正常系", () => {
			it("同盟を承認すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAlliance.mockResolvedValue({
					id: "a-1",
					eventId: "event-1",
					requesterTeamId: "team-1",
					targetTeamId: "team-2",
					status: "PENDING",
					updatedAt: "2026-03-09T00:00:00.000Z",
				});
				mockGamedayRepository.updateAllianceStatus.mockResolvedValue(undefined);

				const result = await acceptAlliance("event-1", "a-1", "team-2");

				expect(result.status).toBe("ACTIVE");
			});
		});

		describe("同盟が見つからない場合", () => {
			it("AllianceNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAlliance.mockResolvedValue(null);
				await expect(
					acceptAlliance("event-1", "a-1", "team-2"),
				).rejects.toThrow(AllianceNotFoundError);
			});
		});

		describe("権限がない場合", () => {
			it("AllianceUnauthorizedError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAlliance.mockResolvedValue({
					id: "a-1",
					targetTeamId: "team-3", // team-2 ではない
				});
				await expect(
					acceptAlliance("event-1", "a-1", "team-2"),
				).rejects.toThrow(AllianceUnauthorizedError);
			});
		});
	});

	describe("breakAlliance", () => {
		describe("正常系", () => {
			it("同盟を破棄すべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAlliance.mockResolvedValue({
					id: "a-1",
					requesterTeamId: "team-1",
					targetTeamId: "team-2",
				});
				mockGamedayRepository.deleteAlliance.mockResolvedValue(undefined);

				await breakAlliance("event-1", "a-1", "team-1");

				expect(mockGamedayRepository.deleteAlliance).toHaveBeenCalledWith(
					"event-1",
					"a-1",
				);
			});
		});

		describe("同盟が見つからない場合", () => {
			it("AllianceNotFoundError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAlliance.mockResolvedValue(null);
				await expect(breakAlliance("event-1", "a-1", "team-1")).rejects.toThrow(
					AllianceNotFoundError,
				);
			});
		});

		describe("権限がない場合", () => {
			it("AllianceUnauthorizedError を投げるべき", async () => {
				mockGamedayRepository.getGameState.mockResolvedValue(runningGame);
				mockGamedayRepository.getAlliance.mockResolvedValue({
					id: "a-1",
					requesterTeamId: "team-3",
					targetTeamId: "team-4",
				});
				await expect(breakAlliance("event-1", "a-1", "team-1")).rejects.toThrow(
					AllianceUnauthorizedError,
				);
			});
		});
	});

	// === モニタリング ===
	describe("getMonitoringStatus", () => {
		it("ヘルスチェック結果を返すべき", async () => {
			const checks = [{ id: "hc-1", isHealthy: true }];
			mockGamedayRepository.listHealthChecks.mockResolvedValue(checks);

			const result = await getMonitoringStatus("event-1", "team-1");

			expect(result).toEqual(checks);
		});
	});

	// === 投票 ===
	describe("castVote", () => {
		describe("正常系", () => {
			it("投票して投票先にVOTE_BONUS_POINTS付与すべき", async () => {
				const vote = {
					id: "v-1",
					eventId: "event-1",
					voterTeamId: "team-1",
					votedForTeamId: "team-2",
				};
				mockGamedayRepository.castVote.mockResolvedValue(vote);
				mockGamedayRepository.updateTeamScore.mockResolvedValue(undefined);

				const result = await castVote("event-1", "team-1", "team-2");

				expect(result).toEqual(vote);
				expect(mockGamedayRepository.updateTeamScore).toHaveBeenCalledWith(
					"event-1",
					"team-2",
					VOTE_BONUS_POINTS,
				);
			});
		});

		describe("自チーム投票の場合", () => {
			it("SelfVoteError を投げるべき", async () => {
				await expect(castVote("event-1", "team-1", "team-1")).rejects.toThrow(
					SelfVoteError,
				);
			});
		});
	});

	describe("getVotingResults", () => {
		it("得票数で降順ソートした結果を返すべき", async () => {
			mockGamedayRepository.listVotes.mockResolvedValue([
				{ votedForTeamId: "team-2" },
				{ votedForTeamId: "team-1" },
				{ votedForTeamId: "team-2" },
				{ votedForTeamId: "team-3" },
				{ votedForTeamId: "team-2" },
			]);

			const result = await getVotingResults("event-1");

			expect(result).toEqual([
				{ teamId: "team-2", votes: 3 },
				{ teamId: "team-1", votes: 1 },
				{ teamId: "team-3", votes: 1 },
			]);
		});

		it("投票がない場合は空配列を返すべき", async () => {
			mockGamedayRepository.listVotes.mockResolvedValue([]);
			const result = await getVotingResults("event-1");
			expect(result).toEqual([]);
		});
	});
});
