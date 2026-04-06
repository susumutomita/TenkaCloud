import { gamedayRepository } from "../lib/dynamodb";
import {
	ConcurrentModificationError,
	GameAlreadyExistsError,
} from "../repositories/gameday-repository";
import {
	validateTenantAccess,
	CrossTenantAccessError,
	POINT_ECONOMY,
} from "@tenkacloud/dynamodb";
import type { GameState, AttackLog } from "../types";
import type { TeamState } from "../repositories/gameday-repository";
import { DEFAULT_ATTACKS } from "../data/default-attacks";
import { ulid } from "ulid";

export { ConcurrentModificationError };
export { GameAlreadyExistsError };
export { CrossTenantAccessError };

/**
 * ゲームが見つからない場合に発生するエラー
 */
export class GameNotFoundError extends Error {
	constructor() {
		super("ゲームが見つかりません");
		this.name = "GameNotFoundError";
	}
}

/**
 * ゲームのテナントアクセスを検証する
 * eventId からゲーム状態を取得し、リクエスト元のテナント ID と一致するか確認する
 */
async function validateGameTenantAccess(
	eventId: string,
	requestTenantId: string,
): Promise<GameState> {
	const game = await gamedayRepository.getGameState(eventId);
	if (!game) {
		throw new GameNotFoundError();
	}
	validateTenantAccess(requestTenantId, game.tenantId);
	return game;
}

/**
 * ゲームを初期化する
 *
 * ゲーム状態を作成するが、開始はしない。
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @param durationMinutes - ゲーム時間（分）
 * @returns 初期化されたゲーム状態
 * @throws {GameAlreadyExistsError} 既にゲームが存在する場合
 */
export async function initGame(
	eventId: string,
	tenantId: string,
	durationMinutes: number,
): Promise<GameState> {
	return gamedayRepository.initGameState({
		eventId,
		tenantId,
		durationMinutes,
	});
}

/**
 * ゲームを開始する
 *
 * ゲーム状態を作成し、登録済みチームへ初期ポイントを付与する。
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @param durationMinutes - ゲーム時間（分）
 * @returns 開始されたゲーム状態
 * @throws {GameAlreadyExistsError} 既にゲームが存在する場合
 */
export async function startGame(
	eventId: string,
	tenantId: string,
	durationMinutes: number,
): Promise<GameState> {
	const game = await gamedayRepository.createGameState({
		eventId,
		tenantId,
		durationMinutes,
	});

	// ADR-003: ゲーム開始時に登録済みチームへ初期ポイントを付与
	const teams = await gamedayRepository.listTeams(eventId);
	await Promise.all(
		teams.map((team) =>
			gamedayRepository.updateTeamScore(
				eventId,
				team.teamId,
				POINT_ECONOMY.INITIAL_POINTS,
			),
		),
	);

	return game;
}

/**
 * ゲームを停止する
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns 停止されたゲーム状態
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function stopGame(
	eventId: string,
	tenantId: string,
): Promise<GameState> {
	await validateGameTenantAccess(eventId, tenantId);
	const result = await gamedayRepository.stopGame(eventId);
	if (!result) {
		throw new GameNotFoundError();
	}
	return result;
}

/**
 * ゲーム状態を取得する
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns ゲーム状態、存在しない場合は null
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function getGameStatus(
	eventId: string,
	tenantId: string,
): Promise<GameState | null> {
	const game = await gamedayRepository.getGameState(eventId);
	if (!game) {
		return null;
	}
	validateTenantAccess(tenantId, game.tenantId);
	return game;
}

/**
 * スコアウェイトを切り替える（normal/high）
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns 更新されたゲーム状態
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function toggleScoreWeight(
	eventId: string,
	tenantId: string,
): Promise<GameState> {
	await validateGameTenantAccess(eventId, tenantId);
	const result = await gamedayRepository.toggleScoreWeight(eventId);
	if (!result) {
		throw new GameNotFoundError();
	}
	return result;
}

/**
 * ブラックアウトを切り替える
 *
 * ブラックアウト中はリーダーボードが非表示になる。
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns 更新されたゲーム状態
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function toggleBlackout(
	eventId: string,
	tenantId: string,
): Promise<GameState> {
	await validateGameTenantAccess(eventId, tenantId);
	const result = await gamedayRepository.toggleBlackout(eventId);
	if (!result) {
		throw new GameNotFoundError();
	}
	return result;
}

/**
 * 管理者による障害注入を実行する
 *
 * @param eventId - イベントID
 * @param teamId - 対象チームID
 * @param attackSlug - 攻撃スラッグ
 * @param tenantId - テナントID
 * @returns 攻撃ログ
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function executeFaultInjection(
	eventId: string,
	teamId: string,
	attackSlug: string,
	tenantId: string,
): Promise<AttackLog> {
	await validateGameTenantAccess(eventId, tenantId);
	return gamedayRepository.addAttackLog({
		eventId,
		attackerTeamId: "ADMIN",
		defenderTeamId: teamId,
		attackId: attackSlug,
		attackSlug,
		success: true,
		damage: 0,
		reward: 0,
		details: `管理者による障害注入: ${attackSlug}`,
	});
}

/**
 * チーム一覧を取得する
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns チーム一覧
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function listTeams(
	eventId: string,
	tenantId: string,
): Promise<TeamState[]> {
	await validateGameTenantAccess(eventId, tenantId);
	return gamedayRepository.listTeams(eventId);
}

/**
 * 攻撃ログ一覧を取得する
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns 攻撃ログ一覧
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function listAttackLogs(
	eventId: string,
	tenantId: string,
): Promise<AttackLog[]> {
	await validateGameTenantAccess(eventId, tenantId);
	return gamedayRepository.listAttackLogs(eventId);
}

/**
 * デフォルト攻撃カタログをシードする
 *
 * @param eventId - イベントID
 * @param tenantId - テナントID
 * @returns シードされた攻撃の数
 * @throws {GameNotFoundError} ゲームが見つからない場合
 * @throws {CrossTenantAccessError} テナントIDが一致しない場合
 */
export async function seedAttackCatalog(
	eventId: string,
	tenantId: string,
): Promise<number> {
	await validateGameTenantAccess(eventId, tenantId);
	const attacks = DEFAULT_ATTACKS.map((a) => ({
		...a,
		id: ulid(),
	}));
	await gamedayRepository.seedAttackCatalog(eventId, attacks);
	return attacks.length;
}
