import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) => {
	return c.json({ status: "ok", service: "leaderboard-service" });
});

healthRoutes.get("/ready", async (c) => {
	// TODO: DBコネクション確認を追加
	return c.json({ status: "ready" });
});
