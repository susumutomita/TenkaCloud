import { gamedayRepository } from "../lib/dynamodb";
import {
	AttackAlreadyPurchasedError,
	VoteAlreadyExistsError,
} from "../repositories/gameday-repository";
import { POINT_ECONOMY } from "@tenkacloud/dynamodb";
import type {
	Attack,
	AttackPurchase,
	AttackLog,
	TeamVulnerability,
	Alliance,
	HealthCheckResult,
	Vote,
} from "../types";

export { AttackAlreadyPurchasedError, VoteAlreadyExistsError };

// === 定数 ===

/** 投票ボーナスポイント */
export const VOTE_BONUS_POINTS = 5000;

/**
 * ゲームが実行中でない場合に発生するエラー
 */
export class GameNotRunningError extends Error {
	constructor() {
		super("ゲームが開始されていません");
		this.name = "GameNotRunningError";
	}
}

/**
 * 指定された攻撃が見つから���い場合に発生するエラー
 */
export class AttackNotFoundError extends Error {
	constructor(attackId: string) {
		super(`攻撃が見つかりません: ${attackId}`);
		this.name = "AttackNotFoundError";
	}
}

/**
 * 攻撃が未購入の場合に発生するエラー
 */
export class AttackNotPurchasedError extends Error {
	constructor() {
		super("この攻撃は購入されていません");
		this.name = "AttackNotPurchasedError";
	}
}

/**
 * クールダウン期間中に攻撃を実行しようとした場合に発生するエラー
 */
export class CooldownActiveError extends Error {
	remainingSeconds: number;
	constructor(remainingSeconds: number) {
		super(`クールダウン中です（残り${remainingSeconds}秒）`);
		this.name = "CooldownActiveError";
		this.remainingSeconds = remainingSeconds;
	}
}

/**
 * 自チームへの攻撃を試みた場合に発生するエラー
 */
export class SelfAttackError extends Error {
	constructor() {
		super("自チームへの攻撃はできません");
		this.name = "SelfAttackError";
	}
}

/**
 * スコアが不足している場合に発生するエラー
 */
export class InsufficientScoreError extends Error {
	constructor() {
		super("スコアが不足しています");
		this.name = "InsufficientScoreError";
	}
}

/**
 * 指定されたチームが見つからない場合に発生するエラー
 */
export class TeamNotFoundError extends Error {
	constructor(teamId: string) {
		super(`チームが見つかりません: ${teamId}`);
		this.name = "TeamNotFoundError";
	}
}

/**
 * 指定された同盟が見つからない場合に発生するエラー
 */
export class AllianceNotFoundError extends Error {
	constructor(allianceId: string) {
		super(`同盟が見つかりません: ${allianceId}`);
		this.name = "AllianceNotFoundError";
	}
}

/**
 * 同盟を操作する権限がない場合に発生するエラー
 */
export class AllianceUnauthorizedError extends Error {
	constructor() {
		super("この同盟を操作する権限がありません");
		this.name = "AllianceUnauthorizedError";
	}
}

/**
 * 自チームへの投票を試みた場合に発生するエラー
 */
export class SelfVoteError extends Error {
	constructor() {
		super("自チームへの投票はできません");
		this.name = "SelfVoteError";
	}
}

async function ensureGameRunning(eventId: string): Promise<void> {
	const game = await gamedayRepository.getGameState(eventId);
	if (!game || !game.isRunning) {
		throw new GameNotRunningError();
	}
}

// === 攻撃 ===

/**
 * 攻撃カタログを取得する
 *
 * @param eventId - イベントID
 * @returns 攻撃一覧
 */
export async function getAttackCatalog(eventId: string): Promise<Attack[]> {
	return gamedayRepository.listAttackCatalog(eventId);
}

/**
 * 攻撃を購入する
 *
 * スコアから購入コストを差し引き、攻撃購入レコードを作成する。
 *
 * @param eventId - イベントID
 * @param teamId - 購入するチームのID
 * @param attackId - 購入する攻撃のID
 * @returns 攻撃購入レコード
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 * @throws {AttackNotFoundError} 攻撃が見つからない場合
 * @throws {TeamNotFoundError} チームが見つからない場合
 * @throws {InsufficientScoreError} スコアが不足している場合
 * @throws {AttackAlreadyPurchasedError} 既に購入済みの場合
 */
