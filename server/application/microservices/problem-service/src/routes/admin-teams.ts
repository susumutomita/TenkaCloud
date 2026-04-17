/**
 * チーム管理ルート
 */

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	registerTeamToContest,
	getContestTeams,
} from "../jam/contest";

const teamRoutes = new Hono();

// チーム登録
teamRoutes.post(
	"/events/:eventId/teams",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "チーム登録",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["teamName"],
						properties: {
							teamName: { type: "string" },
							members: {
								type: "array",
								items: { type: "string" },
							},
						},
					},
				},
			},
		},
		responses: {
			201: { description: "作成成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	zValidator(
		"json",
		z.object({
			teamName: z.string(),
			members: z.array(z.string()).optional(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const teamData = c.req.valid("json");

		const result = await registerTeamToContest(eventId, teamData);
		return c.json(result, result.success ? 201 : 400);
	},
);

// チーム一覧取得
teamRoutes.get(
	"/events/:eventId/teams",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "チーム一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const teams = await getContestTeams(eventId);
	return c.json({ teams });
});

export { teamRoutes };
