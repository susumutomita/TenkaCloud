import { describe, it, expect } from "vitest";
import { StatusCodes } from "http-status-codes";
import { Hono } from "hono";
import { requireAdmin } from "./auth";
import type { AuthContext } from "./auth";

function createApp(roles: string[]) {
	const app = new Hono();
	app.use("/*", async (c, next) => {
		c.set("auth", {
			userId: "user-1",
			tenantId: "tenant-1",
			roles,
		} satisfies AuthContext);
		await next();
	});
	app.use("/*", requireAdmin);
	app.get("/test", (c) => c.json({ ok: true }));
	return app;
}

describe("requireAdmin ミドルウェア", () => {
	describe("admin ロールを持つユーザーの場合", () => {
		it("リクエストを許可しOK を返すべき", async () => {
			const app = createApp(["admin"]);
			const res = await app.request("/test");
			expect(res.status).toBe(StatusCodes.OK);
			const body = await res.json();
			expect(body.ok).toBe(true);
		});
	});

	describe("admin ロールを持たないユーザーの場合", () => {
		it("FORBIDDEN を返すべき", async () => {
			const app = createApp(["user"]);
			const res = await app.request("/test");
			expect(res.status).toBe(StatusCodes.FORBIDDEN);
			const body = await res.json();
			expect(body.error).toBe("管理者権限が必要です");
		});
	});

	describe("ロールが空の場合", () => {
		it("FORBIDDEN を返すべき", async () => {
			const app = createApp([]);
			const res = await app.request("/test");
			expect(res.status).toBe(StatusCodes.FORBIDDEN);
			const body = await res.json();
			expect(body.error).toBe("管理者権限が必要です");
		});
	});
});
