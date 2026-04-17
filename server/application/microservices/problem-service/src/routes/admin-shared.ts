/**
 * Admin routes shared dependencies
 *
 * リポジトリインスタンス、ロガー、認証ミドルウェアを共有
 */

import { createLogger } from "../lib/logger";
import { Hono } from "hono";
import {
	authenticateRequest,
	hasRole,
	UserRole,
	type AuthenticatedUser,
} from "../auth";
import {
	PrismaEventRepository,
	PrismaProblemRepository,
	PrismaMarketplaceRepository,
	PrismaProblemTemplateRepository,
} from "../repositories";
import {
	CompetitorAccountRepository,
} from "../repositories/competitor-account-repository";
import {
	GameDayDeploymentJobRepository,
} from "../repositories/gameday-deployment-job-repository";

export const logger = createLogger("admin-routes");

// リポジトリインスタンス
export const eventRepository = new PrismaEventRepository();
export const problemRepository = new PrismaProblemRepository();
export const marketplaceRepository = new PrismaMarketplaceRepository();
export const templateRepository = new PrismaProblemTemplateRepository();
export const competitorAccountRepo = new CompetitorAccountRepository();
export const gamedayJobRepo = new GameDayDeploymentJobRepository();

/**
 * 認証ミドルウェアを適用した Hono ルーターを作成する
 */
export function createAdminRouter(): InstanceType<typeof Hono> {
	const router = new Hono();

	router.use("*", async (c, next) => {
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

		// 管理者権限チェック
		const isAdmin =
			hasRole(authContext.user, UserRole.PLATFORM_ADMIN) ||
			hasRole(authContext.user, UserRole.TENANT_ADMIN) ||
			hasRole(authContext.user, UserRole.ORGANIZER);

		if (!isAdmin) {
			return c.json({ error: "Forbidden: Admin access required" }, 403);
		}

		c.set("user", authContext.user);
		return next();
	});

	return router;
}

// Re-export types used across sub-routers
export type { AuthenticatedUser };
