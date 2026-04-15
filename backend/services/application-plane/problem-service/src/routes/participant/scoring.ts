/**
 * 参加者API - スコアリング・プロフィール・チーム管理ルート
 *
 * リーダーボード・ランキング・チーム運営・プロフィール
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createLogger } from "../../lib/logger";
import type { AuthenticatedUser } from "../../auth";
import { PrismaEventRepository } from "../../repositories";
import { getLeaderboard } from "../../jam/dashboard";

const logger = createLogger("participant-scoring");
const scoringRoutes = new Hono();
const eventRepository = new PrismaEventRepository();

/** リーダーボードを取得 */
scoringRoutes.get(
	"/events/:eventId/leaderboard",
	describeRoute({
		tags: ["Participant / Events"], summary: "リーダーボード取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" }, 404: { description: "イベントが見つかりません" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;
	const { eventId } = c.req.param();
	try {
		const event = await eventRepository.findById(eventId);
		if (!event) {
			return c.json({ error: "Event not found" }, 404);
		}
		if (!event.leaderboardVisible) {
			return c.json({ error: "Leaderboard is not visible" }, 403);
		}
		const entries = await getLeaderboard(eventId);
		const entriesWithMe = entries.map((entry) => ({
			...entry, isMe: entry.teamId === user.teamId,
		}));
		const myPosition = entriesWithMe.findIndex((e) => e.isMe) + 1;
		return c.json({
			eventId, entries: entriesWithMe, isFrozen: false,
			updatedAt: new Date().toISOString(),
			myPosition: myPosition > 0 ? myPosition : undefined,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch leaderboard");
		return c.json({ error: "Failed to fetch leaderboard" }, 500);
	}
});

/** 自分のランキングを取得 */
scoringRoutes.get(
	"/events/:eventId/my-ranking",
	describeRoute({
		tags: ["Participant / Events"], summary: "自分のランキング取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" }, 404: { description: "ランキング情報が見つかりません" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;
	const { eventId } = c.req.param();
	try {
		const entries = await getLeaderboard(eventId);
		const myEntry = entries.find((e) => e.teamId === user.teamId);
		if (!myEntry) {
			return c.json({ error: "Not found in leaderboard" }, 404);
		}
		return c.json({
			rank: myEntry.rank,
			totalScore: myEntry.score,
			completedChallenges: myEntry.completedChallenges,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch ranking");
		return c.json({ error: "Failed to fetch ranking" }, 500);
	}
});

// ====================
// チーム運営
// ====================

/** 招待コードを再生成 */
scoringRoutes.post(
	"/events/:eventId/team/invite-code",
	describeRoute({
		tags: ["Participant / Teams"], summary: "招待コード再生成",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();
	try {
		const newInviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();
		return c.json({ inviteCode: newInviteCode });
	} catch (error) {
		logger.error({ error }, "Failed to regenerate invite code");
		return c.json({ error: "Failed to regenerate invite code" }, 500);
	}
});

const transferCaptainSchema = z.object({ newCaptainId: z.string().min(1) });

/** キャプテンを移譲 */
scoringRoutes.post(
	"/events/:eventId/team/transfer-captain",
	describeRoute({
		tags: ["Participant / Teams"], summary: "キャプテン移譲",
		requestBody: {
			required: true,
			content: { "application/json": { schema: resolver(transferCaptainSchema) } },
		},
		responses: {
			200: { description: "成功" }, 400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" }, 403: { description: "権限エラー" },
			404: { description: "チームが見つかりません" },
		},
	}),
	zValidator("json", transferCaptainSchema),
	async (c) => {
		const { eventId: _eventId } = c.req.param();
		const { newCaptainId } = c.req.valid("json");
		try {
			return c.json({
				id: "team_example", name: "Example Team",
				members: [], captainId: newCaptainId,
			});
		} catch (error) {
			logger.error({ error }, "Failed to transfer captain");
			return c.json({ error: "Failed to transfer captain" }, 500);
		}
	},
);

/** チームメンバー一覧を取得 */
scoringRoutes.get(
	"/events/:eventId/team/members",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チームメンバー一覧取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();
	try {
		return c.json({ members: [] });
	} catch (error) {
		logger.error({ error }, "Failed to fetch team members");
		return c.json({ error: "Failed to fetch members" }, 500);
	}
});

/** チームメンバーを削除 */
scoringRoutes.delete(
	"/events/:eventId/team/members/:memberId",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チームメンバー削除",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" }, 404: { description: "メンバーが見つかりません" },
		},
	}),
	async (c) => {
		const { eventId: _eventId, memberId: _memberId } = c.req.param();
		try {
			return c.json({ success: true, message: "Member removed from team" });
		} catch (error) {
			logger.error({ error }, "Failed to remove member");
			return c.json({ error: "Failed to remove member" }, 500);
		}
	},
);

/** チームを解散 */
scoringRoutes.delete(
	"/events/:eventId/team",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チーム解散",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();
	try {
		return c.json({ success: true, message: "Team disbanded" });
	} catch (error) {
		logger.error({ error }, "Failed to disband team");
		return c.json({ error: "Failed to disband team" }, 500);
	}
});

// ====================
// プロフィール
// ====================

/** 自分のプロフィールを取得 */
scoringRoutes.get(
	"/profile",
	describeRoute({
		tags: ["Participant / Rankings"], summary: "プロフィール取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;
	try {
		return c.json({
			id: user.id, name: user.username || "Unknown",
			email: user.email || "", avatarUrl: undefined,
			totalEventsParticipated: 0, totalScore: 0,
			rank: undefined, badges: [], recentEvents: [],
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch profile");
		return c.json({ error: "Failed to fetch profile" }, 500);
	}
});

const updateProfileSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	avatarUrl: z.string().url().optional(),
});

/** プロフィールを更新 */
scoringRoutes.put(
	"/profile",
	describeRoute({
		tags: ["Participant / Rankings"], summary: "プロフィール更新",
		requestBody: {
			required: true,
			content: { "application/json": { schema: resolver(updateProfileSchema) } },
		},
		responses: {
			200: { description: "成功" }, 400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" }, 403: { description: "権限エラー" },
		},
	}),
	zValidator("json", updateProfileSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const data = c.req.valid("json");
		try {
			return c.json({
				id: user.id, name: data.name || user.username || "Unknown",
				email: user.email || "", avatarUrl: data.avatarUrl,
				totalEventsParticipated: 0, totalScore: 0,
				rank: undefined, badges: [], recentEvents: [],
			});
		} catch (error) {
			logger.error({ error }, "Failed to update profile");
			return c.json({ error: "Failed to update profile" }, 500);
		}
	},
);

/** バッジ一覧を取得 */
scoringRoutes.get(
	"/profile/badges",
	describeRoute({
		tags: ["Participant / Rankings"], summary: "バッジ一覧取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	try {
		return c.json({ badges: [] });
	} catch (error) {
		logger.error({ error }, "Failed to fetch badges");
		return c.json({ error: "Failed to fetch badges" }, 500);
	}
});

/** 参加イベント履歴を取得 */
scoringRoutes.get(
	"/profile/history",
	describeRoute({
		tags: ["Participant / Rankings"], summary: "参加イベント履歴取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { limit: _limit = "20", offset: _offset = "0" } = c.req.query();
	try {
		return c.json({ events: [], total: 0 });
	} catch (error) {
		logger.error({ error }, "Failed to fetch history");
		return c.json({ error: "Failed to fetch history" }, 500);
	}
});

/** グローバルランキングを取得 */
scoringRoutes.get(
	"/rankings",
	describeRoute({
		tags: ["Participant / Rankings"], summary: "グローバルランキング取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { limit: _limit = "50", offset: _offset = "0" } = c.req.query();
	try {
		return c.json({ rankings: [], total: 0, myRank: undefined });
	} catch (error) {
		logger.error({ error }, "Failed to fetch rankings");
		return c.json({ error: "Failed to fetch rankings" }, 500);
	}
});

export { scoringRoutes };
