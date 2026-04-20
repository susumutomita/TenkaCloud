/**
 * API ルーター
 *
 * 管理画面と競技者画面を分離
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { openAPIRouteHandler } from "hono-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { adminRouter } from "./admin";
import { playerRouter } from "./player";
import { participantRouter } from "./participant";
import { internalDeployEventsRoutes } from "./internal-deploy-events";

const app = new Hono();

// ミドルウェア
app.use("*", logger());
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:3000", // Nginx proxy (dev)
			"http://localhost:13000", // Admin App
			"http://localhost:13001", // Participant App
			"http://localhost:13002", // Landing Page
		],
		allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "AuthorizationToken"],
		exposeHeaders: ["X-Request-Id"],
		credentials: true,
	}),
);

// ヘルスチェック
app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		service: "problem-management",
		timestamp: new Date().toISOString(),
	});
});

// API バージョン情報
app.get("/api/version", (c) => {
	return c.json({
		version: "1.0.0",
		name: "TenkaCloud Problem Management API",
		endpoints: {
			admin: "/api/admin",
			player: "/api/player",
			participant: "/api/participant",
		},
	});
});

// ルーターをマウント
// 管理画面API: /api/admin/*
app.route("/api/admin", adminRouter);

// 競技者画面API: /api/player/*
app.route("/api/player", playerRouter);

// 参加者API: /api/participant/*
app.route("/api/participant", participantRouter);

// 内部API: EventBridge API Destination から呼ばれる
// /api/internal/deploy-events
app.route("/api/internal", internalDeployEventsRoutes);

// OpenAPI スペック
app.get(
	"/openapi.json",
	openAPIRouteHandler(app, {
		documentation: {
			info: {
				title: "TenkaCloud Problem Management API",
				version: "1.0.0",
				description:
					"GameDay/JAM 問題管理サービス。管理者・競技者・参加者向け API を提供します。",
			},
			tags: [
				{ name: "Admin / Events", description: "イベント管理 (管理者)" },
				{ name: "Admin / Problems", description: "問題管理 (管理者)" },
				{ name: "Admin / Templates", description: "テンプレート管理 (管理者)" },
				{ name: "Admin / Contest", description: "コンテスト制御 (管理者)" },
				{ name: "Player / Challenges", description: "チャレンジ操作 (競技者)" },
				{ name: "Player / Dashboard", description: "チームダッシュボード (競技者)" },
				{ name: "Participant / Events", description: "イベント参照・登録 (参加者)" },
				{ name: "Participant / Teams", description: "チーム管理 (参加者)" },
				{ name: "Participant / Challenges", description: "チャレンジ・採点 (参加者)" },
				{ name: "Participant / Rankings", description: "ランキング・プロフィール (参加者)" },
			],
			components: {
				securitySchemes: {
					bearerAuth: {
						type: "http",
						scheme: "bearer",
						bearerFormat: "JWT",
						description: "Authorization ヘッダーに JWT トークンを指定",
					},
					tokenAuth: {
						type: "apiKey",
						in: "header",
						name: "AuthorizationToken",
						description: "AuthorizationToken ヘッダーにトークンを指定",
					},
				},
			},
			security: [{ bearerAuth: [] }],
		},
	}),
);

// Scalar API ドキュメント UI
app.get(
	"/docs",
	apiReference({
		url: "/openapi.json",
		pageTitle: "TenkaCloud Problem Management API",
		theme: "default",
	}),
);

// 404 ハンドラー
app.notFound((c) => {
	return c.json(
		{
			error: "Not Found",
			message: `Path ${c.req.path} not found`,
		},
		404,
	);
});

// エラーハンドラー
app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json(
		{
			error: "Internal Server Error",
			message: process.env.NODE_ENV === "development" ? err.message : undefined,
		},
		500,
	);
});

export { app };
export default app;
