/**
 * GameDay サービス HTTP クライアント
 *
 * problem-service からイベント作成時に gameday-service を呼び出して
 * ゲーム状態と攻撃カタログを自動初期化する。
 */

const GAMEDAY_SERVICE_URL =
	process.env.GAMEDAY_SERVICE_URL || "http://localhost:3020";

export interface GamedayInitResult {
	eventId: string;
	tenantId: string;
	isRunning: boolean;
	startedAt: string | null;
	scoreWeight: string;
	blackout: boolean;
	durationMinutes: number;
}

export interface GamedaySeedResult {
	seeded: number;
}

/**
 * GameDay サービスでゲーム状態を初期化する（isRunning: false）
 */
export async function initGameState(params: {
	eventId: string;
	tenantId: string;
	durationMinutes?: number;
}): Promise<GamedayInitResult> {
	const response = await fetch(
		`${GAMEDAY_SERVICE_URL}/api/gameday/admin/game/init`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				eventId: params.eventId,
				tenantId: params.tenantId,
				durationMinutes: params.durationMinutes ?? 240,
			}),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "unknown error");
		throw new Error(
			`GameDay サービスのゲーム初期化に失敗しました: ${response.status} ${errorBody}`,
		);
	}

	return response.json();
}

/**
 * GameDay サービスで攻撃カタログをシードする
 */
export async function seedAttackCatalog(params: {
	eventId: string;
	tenantId: string;
}): Promise<GamedaySeedResult> {
	const response = await fetch(
		`${GAMEDAY_SERVICE_URL}/api/gameday/admin/attacks/seed`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				eventId: params.eventId,
			}),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "unknown error");
		throw new Error(
			`GameDay サービスの攻撃カタログシードに失敗しました: ${response.status} ${errorBody}`,
		);
	}

	return response.json();
}

/**
 * イベント作成時に GameDay サービスを初期化する
 * エラーが発生してもイベント作成自体は失敗させない（graceful degradation）
 */
export async function initializeGamedayService(params: {
	eventId: string;
	tenantId: string;
	durationMinutes?: number;
}): Promise<{ success: boolean; error?: string }> {
	try {
		await initGameState(params);
		await seedAttackCatalog({
			eventId: params.eventId,
			tenantId: params.tenantId,
		});
		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.error(
			`GameDay サービスの初期化に失敗しました (eventId: ${params.eventId}):`,
			message,
		);
		return { success: false, error: message };
	}
}
