import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
	eventIdSchema,
	startGameSchema,
	initGameSchema,
	faultInjectionSchema,
	seedAttacksSchema,
	registerTeamSchema,
} from "../schemas";
import {
	initGame,
	startGame,
	stopGame,
	getGameStatus,
	toggleScoreWeight,
	toggleBlackout,
	executeFaultInjection,
	listTeams,
	listAttackLogs,
	seedAttackCatalog,
	GameNotFoundError,
	GameAlreadyExistsError,
	ConcurrentModificationError,
	CrossTenantAccessError,
} from "../services/game-controller";
import {
	registerTeam,
	TeamAlreadyExistsError,
} from "../services/dashboard-service";
import { auditorService } from "../services/auditor-service";

export const adminRoutes = new Hono();

// ゲーム開始
adminRoutes.post("/game/start", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = startGameSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const result = await startGame(
			parsed.data.eventId,
			tenantId,
			parsed.data.durationMinutes,
		);
		return c.json(result, StatusCodes.CREATED);
	} catch (error) {
		if (error instanceof GameAlreadyExistsError) {
			return c.json({ error: error.message }, StatusCodes.CONFLICT);
		}
		throw error;
	}
});

// ゲーム初期化（isRunning: false で作成、イベント作成時に自動呼び出し）
adminRoutes.post("/game/init", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = initGameSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const result = await initGame(
			parsed.data.eventId,
			parsed.data.tenantId,
			parsed.data.durationMinutes,
		);
		return c.json(result, StatusCodes.CREATED);
	} catch (error) {
		if (error instanceof GameAlreadyExistsError) {
			return c.json({ error: error.message }, StatusCodes.CONFLICT);
		}
		throw error;
	}
});

// ゲーム停止
adminRoutes.post("/game/stop", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = eventIdSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const result = await stopGame(parsed.data.eventId, tenantId);
		return c.json(result, StatusCodes.OK);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// ゲーム状態取得
adminRoutes.get("/game/status", async (c) => {
	const eventId = c.req.query("eventId");
	if (!eventId) {
		return c.json({ error: "eventId は必須です" }, StatusCodes.BAD_REQUEST);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const result = await getGameStatus(eventId, tenantId);
		if (!result) {
			return c.json({ error: "ゲームが見つかりません" }, StatusCodes.NOT_FOUND);
		}
		return c.json(result, StatusCodes.OK);
	} catch (error) {
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// スコア重み切替
adminRoutes.post("/score-weight/toggle", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = eventIdSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const result = await toggleScoreWeight(parsed.data.eventId, tenantId);
		return c.json(result, StatusCodes.OK);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof ConcurrentModificationError) {
			return c.json({ error: error.message }, StatusCodes.CONFLICT);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// ブラックアウト切替
adminRoutes.post("/blackout/toggle", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = eventIdSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const result = await toggleBlackout(parsed.data.eventId, tenantId);
		return c.json(result, StatusCodes.OK);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof ConcurrentModificationError) {
			return c.json({ error: error.message }, StatusCodes.CONFLICT);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// 障害注入
adminRoutes.post("/fault-injection/execute", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = faultInjectionSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const result = await executeFaultInjection(
			parsed.data.eventId,
			parsed.data.teamId,
			parsed.data.attackSlug,
			tenantId,
		);
		return c.json(result, StatusCodes.CREATED);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// 全チーム状態一覧
adminRoutes.get("/teams", async (c) => {
	const eventId = c.req.query("eventId");
	if (!eventId) {
		return c.json({ error: "eventId は必須です" }, StatusCodes.BAD_REQUEST);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const teams = await listTeams(eventId, tenantId);
		return c.json({ teams }, StatusCodes.OK);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// 全攻撃履歴
adminRoutes.get("/attack-logs", async (c) => {
	const eventId = c.req.query("eventId");
	if (!eventId) {
		return c.json({ error: "eventId は必須です" }, StatusCodes.BAD_REQUEST);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const logs = await listAttackLogs(eventId, tenantId);
		return c.json({ logs }, StatusCodes.OK);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// チーム登録
adminRoutes.post("/teams/register", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = registerTeamSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const result = await registerTeam(parsed.data);
		return c.json(result, StatusCodes.CREATED);
	} catch (error) {
		if (error instanceof TeamAlreadyExistsError) {
			return c.json({ error: error.message }, StatusCodes.CONFLICT);
		}
		throw error;
	}
});

// 攻撃カタログシード
adminRoutes.post("/attacks/seed", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = seedAttacksSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	try {
		const tenantId = c.get("auth").tenantId;
		const count = await seedAttackCatalog(parsed.data.eventId, tenantId);
		return c.json({ seeded: count }, StatusCodes.CREATED);
	} catch (error) {
		if (error instanceof GameNotFoundError) {
			return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
		}
		if (error instanceof CrossTenantAccessError) {
			return c.json(
				{ error: "別テナントのリソースにはアクセスできません" },
				StatusCodes.FORBIDDEN,
			);
		}
		throw error;
	}
});

// === Auditor ===

// Auditor 開始
adminRoutes.post("/auditor/start", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (body === null) {
		return c.json(
			{ error: "JSON の解析に失敗しました" },
			StatusCodes.BAD_REQUEST,
		);
	}
	const parsed = eventIdSchema.safeParse(body);
	if (!parsed.success) {
		return c.json(
			{ error: "無効なリクエスト", details: parsed.error.issues },
			StatusCodes.BAD_REQUEST,
		);
	}
	if (auditorService.isRunning()) {
		return c.json(
			{ error: "Auditor は既に起動しています" },
			StatusCodes.CONFLICT,
		);
	}
	auditorService.start(parsed.data.eventId);
	return c.json(
		{ status: "started", eventId: parsed.data.eventId },
		StatusCodes.OK,
	);
});

// Auditor 停止
adminRoutes.post("/auditor/stop", async (c) => {
	if (!auditorService.isRunning()) {
		return c.json(
			{ error: "Auditor は起動していません" },
			StatusCodes.CONFLICT,
		);
	}
	auditorService.stop();
	return c.json({ status: "stopped" }, StatusCodes.OK);
});
