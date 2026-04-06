/**
 * GameDay リポジトリ共通ヘルパー
 *
 * DynamoDB キービルダー、アイテム型定義、マッパー関数、エラークラス
 */

import type {
	GameState,
	AttackLog,
	Attack,
	AttackPurchase,
	TeamVulnerability,
	Alliance,
	AllianceStatus,
	HealthCheckResult,
	Vote,
	ScoreWeight,
} from "../types";

// =============================================================================
// Key Builders
// =============================================================================

export const buildGamedayPK = (eventId: string) => `GAMEDAY#${eventId}`;
export const buildMetadataSK = () => "METADATA";
export const buildAttackLogSK = (id: string) => `ATTACKLOG#${id}`;
export const buildTeamSK = (teamId: string) => `TEAM#${teamId}`;
export const buildAttackSK = (slug: string) => `ATTACK#${slug}`;
export const buildPurchaseSK = (teamId: string, attackSlug: string) =>
	`PURCHASE#${teamId}#${attackSlug}`;
export const buildVulnerabilitySK = (teamId: string, vulnSlug: string) =>
	`VULNERABILITY#${teamId}#${vulnSlug}`;
export const buildAllianceSK = (allianceId: string) =>
	`ALLIANCE#${allianceId}`;
export const buildHealthCheckSK = (teamId: string, timestamp: string) =>
	`HEALTHCHECK#${teamId}#${timestamp}`;
export const buildVoteSK = (voterId: string) => `VOTE#${voterId}`;
export const buildMemberSK = (userId: string) => `MEMBER#${userId}`;
export const buildTenantGamedayGSI = (tenantId: string) =>
	`TENANT#${tenantId}#GAMEDAY`;

// =============================================================================
// DynamoDB Item Types
// =============================================================================

export interface GameStateItem {
	PK: string;
	SK: string;
	GSI1PK: string;
	GSI1SK: string;
	EntityType: string;
	eventId: string;
	tenantId: string;
	isRunning: boolean;
	startedAt: string | null;
	scoreWeight: ScoreWeight;
	blackout: boolean;
	durationMinutes: number;
	CreatedAt: string;
	UpdatedAt: string;
}

export interface AttackLogItem {
	PK: string;
	SK: string;
	EntityType: string;
	id: string;
	eventId: string;
	attackerTeamId: string;
	defenderTeamId: string;
	attackId: string;
	attackSlug: string;
	success: boolean;
	neutralized: boolean;
	damage: number;
	reward: number;
	details: string;
	createdAt: string;
}

export interface TeamStateItem {
	PK: string;
	SK: string;
	EntityType: string;
	eventId: string;
	teamId: string;
	teamName: string;
	score: number;
	isHealthy: boolean;
	websiteUrl: string | null;
	apiUrl: string | null;
	inviteCode: string;
	CreatedAt: string;
	UpdatedAt: string;
}

export interface MemberItem {
	PK: string;
	SK: string;
	EntityType: string;
	eventId: string;
	userId: string;
	teamId: string;
	teamName: string;
	mode: "solo" | "team";
	CreatedAt: string;
}

// =============================================================================
// Domain Types (exported from repository)
// =============================================================================

export interface TeamState {
	eventId: string;
	teamId: string;
	teamName: string;
	score: number;
	isHealthy: boolean;
	websiteUrl: string | null;
	apiUrl: string | null;
	inviteCode: string;
}

export interface MemberRecord {
	eventId: string;
	userId: string;
	teamId: string;
	teamName: string;
	mode: "solo" | "team";
}

// =============================================================================
// Mapper Functions
// =============================================================================

/** DynamoDB GameState アイテムをドメイン型に変換 */
export function toGameState(item: GameStateItem): GameState {
	return {
		eventId: item.eventId,
		tenantId: item.tenantId,
		isRunning: item.isRunning,
		startedAt: item.startedAt,
		scoreWeight: item.scoreWeight,
		blackout: item.blackout,
		durationMinutes: item.durationMinutes,
	};
}

/** DynamoDB AttackLog アイテムをドメイン型に変換 */
export function toAttackLog(item: AttackLogItem): AttackLog {
	return {
		id: item.id,
		eventId: item.eventId,
		attackerTeamId: item.attackerTeamId,
		defenderTeamId: item.defenderTeamId,
		attackId: item.attackId,
		attackSlug: item.attackSlug,
		success: item.success,
		neutralized: item.neutralized,
		damage: item.damage,
		reward: item.reward,
		details: item.details,
		createdAt: item.createdAt,
	};
}

