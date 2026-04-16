/**
 * 参加者API
 *
 * サブルーターを統合し、認証ミドルウェアを適用する。
 * - events: イベント一覧・詳細・登録
 * - problems: チャレンジ詳細・クレデンシャル・ヒント・採点
 * - gameday: JAMチャレンジ・クルー・回答提出・チーム管理
 * - scoring: リーダーボード・ランキング・プロフィール
 */

import { Hono } from "hono";
import {
	authenticateRequest,
	hasRole,
	UserRole,
} from "../../auth";
import { eventRoutes } from "./events";
import { problemRoutes } from "./problems";
import { gamedayRoutes } from "./gameday";
import { scoringRoutes } from "./scoring";

const participantRouter = new Hono();

// 認証ミドルウェア
participantRouter.use("*", async (c, next) => {
	const authContext = await authenticateRequest({
		authorization: c.req.header("Authorization"),
		authorizationtoken: c.req.header("AuthorizationToken"),
		"x-tenkacloud-dev-user-id": c.req.header("X-TenkaCloud-Dev-User-Id"),
		"x-tenkacloud-dev-tenant-id": c.req.header("X-TenkaCloud-Dev-Tenant-Id"),
		"x-tenkacloud-dev-roles": c.req.header("X-TenkaCloud-Dev-Roles"),
	});

	if (!authContext.isValid || !authContext.user) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	// 参加者権限チェック（COMPETITOR, PLATFORM_ADMIN, TENANT_ADMIN, ORGANIZER）
	const isParticipant =
		hasRole(authContext.user, UserRole.COMPETITOR) ||
		hasRole(authContext.user, UserRole.PLATFORM_ADMIN) ||
		hasRole(authContext.user, UserRole.TENANT_ADMIN) ||
		hasRole(authContext.user, UserRole.ORGANIZER);

	if (!isParticipant) {
		return c.json({ error: "Forbidden: Participant access required" }, 403);
	}

	c.set("user", authContext.user);
	return next();
});

// サブルーターをマウント
participantRouter.route("/", eventRoutes);
participantRouter.route("/", problemRoutes);
participantRouter.route("/", gamedayRoutes);
participantRouter.route("/", scoringRoutes);

export { participantRouter };
