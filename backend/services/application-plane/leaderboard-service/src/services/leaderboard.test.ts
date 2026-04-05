import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Battle, BattleParticipant } from "@tenkacloud/dynamodb";
import { BattleRepository } from "@tenkacloud/dynamodb";
import {
	isLeaderboardFrozen,
	buildLeaderboard,
	getLeaderboard,
} from "./leaderboard";

vi.mock("@tenkacloud/dynamodb", async () => {
	const actual = await vi.importActual("@tenkacloud/dynamodb");
	return {
		...actual,
		BattleRepository: vi.fn().mockImplementation(() => ({
			findByIdAndTenant: vi.fn(),
			listParticipants: vi.fn(),
		})),
	};
});

function createBattle(overrides: Partial<Battle> = {}): Battle {
	return {
		id: "battle-1",
		tenantId: "tenant-1",
		title: "テストバトル",
		mode: "INDIVIDUAL",
		status: "RUNNING",
		maxParticipants: 10,
		timeLimit: 3600,
		startedAt: new Date("2025-01-01T10:00:00Z"),
		createdAt: new Date("2025-01-01T09:00:00Z"),
		updatedAt: new Date("2025-01-01T10:00:00Z"),
		...overrides,
	};
}

function createParticipant(
	overrides: Partial<BattleParticipant> = {},
): BattleParticipant {
	return {
		id: "part-1",
		battleId: "battle-1",
		userId: "user-1",
		score: 100,
		joinedAt: new Date("2025-01-01T10:00:00Z"),
		...overrides,
	};
}

describe("isLeaderboardFrozen", () => {
	it("RUNNINGバトルでフリーズ時間内の場合はtrueを返すべき", () => {
		const battle = createBattle({
			startedAt: new Date("2025-01-01T10:00:00Z"),
			timeLimit: 3600,
		});
		// バトル終了予定: 11:00:00、フリーズ開始: 10:50:00
		const now = new Date("2025-01-01T10:55:00Z");

		expect(isLeaderboardFrozen(battle, 10, now)).toBe(true);
	});

	it("RUNNINGバトルでフリーズ時間前の場合はfalseを返すべき", () => {
		const battle = createBattle({
			startedAt: new Date("2025-01-01T10:00:00Z"),
			timeLimit: 3600,
		});
		const now = new Date("2025-01-01T10:30:00Z");

		expect(isLeaderboardFrozen(battle, 10, now)).toBe(false);
	});

	it("RUNNING以外のステータスの場合はfalseを返すべき", () => {
		const battle = createBattle({ status: "FINISHED" });
		const now = new Date("2025-01-01T10:55:00Z");

		expect(isLeaderboardFrozen(battle, 10, now)).toBe(false);
	});

	it("startedAtがない場合はfalseを返すべき", () => {
		const battle = createBattle({ startedAt: undefined });
		const now = new Date("2025-01-01T10:55:00Z");

		expect(isLeaderboardFrozen(battle, 10, now)).toBe(false);
	});

	it("フリーズ時間が0の場合はバトル終了時刻ちょうどでtrueを返すべき", () => {
		const battle = createBattle({
			startedAt: new Date("2025-01-01T10:00:00Z"),
			timeLimit: 3600,
		});
		const now = new Date("2025-01-01T11:00:00Z");

		expect(isLeaderboardFrozen(battle, 0, now)).toBe(true);
	});

	it("デフォルトのフリーズ時間（10分）を使用するべき", () => {
		const battle = createBattle({
			startedAt: new Date("2025-01-01T10:00:00Z"),
			timeLimit: 3600,
		});
		// 10:51 → 終了9分前 → デフォルト10分フリーズ → フリーズ中
		const now = new Date("2025-01-01T10:51:00Z");

		expect(isLeaderboardFrozen(battle, undefined, now)).toBe(true);
	});

	it("DRAFTステータスの場合はfalseを返すべき", () => {
		const battle = createBattle({ status: "DRAFT" });
		expect(isLeaderboardFrozen(battle)).toBe(false);
	});

	it("OPENステータスの場合はfalseを返すべき", () => {
		const battle = createBattle({ status: "OPEN" });
		expect(isLeaderboardFrozen(battle)).toBe(false);
	});

	it("ARCHIVEDステータスの場合はfalseを返すべき", () => {
		const battle = createBattle({ status: "ARCHIVED" });
		expect(isLeaderboardFrozen(battle)).toBe(false);
	});
});

