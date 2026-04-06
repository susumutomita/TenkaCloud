import { gamedayRepository } from "../lib/dynamodb";
import { TeamAlreadyExistsError } from "../repositories/gameday-repository";
import { POINT_ECONOMY } from "@tenkacloud/dynamodb";
import type { TeamState } from "../repositories/gameday-repository";
import type { AttackLog, HealthCheckResult } from "../types";

export { TeamAlreadyExistsError };

/**
 * ブラックアウト中にリーダーボードへアクセスした場合に発生するエラー
 */
export class BlackoutActiveError extends Error {
	constructor() {
		super("ブラックアウト中はリーダーボードを閲覧できません");
		this.name = "BlackoutActiveError";
	}
}

// === チーム登録 ===

/**
 * チームを登録する
 *
 * ゲーム実行中に登録した場合、初期ポイントを自動付与する。
 *
 * @param input - チーム登録情報
 * @returns 作成されたチーム状態
 * @throws {TeamAlreadyExistsError} 同一チームIDが既に存在する場合
 */
export async function registerTeam(input: {
	eventId: string;
	teamId: string;
	teamName: string;
	websiteUrl?: string;
	apiUrl?: string;
	inviteCode?: string;
}): Promise<TeamState> {
	const team = await gamedayRepository.createTeam(input);

	// ADR-003: ゲーム実行中に登録した場合、初期ポイントを付与
	const game = await gamedayRepository.getGameState(input.eventId);
	if (game?.isRunning) {
		await gamedayRepository.updateTeamScore(
			input.eventId,
			input.teamId,
			POINT_ECONOMY.INITIAL_POINTS,
		);
	}

	return team;
}

/**
 * 招待コードでチームに参加する
 *
 * @param eventId - イベントID
 * @param inviteCode - 招待コード
 * @returns チーム状態、見つからない場合は null
 */
export async function joinTeamByInviteCode(
	eventId: string,
	inviteCode: string,
): Promise<TeamState | null> {
	return gamedayRepository.findTeamByInviteCode(eventId, inviteCode);
}

// === チーム URL 更新 ===

/**
 * チームのURL情報を更新する
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @param urls - 更新するURL（websiteUrl, apiUrl）
 * @throws {TeamNotFoundError} チームが見つからない場合
 */
export async function updateTeamUrl(
	eventId: string,
	teamId: string,
	urls: { websiteUrl?: string; apiUrl?: string },
): Promise<void> {
	const team = await gamedayRepository.getTeamState(eventId, teamId);
	if (!team) {
		throw new TeamNotFoundError(teamId);
	}
	await gamedayRepository.updateTeamUrls(eventId, teamId, urls);
}

/**
 * チームが見つからない場合に発生するエラー
 */
export class TeamNotFoundError extends Error {
	constructor(teamId: string) {
		super(`チームが見つかりません: ${teamId}`);
		this.name = "TeamNotFoundError";
	}
}

/**
 * チーム一覧を取得する
 *
 * @param eventId - イベントID
 * @returns チーム一覧
 */
export async function listTeams(eventId: string): Promise<TeamState[]> {
	return gamedayRepository.listTeams(eventId);
}

// === リーダーボード ===

/**
 * リーダーボードを取得する
 *
 * ブラックアウト中はアクセスを拒否する。スコア降順でチームを返す。
 *
 * @param eventId - イベントID
 * @returns スコア降順のチーム一覧
 * @throws {BlackoutActiveError} ブラックアウト中の場合
 */
export async function getLeaderboard(eventId: string): Promise<TeamState[]> {
	const game = await gamedayRepository.getGameState(eventId);
	if (game?.blackout) {
		throw new BlackoutActiveError();
	}

	const teams = await gamedayRepository.listTeams(eventId);
	return teams.sort((a, b) => b.score - a.score);
}

// === 攻撃統計 ===

/**
 * チームの攻撃統計情報
 */
export interface AttackStatistics {
	teamId: string;
	teamName: string;
	attacksSent: number;
	attacksReceived: number;
	successRate: number;
}

/**
 * 全チームの攻撃統計を取得する
 *
 * 各チームの送信・受信攻撃数と成功率を集計する。管理者によるログは除外する。
 *
 * @param eventId - イベントID
 * @returns チームごとの攻撃統計一覧
 */
export async function getAttackStatistics(
	eventId: string,
): Promise<AttackStatistics[]> {
	const [teams, logs] = await Promise.all([
		gamedayRepository.listTeams(eventId),
		gamedayRepository.listAttackLogs(eventId),
	]);

	const statsMap = new Map<
		string,
		{ sent: number; received: number; successSent: number }
	>();

	for (const team of teams) {
		statsMap.set(team.teamId, { sent: 0, received: 0, successSent: 0 });
	}

	for (const log of logs) {
		if (log.attackerTeamId === "ADMIN") continue;

		const attackerStats = statsMap.get(log.attackerTeamId);
		if (attackerStats) {
			attackerStats.sent++;
			if (log.success) {
				attackerStats.successSent++;
			}
		}

		const defenderStats = statsMap.get(log.defenderTeamId);
		if (defenderStats) {
			defenderStats.received++;
		}
	}

	return teams.map((team) => {
		const stats = statsMap.get(team.teamId)!;
		return {
			teamId: team.teamId,
			teamName: team.teamName,
			attacksSent: stats.sent,
			attacksReceived: stats.received,
			successRate: stats.sent > 0 ? stats.successSent / stats.sent : 0,
		};
	});
}

// === チームダッシュボード ===

/**
 * チームダッシュボードの集約情報
 */
export interface TeamDashboard {
	team: TeamState;
	recentHealthChecks: HealthCheckResult[];
	attackHistory: AttackLog[];
}

/**
 * チームダッシュボード情報を取得する
 *
 * チーム状態、ヘルスチェック、攻撃履歴を集約して返す。
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @returns チームダッシュボード、チームが見つからない場合は null
 */
export async function getTeamDashboard(
	eventId: string,
	teamId: string,
): Promise<TeamDashboard | null> {
	const team = await gamedayRepository.getTeamState(eventId, teamId);
	if (!team) {
		return null;
	}

	const [recentHealthChecks, allLogs] = await Promise.all([
		gamedayRepository.listHealthChecks(eventId, teamId),
		gamedayRepository.listAttackLogs(eventId),
	]);

	const attackHistory = allLogs.filter(
		(log) => log.attackerTeamId === teamId || log.defenderTeamId === teamId,
	);

	return {
		team,
		recentHealthChecks,
		attackHistory,
	};
}