export async function purchaseAttack(
	eventId: string,
	teamId: string,
	attackId: string,
): Promise<AttackPurchase> {
	await ensureGameRunning(eventId);

	const attack = await gamedayRepository.getAttack(eventId, attackId);
	if (!attack) {
		throw new AttackNotFoundError(attackId);
	}

	const team = await gamedayRepository.getTeamState(eventId, teamId);
	if (!team) {
		throw new TeamNotFoundError(teamId);
	}

	if (team.score < attack.purchaseCost) {
		throw new InsufficientScoreError();
	}

	const purchase = await gamedayRepository.createAttackPurchase({
		eventId,
		teamId,
		attackId: attack.id,
		attackSlug: attack.slug,
	});

	await gamedayRepository.updateTeamScore(
		eventId,
		teamId,
		-attack.purchaseCost,
	);

	return purchase;
}

/**
 * 攻撃を実行する
 *
 * クールダウン検証、脆弱性チェック、スコア計算、同盟報酬分配を行い、攻撃ログを記録する。
 *
 * @param eventId - イベントID
 * @param attackerTeamId - 攻撃チームID
 * @param defenderTeamId - 防御チームID
 * @param attackId - 攻撃ID
 * @returns 攻撃ログ
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 * @throws {SelfAttackError} 自チームを攻撃しようとした場合
 * @throws {AttackNotFoundError} 攻撃が見つからない場合
 * @throws {AttackNotPurchasedError} 攻撃が未購入の場合
 * @throws {CooldownActiveError} クールダウン期間中の場合
 * @throws {TeamNotFoundError} 防御チームが見つからない場合
 */
export async function executeAttack(
	eventId: string,
	attackerTeamId: string,
	defenderTeamId: string,
	attackId: string,
): Promise<AttackLog> {
	await ensureGameRunning(eventId);

	if (attackerTeamId === defenderTeamId) {
		throw new SelfAttackError();
	}

	const attack = await gamedayRepository.getAttack(eventId, attackId);
	if (!attack) {
		throw new AttackNotFoundError(attackId);
	}

	const purchase = await gamedayRepository.getAttackPurchase(
		eventId,
		attackerTeamId,
		attack.slug,
	);
	if (!purchase) {
		throw new AttackNotPurchasedError();
	}

	// クールダウンチェック
	if (purchase.lastUsedAt) {
		const lastUsed = new Date(purchase.lastUsedAt).getTime();
		const now = Date.now();
		const elapsed = (now - lastUsed) / 1000;
		if (elapsed < attack.cooldownSeconds) {
			throw new CooldownActiveError(
				Math.ceil(attack.cooldownSeconds - elapsed),
			);
		}
	}

	const defender = await gamedayRepository.getTeamState(
		eventId,
		defenderTeamId,
	);
	if (!defender) {
		throw new TeamNotFoundError(defenderTeamId);
	}

	// 脆弱性悪用型の場合、被害者が修正済みかチェック
	let success = true;
	if (attack.attackType === "vulnerability" && attack.targetVulnerability) {
		const vuln = await gamedayRepository.getTeamVulnerability(
			eventId,
			defenderTeamId,
			attack.targetVulnerability,
		);
		if (vuln && vuln.isFixed) {
			success = false;
		}
	}

	const now = new Date().toISOString();
	await gamedayRepository.updatePurchaseLastUsedAt(
		eventId,
		attackerTeamId,
		attack.slug,
		now,
	);

	if (success) {
		// 同盟報酬分配
		const alliances = await gamedayRepository.listTeamActiveAlliances(
			eventId,
			attackerTeamId,
		);
		const activeAllyTeamIds = alliances.map((a) =>
			a.requesterTeamId === attackerTeamId ? a.targetTeamId : a.requesterTeamId,
		);

		const totalMembers = 1 + activeAllyTeamIds.length;
		const sharePerMember = Math.floor(attack.reward / totalMembers);
		const remainder = attack.reward - sharePerMember * totalMembers;

		// 全スコア変更を原子的に実行
		const scoreUpdates: Array<{ teamId: string; delta: number }> = [
			{ teamId: defenderTeamId, delta: -attack.damage },
			{ teamId: attackerTeamId, delta: sharePerMember + remainder },
		];
		for (const allyTeamId of activeAllyTeamIds) {
			scoreUpdates.push({ teamId: allyTeamId, delta: sharePerMember });
		}
		await gamedayRepository.updateMultipleTeamScores(eventId, scoreUpdates);

		return gamedayRepository.addAttackLog({
			eventId,
			attackerTeamId,
			defenderTeamId,
			attackId: attack.id,
			attackSlug: attack.slug,
			success: true,
			damage: attack.damage,
			reward: sharePerMember + remainder,
			details: `${attack.name} 攻撃成功`,
		});
	} else {
		// ブロック成功: 被害者に報酬
		await gamedayRepository.updateTeamScore(
			eventId,
			defenderTeamId,
			attack.reward,
		);

		return gamedayRepository.addAttackLog({
			eventId,
			attackerTeamId,
			defenderTeamId,
			attackId: attack.id,
			attackSlug: attack.slug,
			success: false,
			damage: 0,
			reward: 0,
			details: `${attack.name} 攻撃が防御されました`,
		});
	}
}

