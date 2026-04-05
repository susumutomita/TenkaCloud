import { gamedayRepository } from "../lib/dynamodb";
import { createLogger } from "../lib/logger";
import type { TeamState } from "../repositories/gameday-repository";
import type { GameState } from "../types";

const logger = createLogger("auditor");

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const UPTIME_BONUS = 100;
const DOWNTIME_PENALTY_NORMAL = -100;
const DOWNTIME_PENALTY_HIGH = -1000;

export interface HttpCheckResult {
	isHealthy: boolean;
	statusCode: number | null;
	responseTimeMs: number;
}

export class AuditorService {
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private eventId: string | null = null;

	start(eventId: string): void {
		if (this.intervalId) {
			logger.warn("Auditor は既に起動しています");
			return;
		}

		this.eventId = eventId;
		logger.info({ eventId }, "Auditor を開始します");

		this.intervalId = setInterval(() => {
			this.runCheck().catch((err) => {
				logger.error({ err }, "ヘルスチェック実行中にエラーが発生しました");
			});
		}, HEALTH_CHECK_INTERVAL_MS);

		// 即座に最初のチェックを実行
		this.runCheck().catch((err) => {
			logger.error({ err }, "初回ヘルスチェック実行中にエラーが発生しました");
		});
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.eventId = null;
			logger.info("Auditor を停止しました");
		}
	}

	isRunning(): boolean {
		return this.intervalId !== null;
	}

	async runCheck(): Promise<void> {
		if (!this.eventId) return;

		const game = await gamedayRepository.getGameState(this.eventId);
		if (!game || !game.isRunning) {
			logger.info("ゲームが開始されていないためチェックをスキップします");
			return;
		}

		// ゲーム時間管理
		const shouldContinue = await this.enforceGameDuration(game);
		if (!shouldContinue) return;

		const teams = await gamedayRepository.listTeams(this.eventId);

		const results = await Promise.allSettled(
			teams.map((team) =>
				this.checkTeam(this.eventId!, team, game.scoreWeight),
			),
		);

		for (const result of results) {
			if (result.status === "rejected") {
				logger.error(
					{ err: result.reason },
					"チームチェック中にエラーが発生しました",
				);
			}
		}
	}

	async checkTeam(
		eventId: string,
		team: TeamState,
		scoreWeight: string,
	): Promise<void> {
		let websiteResult: HttpCheckResult | null = null;
		let apiResult: HttpCheckResult | null = null;

		if (team.websiteUrl) {
			websiteResult = await this.httpCheck(team.websiteUrl);
			await gamedayRepository.createHealthCheck({
				eventId,
				teamId: team.teamId,
				checkType: "website",
				isHealthy: websiteResult.isHealthy,
				statusCode: websiteResult.statusCode,
				responseTimeMs: websiteResult.responseTimeMs,
			});
		}

		if (team.apiUrl) {
			apiResult = await this.httpCheck(team.apiUrl);
			await gamedayRepository.createHealthCheck({
				eventId,
				teamId: team.teamId,
				checkType: "api",
				isHealthy: apiResult.isHealthy,
				statusCode: apiResult.statusCode,
				responseTimeMs: apiResult.responseTimeMs,
			});
		}

		// URL が未設定の場合はチェックをスキップ（ペナルティなし）
		if (!team.websiteUrl && !team.apiUrl) {
			return;
		}

		const websiteUp = websiteResult ? websiteResult.isHealthy : true;
		const apiUp = apiResult ? apiResult.isHealthy : true;
		const allUp = websiteUp && apiUp;

		// スコア反映
		let delta: number;
		if (allUp) {
			delta = UPTIME_BONUS;
		} else {
			delta =
				scoreWeight === "high"
					? DOWNTIME_PENALTY_HIGH
					: DOWNTIME_PENALTY_NORMAL;
		}

		await gamedayRepository.updateTeamScore(eventId, team.teamId, delta);
		await gamedayRepository.updateTeamHealthy(eventId, team.teamId, allUp);

		logger.info(
			{
				teamId: team.teamId,
				websiteUp,
				apiUp,
				delta,
			},
			"ヘルスチェック完了",
		);
	}

	async enforceGameDuration(game: GameState): Promise<boolean> {
		if (!game.startedAt) return true;

		const elapsedMs = Date.now() - new Date(game.startedAt).getTime();
		const durationMs = game.durationMinutes * 60 * 1000;
		const remainingMs = durationMs - elapsedMs;

		// ゲーム終了
		if (remainingMs <= 0) {
			logger.info({ eventId: game.eventId }, "ゲーム時間超過 — 自動停止します");
			await gamedayRepository.stopGame(game.eventId);
			this.stop();
			return false;
		}

		// 残り 30 分以内 → 自動ブラックアウト
		const BLACKOUT_THRESHOLD_MS = 30 * 60 * 1000;
		if (remainingMs <= BLACKOUT_THRESHOLD_MS && !game.blackout) {
			logger.info(
				{ eventId: game.eventId, remainingMs },
				"残り30分 — 自動ブラックアウトを開始します",
			);
			await gamedayRepository.enableBlackout(game.eventId);
		}

		return true;
	}

	async httpCheck(url: string): Promise<HttpCheckResult> {
		const start = Date.now();

		try {
			const response = await fetch(url, {
				method: "GET",
				signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
			});

			const responseTimeMs = Date.now() - start;
			const isHealthy = response.status >= 200 && response.status < 300;

			return {
				isHealthy,
				statusCode: response.status,
				responseTimeMs,
			};
		} catch {
			const responseTimeMs = Date.now() - start;
			return {
				isHealthy: false,
				statusCode: null,
				responseTimeMs,
			};
		}
	}
}

// シングルトンインスタンス
export const auditorService = new AuditorService();