/** DynamoDB TeamState アイテムをドメイン型に変換 */
export function toTeamState(item: TeamStateItem): TeamState {
	return {
		eventId: item.eventId,
		teamId: item.teamId,
		teamName: item.teamName,
		score: item.score,
		isHealthy: item.isHealthy,
		websiteUrl: item.websiteUrl ?? null,
		apiUrl: item.apiUrl ?? null,
		inviteCode: item.inviteCode ?? "",
	};
}

/** DynamoDB Member アイテムをドメイン型に変換 */
export function toMemberRecord(item: MemberItem): MemberRecord {
	return {
		eventId: item.eventId,
		userId: item.userId,
		teamId: item.teamId,
		teamName: item.teamName,
		mode: item.mode,
	};
}

/** DynamoDB Attack アイテムをドメイン型に変換 */
export function toAttack(item: Record<string, unknown>): Attack {
	return {
		id: item.id as string,
		eventId: item.eventId as string,
		name: item.name as string,
		slug: item.slug as string,
		attackType: item.attackType as "vulnerability" | "chaos",
		targetVulnerability: (item.targetVulnerability as string) ?? null,
		description: item.description as string,
		purchaseCost: item.purchaseCost as number,
		damage: item.damage as number,
		reward: item.reward as number,
		cooldownSeconds: item.cooldownSeconds as number,
		defenseHint: item.defenseHint as string,
		hintCost: item.hintCost as number,
	};
}

/** DynamoDB AttackPurchase アイテムをドメイン型に変換 */
export function toAttackPurchase(item: Record<string, unknown>): AttackPurchase {
	return {
		id: item.id as string,
		eventId: item.eventId as string,
		teamId: item.teamId as string,
		attackId: item.attackId as string,
		attackSlug: item.attackSlug as string,
		purchasedAt: item.purchasedAt as string,
		lastUsedAt: (item.lastUsedAt as string) ?? null,
	};
}

/** DynamoDB TeamVulnerability アイテムをドメイン型に変換 */
export function toTeamVulnerability(
	item: Record<string, unknown>,
): TeamVulnerability {
	return {
		eventId: item.eventId as string,
		teamId: item.teamId as string,
		vulnerabilitySlug: item.vulnerabilitySlug as string,
		isFixed: item.isFixed as boolean,
		fixedAt: (item.fixedAt as string) ?? null,
	};
}

/** DynamoDB Alliance アイテムをドメイン型に変換 */
export function toAlliance(item: Record<string, unknown>): Alliance {
	return {
		id: item.id as string,
		eventId: item.eventId as string,
		requesterTeamId: item.requesterTeamId as string,
		targetTeamId: item.targetTeamId as string,
		status: item.status as AllianceStatus,
		createdAt: item.createdAt as string,
		updatedAt: item.updatedAt as string,
	};
}

/** DynamoDB HealthCheckResult アイテムをドメイン型に変換 */
export function toHealthCheckResult(
	item: Record<string, unknown>,
): HealthCheckResult {
	return {
		id: item.id as string,
		eventId: item.eventId as string,
		teamId: item.teamId as string,
		checkType: item.checkType as "website" | "api",
		isHealthy: item.isHealthy as boolean,
		statusCode: (item.statusCode as number) ?? null,
		responseTimeMs: (item.responseTimeMs as number) ?? null,
		createdAt: item.createdAt as string,
	};
}

/** DynamoDB Vote アイテムをドメイン型に変換 */
export function toVote(item: Record<string, unknown>): Vote {
	return {
		id: item.id as string,
		eventId: item.eventId as string,
		voterTeamId: item.voterTeamId as string,
		votedForTeamId: item.votedForTeamId as string,
		createdAt: item.createdAt as string,
	};
}

// =============================================================================
// Error Classes
// =============================================================================

export class GameAlreadyExistsError extends Error {
	constructor(eventId: string) {
		super(`ゲームは既に存在します: ${eventId}`);
		this.name = "GameAlreadyExistsError";
	}
}

export class ConcurrentModificationError extends Error {
	constructor() {
		super("同時変更が検出されました。もう一度お試しください");
		this.name = "ConcurrentModificationError";
	}
}

export class AttackAlreadyPurchasedError extends Error {
	constructor() {
		super("この攻撃は既に購入済みです");
		this.name = "AttackAlreadyPurchasedError";
	}
}

export class VoteAlreadyExistsError extends Error {
	constructor() {
		super("既に投票済みです");
		this.name = "VoteAlreadyExistsError";
	}
}

export class TeamAlreadyExistsError extends Error {
	constructor(teamId: string) {
		super(`チームは既に登録済みです: ${teamId}`);
		this.name = "TeamAlreadyExistsError";
	}
}