/**
 * 全攻撃ログを取得する
 *
 * @param eventId - イベントID
 * @returns 攻撃ログ一覧
 */
export async function getAllAttackLogs(eventId: string): Promise<AttackLog[]> {
	return gamedayRepository.listAttackLogs(eventId);
}

/**
 * チームの攻撃履歴を取得する
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @returns 該当チームが実行した攻撃ログ一覧
 */
export async function getAttackHistory(
	eventId: string,
	teamId: string,
): Promise<AttackLog[]> {
	const logs = await gamedayRepository.listAttackLogs(eventId);
	return logs.filter((log) => log.attackerTeamId === teamId);
}

/**
 * チームが受けている有効な攻撃を取得する
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @returns 未無効化の成功した攻撃ログ一覧
 */
export async function getActiveAttacks(
	eventId: string,
	teamId: string,
): Promise<AttackLog[]> {
	const logs = await gamedayRepository.listAttackLogs(eventId);
	return logs.filter(
		(log) => log.defenderTeamId === teamId && log.success && !log.neutralized,
	);
}

// === 防御 ===

/**
 * 攻撃の防御ヒントを購入する
 *
 * ヒントコストが設定されている場合、スコアから差し引く。
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @param attackId - 攻撃ID
 * @returns ヒント内容とコスト
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 * @throws {AttackNotFoundError} 攻撃が見つからない場合
 * @throws {TeamNotFoundError} チームが見つからない場合
 * @throws {InsufficientScoreError} スコアが不足している場合
 */
export async function purchaseHint(
	eventId: string,
	teamId: string,
	attackId: string,
): Promise<{ hint: string; cost: number }> {
	await ensureGameRunning(eventId);

	const attack = await gamedayRepository.getAttack(eventId, attackId);
	if (!attack) {
		throw new AttackNotFoundError(attackId);
	}

	if (attack.hintCost > 0) {
		const team = await gamedayRepository.getTeamState(eventId, teamId);
		if (!team) {
			throw new TeamNotFoundError(teamId);
		}
		if (team.score < attack.hintCost) {
			throw new InsufficientScoreError();
		}
		await gamedayRepository.updateTeamScore(eventId, teamId, -attack.hintCost);
	}

	return { hint: attack.defenseHint, cost: attack.hintCost };
}

/**
 * 脆弱性の修正を報告する
 *
 * 脆弱性を修正済みにし、防御修正ボーナスポイントを付与する。
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @param vulnerabilitySlug - 脆弱性スラッグ
 * @returns 更新された脆弱性情報
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 */
export async function reportFix(
	eventId: string,
	teamId: string,
	vulnerabilitySlug: string,
): Promise<TeamVulnerability> {
	await ensureGameRunning(eventId);

	const result = await gamedayRepository.upsertTeamVulnerability({
		eventId,
		teamId,
		vulnerabilitySlug,
		isFixed: true,
	});

	// ADR-003: 防御修正で +1,500 ポイント付与
	await gamedayRepository.updateTeamScore(
		eventId,
		teamId,
		POINT_ECONOMY.DEFENSE_FIX,
	);

	return result;
}

// === 同盟 ===

/**
 * チームの同盟一覧を取得する
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @returns 該当チームに関連する同盟一覧
 */
export async function listTeamAlliances(
	eventId: string,
	teamId: string,
): Promise<Alliance[]> {
	const alliances = await gamedayRepository.listAlliances(eventId);
	return alliances.filter(
		(a) => a.requesterTeamId === teamId || a.targetTeamId === teamId,
	);
}

