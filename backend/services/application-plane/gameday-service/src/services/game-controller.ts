import { gamedayRepository } from "../lib/dynamodb";
import { ConcurrentModificationError } from "../repositories/gameday-repository";
import {
	validateTenantAccess,
	CrossTenantAccessError,
} from "@tenkacloud/dynamodb";
import type { GameState, AttackLog } from "../types";
import type { TeamState } from "../repositories/gameday-repository";
import { DEFAULT_ATTACKS } from "../data/default-attacks";
import { ulid } from "ulid";

export { ConcurrentModificationError };
export { CrossTenantAccessError };

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

export async function startGame(
	eventId: string,
	tenantId: string,
	durationMinutes: number,
): Promise<GameState> {
	return gamedayRepository.createGameState({
		eventId,
		tenantId,
		durationMinutes,
	});
}

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

export async function listTeams(
	eventId: string,
	tenantId: string,
): Promise<TeamState[]> {
	await validateGameTenantAccess(eventId, tenantId);
	return gamedayRepository.listTeams(eventId);
}

export async function listAttackLogs(
	eventId: string,
	tenantId: string,
): Promise<AttackLog[]> {
	await validateGameTenantAccess(eventId, tenantId);
	return gamedayRepository.listAttackLogs(eventId);
}

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