describe("buildLeaderboard", () => {
	it("スコア降順でランキングを構築するべき", () => {
		const participants = [
			createParticipant({ userId: "user-1", score: 50 }),
			createParticipant({ userId: "user-2", score: 100 }),
			createParticipant({ userId: "user-3", score: 75 }),
		];

		const entries = buildLeaderboard(participants);

		expect(entries).toHaveLength(3);
		expect(entries[0]).toEqual(
			expect.objectContaining({ rank: 1, userId: "user-2", score: 100 }),
		);
		expect(entries[1]).toEqual(
			expect.objectContaining({ rank: 2, userId: "user-3", score: 75 }),
		);
		expect(entries[2]).toEqual(
			expect.objectContaining({ rank: 3, userId: "user-1", score: 50 }),
		);
	});

	it("同点の場合は参加時刻が早い方を上位にするべき", () => {
		const participants = [
			createParticipant({
				userId: "user-1",
				score: 100,
				joinedAt: new Date("2025-01-01T10:05:00Z"),
			}),
			createParticipant({
				userId: "user-2",
				score: 100,
				joinedAt: new Date("2025-01-01T10:00:00Z"),
			}),
		];

		const entries = buildLeaderboard(participants);

		expect(entries[0].userId).toBe("user-2");
		expect(entries[1].userId).toBe("user-1");
	});

	it("退出済み参加者を除外するべき", () => {
		const participants = [
			createParticipant({ userId: "user-1", score: 100 }),
			createParticipant({
				userId: "user-2",
				score: 200,
				leftAt: new Date("2025-01-01T10:30:00Z"),
			}),
		];

		const entries = buildLeaderboard(participants);

		expect(entries).toHaveLength(1);
		expect(entries[0].userId).toBe("user-1");
	});

	it("参加者がいない場合は空配列を返すべき", () => {
		const entries = buildLeaderboard([]);
		expect(entries).toEqual([]);
	});

	it("全員退出済みの場合は空配列を返すべき", () => {
		const participants = [
			createParticipant({
				userId: "user-1",
				leftAt: new Date("2025-01-01T10:30:00Z"),
			}),
		];

		const entries = buildLeaderboard(participants);
		expect(entries).toEqual([]);
	});
});

describe("getLeaderboard", () => {
	let repository: InstanceType<typeof BattleRepository>;

	beforeEach(() => {
		vi.clearAllMocks();
		repository = new BattleRepository();
	});

	it("RUNNINGバトルのリーダーボードを返すべき", async () => {
		const battle = createBattle();
		const participants = [
			createParticipant({ userId: "user-1", score: 100 }),
			createParticipant({ userId: "user-2", score: 200 }),
		];

		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);
		vi.mocked(repository.listParticipants).mockResolvedValue(participants);

		const result = await getLeaderboard("battle-1", "tenant-1", repository);

		expect(result).not.toBeNull();
		expect(result!.battleId).toBe("battle-1");
		expect(result!.battleTitle).toBe("テストバトル");
		expect(result!.status).toBe("RUNNING");
		expect(result!.entries).toHaveLength(2);
		expect(result!.entries[0].userId).toBe("user-2");
	});

	it("バトルが見つからない場合はnullを返すべき", async () => {
		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(null);

		const result = await getLeaderboard("battle-1", "tenant-1", repository);

		expect(result).toBeNull();
	});

	it("DRAFTバトルの場合は空のエントリを返すべき", async () => {
		const battle = createBattle({ status: "DRAFT" });
		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);

		const result = await getLeaderboard("battle-1", "tenant-1", repository);

		expect(result).not.toBeNull();
		expect(result!.entries).toEqual([]);
		expect(result!.frozen).toBe(false);
		expect(result!.status).toBe("DRAFT");
	});

	it("OPENバトルの場合は空のエントリを返すべき", async () => {
		const battle = createBattle({ status: "OPEN" });
		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);

		const result = await getLeaderboard("battle-1", "tenant-1", repository);

		expect(result).not.toBeNull();
		expect(result!.entries).toEqual([]);
		expect(result!.frozen).toBe(false);
		expect(result!.status).toBe("OPEN");
	});

	it("FINISHEDバトルのリーダーボードを返すべき", async () => {
		const battle = createBattle({ status: "FINISHED" });
		const participants = [createParticipant({ userId: "user-1", score: 150 })];

		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);
		vi.mocked(repository.listParticipants).mockResolvedValue(participants);

		const result = await getLeaderboard("battle-1", "tenant-1", repository);

		expect(result).not.toBeNull();
		expect(result!.status).toBe("FINISHED");
		expect(result!.frozen).toBe(false);
		expect(result!.entries).toHaveLength(1);
	});

	it("ARCHIVEDバトルのリーダーボードを返すべき", async () => {
		const battle = createBattle({ status: "ARCHIVED" });
		const participants = [createParticipant({ userId: "user-1", score: 150 })];

		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);
		vi.mocked(repository.listParticipants).mockResolvedValue(participants);

		const result = await getLeaderboard("battle-1", "tenant-1", repository);

		expect(result).not.toBeNull();
		expect(result!.status).toBe("ARCHIVED");
		expect(result!.entries).toHaveLength(1);
	});

	it("カスタムfreezeMinutesを使用するべき", async () => {
		const battle = createBattle({
			startedAt: new Date("2025-01-01T10:00:00Z"),
			timeLimit: 3600,
		});
		const participants = [createParticipant({ userId: "user-1", score: 100 })];

		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);
		vi.mocked(repository.listParticipants).mockResolvedValue(participants);

		const result = await getLeaderboard("battle-1", "tenant-1", repository, 30);

		expect(result).not.toBeNull();
		expect(result!.battleId).toBe("battle-1");
		expect(repository.findByIdAndTenant).toHaveBeenCalledWith(
			"battle-1",
			"tenant-1",
		);
	});

	it("DRAFTバトルではlistParticipantsを呼ばないべき", async () => {
		const battle = createBattle({ status: "DRAFT" });
		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);

		await getLeaderboard("battle-1", "tenant-1", repository);

		expect(repository.listParticipants).not.toHaveBeenCalled();
	});

	it("OPENバトルではlistParticipantsを呼ばないべき", async () => {
		const battle = createBattle({ status: "OPEN" });
		vi.mocked(repository.findByIdAndTenant).mockResolvedValue(battle);

		await getLeaderboard("battle-1", "tenant-1", repository);

		expect(repository.listParticipants).not.toHaveBeenCalled();
	});
});
