/**
 * 競技者画面API（Player Portal）
 *
 * - チャレンジ一覧/詳細
 * - チャレンジ開始
 * - 回答検証
 * - クルー開示
 * - チームダッシュボード
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { describeRoute, resolver } from "hono-openapi";
import {
	authenticateRequest,
	canAccessTeam,
	hasAnyRole,
	UserRole,
} from "../auth";
import {
	startChallenge,
	getChallengesForTeam,
	getChallengeDetail,
} from "../jam/challenge";
import { validateAnswer, openClue } from "../jam/scoring";
import { getTeamDashboard, getLeaderboard } from "../jam/dashboard";

const playerRouter = new Hono();

// 認証ミドルウェア
playerRouter.use("*", async (c, next) => {
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

	// 競技者またはそれ以上の権限が必要
	const hasAccess = hasAnyRole(authContext.user, [
		UserRole.COMPETITOR,
		UserRole.ORGANIZER,
		UserRole.TENANT_ADMIN,
		UserRole.PLATFORM_ADMIN,
	]);

	if (!hasAccess) {
		return c.json({ error: "Forbidden: Competitor access required" }, 403);
	}

	c.set("user", authContext.user);
	return next();
});

// チームアクセス検証ミドルウェア
const validateTeamAccess = async (
	c: Parameters<Parameters<typeof playerRouter.use>[1]>[0],
	next: () => Promise<void>,
) => {
	const user = c.get("user");
	const teamId = c.req.param("teamId");

	if (teamId && !canAccessTeam(user, teamId)) {
		return c.json({ error: "Forbidden: Cannot access this team" }, 403);
	}

	return next();
};

// ====================
// チャレンジ一覧/詳細
// ====================

// チャレンジ一覧取得
playerRouter.get(
	"/events/:eventId/teams/:teamId/challenges",
	describeRoute({
		tags: ["Player / Challenges"],
		summary: "チャレンジ一覧取得",
		description: "指定チームのチャレンジ一覧を取得します。",
		responses: {
			200: { description: "チャレンジ一覧" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	validateTeamAccess,
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamId = c.req.param("teamId");

		const result = await getChallengesForTeam(eventId, teamId);
		return c.json(result);
	},
);

// チャレンジ詳細取得
playerRouter.get(
	"/events/:eventId/teams/:teamId/challenges/:challengeId",
	describeRoute({
		tags: ["Player / Challenges"],
		summary: "チャレンジ詳細取得",
		description: "指定チャレンジの詳細情報を取得します。",
		responses: {
			200: { description: "チャレンジ詳細" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	validateTeamAccess,
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamId = c.req.param("teamId");
		const challengeId = c.req.param("challengeId");

		const result = await getChallengeDetail(eventId, teamId, challengeId);
		return c.json(result);
	},
);

// ====================
// チャレンジ操作
// ====================

// チャレンジ開始
playerRouter.post(
	"/events/:eventId/teams/:teamId/challenges/:challengeId/start",
	describeRoute({
		tags: ["Player / Challenges"],
		summary: "チャレンジ開始",
		description: "チャレンジを開始します。taskId を指定して環境プロビジョニングを開始します。",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["taskId"],
						properties: {
							taskId: { type: "string", description: "タスクID" },
						},
					},
				},
			},
		},
		responses: {
			200: { description: "チャレンジ開始結果" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	validateTeamAccess,
	zValidator(
		"json",
		z.object({
			taskId: z.string(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamId = c.req.param("teamId");
		const challengeId = c.req.param("challengeId");
		const { taskId } = c.req.valid("json");

		const result = await startChallenge(eventId, teamId, challengeId, taskId);
		return c.json(result);
	},
);

// 回答検証
playerRouter.post(
	"/events/:eventId/teams/:teamId/challenges/:challengeId/tasks/:taskId/validate",
	describeRoute({
		tags: ["Player / Challenges"],
		summary: "回答検証",
		description: "タスクに対する回答を検証し、採点結果を返します。",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["answer"],
						properties: {
							answer: { type: "string", description: "回答内容" },
						},
					},
				},
			},
		},
		responses: {
			200: { description: "採点結果" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	validateTeamAccess,
	zValidator(
		"json",
		z.object({
			answer: z.string(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamId = c.req.param("teamId");
		const challengeId = c.req.param("challengeId");
		const taskId = c.req.param("taskId");
		const { answer } = c.req.valid("json");

		const result = await validateAnswer(
			eventId,
			teamId,
			challengeId,
			taskId,
			answer,
		);
		return c.json(result);
	},
);

// クルー開示
playerRouter.post(
	"/events/:eventId/teams/:teamId/challenges/:challengeId/tasks/:taskId/clue",
	describeRoute({
		tags: ["Player / Challenges"],
		summary: "クルー開示",
		description: "指定順序のクルー（ヒント）を開示します（1〜3）。",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["clueOrder"],
						properties: {
							clueOrder: {
								type: "integer",
								minimum: 1,
								maximum: 3,
								description: "クルーの順序（1〜3）",
							},
						},
					},
				},
			},
		},
		responses: {
			200: { description: "クルー内容" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	validateTeamAccess,
	zValidator(
		"json",
		z.object({
			clueOrder: z.number().min(1).max(3),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamId = c.req.param("teamId");
		const challengeId = c.req.param("challengeId");
		const taskId = c.req.param("taskId");
		const { clueOrder } = c.req.valid("json");

		const result = await openClue(
			eventId,
			teamId,
			challengeId,
			taskId,
			clueOrder,
		);
		return c.json(result);
	},
);

// ====================
// チームダッシュボード
// ====================

// チームダッシュボード取得
playerRouter.get(
	"/events/:eventId/teams/:teamId/dashboard",
	describeRoute({
		tags: ["Player / Dashboard"],
		summary: "チームダッシュボード取得",
		description: "チームのスコア・進捗・チャレンジ状況をまとめて取得します。",
		responses: {
			200: { description: "ダッシュボードデータ" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	validateTeamAccess,
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamId = c.req.param("teamId");

		const dashboard = await getTeamDashboard(eventId, teamId);
		return c.json(dashboard);
	},
);

// リーダーボード（競技者ビュー）
playerRouter.get(
	"/events/:eventId/leaderboard",
	describeRoute({
		tags: ["Player / Dashboard"],
		summary: "リーダーボード取得（競技者ビュー）",
		description: "イベントのリーダーボードを取得します（チーム名・スコア・完了チャレンジ数のみ）。",
		responses: {
			200: { description: "リーダーボード" },
			401: { description: "認証エラー" },
		},
	}),
	async (c) => {
		const eventId = c.req.param("eventId");
		const limit = parseInt(c.req.query("limit") || "50");
		const leaderboard = await getLeaderboard(eventId, limit);

		// 競技者向けには簡略化したリーダーボードを返す
		const publicLeaderboard = leaderboard.map((entry) => ({
			rank: entry.rank,
			teamName: entry.teamName,
			score: entry.score,
			completedChallenges: entry.completedChallenges,
		}));

		return c.json({ leaderboard: publicLeaderboard });
	},
);

export { playerRouter };