/**
 * 同盟をリクエストする
 *
 * @param eventId - イベントID
 * @param requesterTeamId - リクエスト元チームID
 * @param targetTeamId - リクエスト先チームID
 * @returns 作成された同盟
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 */
export async function requestAlliance(
	eventId: string,
	requesterTeamId: string,
	targetTeamId: string,
): Promise<Alliance> {
	await ensureGameRunning(eventId);

	return gamedayRepository.createAlliance({
		eventId,
		requesterTeamId,
		targetTeamId,
	});
}

/**
 * 同盟リクエストを承認する
 *
 * @param eventId - イベントID
 * @param allianceId - 同盟ID
 * @param teamId - 承認するチームのID（ターゲットチーム）
 * @returns 更新された同盟
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 * @throws {AllianceNotFoundError} 同盟が見つからない場合
 * @throws {AllianceUnauthorizedError} 承認権限がない場合
 */
export async function acceptAlliance(
	eventId: string,
	allianceId: string,
	teamId: string,
): Promise<Alliance> {
	await ensureGameRunning(eventId);

	const alliance = await gamedayRepository.getAlliance(eventId, allianceId);
	if (!alliance) {
		throw new AllianceNotFoundError(allianceId);
	}

	if (alliance.targetTeamId !== teamId) {
		throw new AllianceUnauthorizedError();
	}

	await gamedayRepository.updateAllianceStatus(eventId, allianceId, "ACTIVE");

	return { ...alliance, status: "ACTIVE", updatedAt: new Date().toISOString() };
}

/**
 * 同盟を破棄する
 *
 * @param eventId - イベントID
 * @param allianceId - 同盟ID
 * @param teamId - 操作するチームのID
 * @throws {GameNotRunningError} ゲームが実行中でない場合
 * @throws {AllianceNotFoundError} 同盟が見つからない場合
 * @throws {AllianceUnauthorizedError} 操作権限がない場合
 */
export async function breakAlliance(
	eventId: string,
	allianceId: string,
	teamId: string,
): Promise<void> {
	await ensureGameRunning(eventId);

	const alliance = await gamedayRepository.getAlliance(eventId, allianceId);
	if (!alliance) {
		throw new AllianceNotFoundError(allianceId);
	}

	if (alliance.requesterTeamId !== teamId && alliance.targetTeamId !== teamId) {
		throw new AllianceUnauthorizedError();
	}

	await gamedayRepository.deleteAlliance(eventId, allianceId);
}

// === モニタリング ===

/**
 * チームのヘルスチェック結果を取得する
 *
 * @param eventId - イベントID
 * @param teamId - チームID
 * @returns ヘルスチェック結果一覧
 */
export async function getMonitoringStatus(
	eventId: string,
	teamId: string,
): Promise<HealthCheckResult[]> {
	return gamedayRepository.listHealthChecks(eventId, teamId);
}

// === 投票 ===

/**
 * チームに投票する
 *
 * 投票を記録し、投票先チームにボーナスポイントを付与する。
 *
 * @param eventId - イベントID
 * @param voterTeamId - 投票するチームID
 * @param votedForTeamId - 投票先チームID
 * @returns 投票レコード
 * @throws {SelfVoteError} 自チームに投票しようとした場合
 * @throws {VoteAlreadyExistsError} 既に投票済みの場合
 */
export async function castVote(
	eventId: string,
	voterTeamId: string,
	votedForTeamId: string,
): Promise<Vote> {
	if (voterTeamId === votedForTeamId) {
		throw new SelfVoteError();
	}

	const vote = await gamedayRepository.castVote({
		eventId,
		voterTeamId,
		votedForTeamId,
	});

	// 投票ボーナス
	await gamedayRepository.updateTeamScore(
		eventId,
		votedForTeamId,
		VOTE_BONUS_POINTS,
	);

	return vote;
}

/**
 * 投票結果を集計する
 *
 * @param eventId - イベントID
 * @returns チームごとの投票数（降順）
 */
export async function getVotingResults(
	eventId: string,
): Promise<{ teamId: string; votes: number }[]> {
	const votes = await gamedayRepository.listVotes(eventId);

	const counts: Record<string, number> = {};
	for (const vote of votes) {
		counts[vote.votedForTeamId] = (counts[vote.votedForTeamId] || 0) + 1;
	}

	return Object.entries(counts)
		.map(([teamId, voteCount]) => ({ teamId, votes: voteCount }))
		.sort((a, b) => b.votes - a.votes);
}
