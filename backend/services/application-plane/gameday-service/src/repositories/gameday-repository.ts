/**
 * GameDay リポジトリ（ファサード）
 *
 * 後方互換性のため GamedayRepository クラスを維持しつつ、
 * 実装をドメイン別サブリポジトリに委譲する。
 */
import { GameStateRepository } from "./game-state-repository";
import { TeamRepository } from "./team-repository";
import { AttackRepository } from "./attack-repository";
import { SocialRepository } from "./social-repository";
import type { GameState, AttackLog, Attack, AttackPurchase, TeamVulnerability, Alliance, AllianceStatus, HealthCheckResult, Vote } from "../types";

// 後方互換: エラークラスとドメイン型の re-export
export {
	GameAlreadyExistsError,
	ConcurrentModificationError,
	AttackAlreadyPurchasedError,
	VoteAlreadyExistsError,
	TeamAlreadyExistsError,
} from "./repository-helpers";
export type { TeamState, MemberRecord } from "./repository-helpers";

type TeamState = import("./repository-helpers").TeamState;
type MemberRecord = import("./repository-helpers").MemberRecord;

export class GamedayRepository {
	private readonly gameState = new GameStateRepository();
	private readonly team = new TeamRepository();
	private readonly attack = new AttackRepository();
	private readonly social = new SocialRepository();

	// === ゲーム状態 ===

	async createGameState(input: {
		eventId: string;
		tenantId: string;
		durationMinutes: number;
	}): Promise<GameState> {
		return this.gameState.createGameState(input);
	}

	async initGameState(input: {
		eventId: string;
		tenantId: string;
		durationMinutes: number;
	}): Promise<GameState> {
		return this.gameState.initGameState(input);
	}

	async getGameState(eventId: string): Promise<GameState | null> {
		return this.gameState.getGameState(eventId);
	}

	async stopGame(eventId: string): Promise<GameState | null> {
		return this.gameState.stopGame(eventId);
	}

	async startExistingGame(eventId: string): Promise<GameState | null> {
		return this.gameState.startExistingGame(eventId);
	}

	async toggleScoreWeight(eventId: string): Promise<GameState | null> {
		return this.gameState.toggleScoreWeight(eventId);
	}

	async enableBlackout(eventId: string): Promise<GameState | null> {
		return this.gameState.enableBlackout(eventId);
	}

	async toggleBlackout(eventId: string): Promise<GameState | null> {
		return this.gameState.toggleBlackout(eventId);
	}

	// === チーム登録 ===

	async createTeam(input: {
		eventId: string;
		teamId: string;
		teamName: string;
		websiteUrl?: string;
		apiUrl?: string;
		inviteCode?: string;
	}): Promise<TeamState> {
		return this.team.createTeam(input);
	}

	async updateTeamUrls(
		eventId: string,
		teamId: string,
		urls: { websiteUrl?: string; apiUrl?: string },
	): Promise<void> {
		return this.team.updateTeamUrls(eventId, teamId, urls);
	}

	async updateTeamHealthy(
		eventId: string,
		teamId: string,
		isHealthy: boolean,
	): Promise<void> {
		return this.team.updateTeamHealthy(eventId, teamId, isHealthy);
	}

	// === 攻撃ログ ===

	async addAttackLog(input: {
		eventId: string;
		attackerTeamId: string;
		defenderTeamId: string;
		attackId: string;
		attackSlug: string;
		success: boolean;
		damage: number;
		reward: number;
		details: string;
	}): Promise<AttackLog> {
		return this.attack.addAttackLog(input);
	}

	async listAttackLogs(eventId: string): Promise<AttackLog[]> {
		return this.attack.listAttackLogs(eventId);
	}

	// === チーム ===

	async getTeamState(
		eventId: string,
		teamId: string,
	): Promise<TeamState | null> {
		return this.team.getTeamState(eventId, teamId);
	}

	async listTeams(eventId: string): Promise<TeamState[]> {
		return this.team.listTeams(eventId);
	}

	async findTeamByInviteCode(
		eventId: string,
		inviteCode: string,
	): Promise<TeamState | null> {
		return this.team.findTeamByInviteCode(eventId, inviteCode);
	}

	async updateTeamScore(
		eventId: string,
		teamId: string,
		delta: number,
	): Promise<void> {
		return this.team.updateTeamScore(eventId, teamId, delta);
	}

