import type { Battle, BattleParticipant } from "@tenkacloud/dynamodb";
import { BattleStatus } from "@tenkacloud/dynamodb";
import type { BattleRepository } from "@tenkacloud/dynamodb";

/**
 * リーダーボードのエントリ
 */
export interface LeaderboardEntry {
	rank: number;
	userId: string;
	score: number;
	updatedAt: Date;
}

/**
 * リーダーボードの取得結果
 */
export interface LeaderboardResult {
	battleId: string;
	battleTitle: string;
	status: string;
	frozen: boolean;
	entries: LeaderboardEntry[];
	updatedAt: Date;
}

const DEFAULT_FREEZE_MINUTES = 10;

/**
 * リーダーボードがフリーズ状態かどうかを判定する
 *
 * バトル終了直前の一定時間（デフォルト10分）はリーダーボードをフリーズする。
 *
 * @param battle - バトル情報
 * @param freezeMinutes - フリーズ開始までの残り時間（分）
 * @param now - 現在時刻
 * @returns フリーズ中の場合は true
 */
export function isLeaderboardFrozen(
	battle: Battle,
	freezeMinutes: number = DEFAULT_FREEZE_MINUTES,
	now: Date = new Date(),
): boolean {
	if (battle.status !== BattleStatus.RUNNING) {
		return false;
	}

	if (!battle.startedAt) {
		return false;
	}

	const expectedEndMs = battle.startedAt.getTime() + battle.timeLimit * 1000;
	const freezeStartMs = expectedEndMs - freezeMinutes * 60 * 1000;

	return now.getTime() >= freezeStartMs;
}

/**
 * 参加者一覧からリーダーボードを構築する
 *
 * 退出済み参加者を除外し、スコア降順（同点は参加順）でソートして順位を付与する。
 *
 * @param participants - バトル参加者一覧
 * @returns ランク付きリーダーボードエントリ
 */
export function buildLeaderboard(
	participants: BattleParticipant[],
): LeaderboardEntry[] {
	const active = participants.filter((p) => !p.leftAt);

	const sorted = [...active].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.joinedAt.getTime() - b.joinedAt.getTime();
	});

	return sorted.map((p, index) => ({
		rank: index + 1,
		userId: p.userId,
		score: p.score,
		updatedAt: p.joinedAt,
	}));
}

/**
 * バトルのリーダーボードを取得する
 *
 * バトルの状態に応じてリーダーボードを構築する。
 * DRAFT/OPEN 状態では空のエントリを返す。RUNNING 以降は参加者のスコアを集計する。
 *
 * @param battleId - バトルID
 * @param tenantId - テナントID
 * @param repository - バトルリポジトリ
 * @param freezeMinutes - フリーズ開始までの残り時間（分）
 * @returns リーダーボード結果、バトルが見つからない場合は null
 */
export async function getLeaderboard(
	battleId: string,
	tenantId: string,
	repository: BattleRepository,
	freezeMinutes?: number,
): Promise<LeaderboardResult | null> {
	const battle = await repository.findByIdAndTenant(battleId, tenantId);
	if (!battle) {
		return null;
	}

	if (
		battle.status === BattleStatus.DRAFT ||
		battle.status === BattleStatus.OPEN
	) {
		return {
			battleId: battle.id,
			battleTitle: battle.title,
			status: battle.status,
			frozen: false,
			entries: [],
			updatedAt: battle.updatedAt,
		};
	}

	const participants = await repository.listParticipants(battleId);
	const frozen = isLeaderboardFrozen(battle, freezeMinutes);
	const entries = buildLeaderboard(participants);

	return {
		battleId: battle.id,
		battleTitle: battle.title,
		status: battle.status,
		frozen,
		entries,
		updatedAt: battle.updatedAt,
	};
}
