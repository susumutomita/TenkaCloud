/**
 * ダッシュボード（管理者ビュー）ルート
 */

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import {
	getEventDashboard,
	getChallengeStatistics,
	getLeaderboard,
	saveLeaderboardSnapshot,
} from "../jam/dashboard";
import { getEventLogs } from "../jam/eventlog";

const dashboardRoutes = new Hono();

// イベント全体ダッシュボード
dashboardRoutes.get(
	"/events/:eventId/dashboard",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベントダッシュボード取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const dashboard = await getEventDashboard(eventId);
	return c.json(dashboard);
});

// リーダーボード
dashboardRoutes.get(
	"/events/:eventId/leaderboard",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "リーダーボード取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const limit = parseInt(c.req.query("limit") || "100");
	const leaderboard = await getLeaderboard(eventId, limit);
	return c.json({ leaderboard });
});

// リーダーボードスナップショット保存
dashboardRoutes.post(
	"/events/:eventId/leaderboard/snapshot",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "リーダーボードスナップショット保存",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	await saveLeaderboardSnapshot(eventId);
	return c.json({ success: true, message: "Leaderboard snapshot saved" });
});

// チャレンジ統計
dashboardRoutes.get(
	"/events/:eventId/challenges/stats",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "チャレンジ統計取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const stats = await getChallengeStatistics(eventId);
	return c.json({ stats });
});

// イベントログ
dashboardRoutes.get(
	"/events/:eventId/logs",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベントログ取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const teamName = c.req.query("teamName");
	const limit = parseInt(c.req.query("limit") || "50");
	const offset = parseInt(c.req.query("offset") || "0");

	const result = await getEventLogs(eventId, { teamName, limit, offset });
	return c.json(result);
});

export { dashboardRoutes };