	async updateMultipleTeamScores(
		eventId: string,
		updates: Array<{ teamId: string; delta: number }>,
	): Promise<void> {
		return this.team.updateMultipleTeamScores(eventId, updates);
	}

	// === 攻撃カタログ ===

	async listAttackCatalog(eventId: string): Promise<Attack[]> {
		return this.attack.listAttackCatalog(eventId);
	}

	async getAttack(
		eventId: string,
		attackIdentifier: string,
	): Promise<Attack | null> {
		return this.attack.getAttack(eventId, attackIdentifier);
	}

	async seedAttackCatalog(eventId: string, attacks: Attack[]): Promise<void> {
		return this.attack.seedAttackCatalog(eventId, attacks);
	}

	// === 攻撃購入 ===

	async getAttackPurchase(
		eventId: string,
		teamId: string,
		attackSlug: string,
	): Promise<AttackPurchase | null> {
		return this.attack.getAttackPurchase(eventId, teamId, attackSlug);
	}

	async createAttackPurchase(input: {
		eventId: string;
		teamId: string;
		attackId: string;
		attackSlug: string;
	}): Promise<AttackPurchase> {
		return this.attack.createAttackPurchase(input);
	}

	async updatePurchaseLastUsedAt(
		eventId: string,
		teamId: string,
		attackSlug: string,
		timestamp: string,
	): Promise<void> {
		return this.attack.updatePurchaseLastUsedAt(eventId, teamId, attackSlug, timestamp);
	}

	// === 脆弱性 ===

	async getTeamVulnerability(
		eventId: string,
		teamId: string,
		vulnSlug: string,
	): Promise<TeamVulnerability | null> {
		return this.attack.getTeamVulnerability(eventId, teamId, vulnSlug);
	}

	async upsertTeamVulnerability(input: {
		eventId: string;
		teamId: string;
		vulnerabilitySlug: string;
		isFixed: boolean;
	}): Promise<TeamVulnerability> {
		return this.attack.upsertTeamVulnerability(input);
	}

	// === 同盟 ===

	async listAlliances(eventId: string): Promise<Alliance[]> {
		return this.social.listAlliances(eventId);
	}

	async listTeamActiveAlliances(
		eventId: string,
		teamId: string,
	): Promise<Alliance[]> {
		return this.social.listTeamActiveAlliances(eventId, teamId);
	}

	async getAlliance(
		eventId: string,
		allianceId: string,
	): Promise<Alliance | null> {
		return this.social.getAlliance(eventId, allianceId);
	}

	async createAlliance(input: {
		eventId: string;
		requesterTeamId: string;
		targetTeamId: string;
	}): Promise<Alliance> {
		return this.social.createAlliance(input);
	}

	async updateAllianceStatus(
		eventId: string,
		allianceId: string,
		status: AllianceStatus,
	): Promise<void> {
		return this.social.updateAllianceStatus(eventId, allianceId, status);
	}

	async deleteAlliance(eventId: string, allianceId: string): Promise<void> {
		return this.social.deleteAlliance(eventId, allianceId);
	}

	// === ヘルスチェック ===

	async listHealthChecks(
		eventId: string,
		teamId: string,
	): Promise<HealthCheckResult[]> {
		return this.social.listHealthChecks(eventId, teamId);
	}

	async createHealthCheck(input: {
		eventId: string;
		teamId: string;
		checkType: "website" | "api";
		isHealthy: boolean;
		statusCode: number | null;
		responseTimeMs: number | null;
	}): Promise<HealthCheckResult> {
		return this.social.createHealthCheck(input);
	}

	// === 投票 ===

	async castVote(input: {
		eventId: string;
		voterTeamId: string;
		votedForTeamId: string;
	}): Promise<Vote> {
		return this.social.castVote(input);
	}

	async listVotes(eventId: string): Promise<Vote[]> {
		return this.social.listVotes(eventId);
	}

	// === メンバーシップ ===

	async addMember(input: {
		eventId: string;
		userId: string;
		teamId: string;
		teamName: string;
		mode: "solo" | "team";
	}): Promise<MemberRecord> {
		return this.social.addMember(input);
	}

	async getMembership(
		eventId: string,
		userId: string,
	): Promise<MemberRecord | null> {
		return this.social.getMembership(eventId, userId);
	}
}
