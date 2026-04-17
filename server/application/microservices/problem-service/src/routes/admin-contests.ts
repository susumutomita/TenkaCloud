/**
 * コンテスト管理 + 問題管理（チャレンジ追加/削除）ルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	startContest,
	stopContest,
	pauseContest,
	resumeContest,
	addChallengeToContest,
	removeChallengeFromContest,
} from "../jam/contest";

const contestRoutes = new Hono();

// コンテスト開始
contestRoutes.post(
	"/events/:eventId/contest/start",
	describeRoute({
		tags: ["Admin / Contest"],
		summary: "コンテスト開始",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["contestName"],
						properties: {
							contestName: { type: "string" },
						},
					},
				},
			},
		},
		responses: {
			200: { description: "成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	zValidator(
		"json",
		z.object({
			contestName: z.string(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const { contestName } = c.req.valid("json");

		const result = await startContest(eventId, contestName);
		return c.json(result);
	},
);

// コンテスト停止
contestRoutes.post(
	"/events/:eventId/contest/stop",
	describeRoute({
		tags: ["Admin / Contest"],
		summary: "コンテスト停止",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["contestName"],
						properties: {
							contestName: { type: "string" },
						},
					},
				},
			},
		},
		responses: {
			200: { description: "成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	zValidator(
		"json",
		z.object({
			contestName: z.string(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const { contestName } = c.req.valid("json");

		const result = await stopContest(eventId, contestName);
		return c.json(result);
	},
);

// コンテスト一時停止
contestRoutes.post(
	"/events/:eventId/contest/pause",
	describeRoute({
		tags: ["Admin / Contest"],
		summary: "コンテスト一時停止",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const result = await pauseContest(eventId);
	return c.json(result);
});

// コンテスト再開
contestRoutes.post(
	"/events/:eventId/contest/resume",
	describeRoute({
		tags: ["Admin / Contest"],
		summary: "コンテスト再開",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const result = await resumeContest(eventId);
	return c.json(result);
});

// 問題スキーマ
const challengeSchema = z.object({
	problemId: z.string(),
	challengeId: z.string(),
	title: z.string(),
	category: z.string(),
	difficulty: z.enum(["easy", "medium", "hard"]),
	description: z.string(),
	region: z.string().optional(),
	sshKeyPairRequired: z.boolean().optional(),
	tasks: z.array(
		z.object({
			titleId: z.string(),
			title: z.string(),
			content: z.string(),
			taskNumber: z.number(),
			answerKey: z.string(),
			clues: z
				.array(
					z.object({
						title: z.string(),
						description: z.string(),
						order: z.number(),
					}),
				)
				.optional(),
			scoring: z.object({
				pointsPossible: z.number(),
				clue1PenaltyPoints: z.number().optional(),
				clue2PenaltyPoints: z.number().optional(),
				clue3PenaltyPoints: z.number().optional(),
			}),
		}),
	),
});

// 問題追加
contestRoutes.post(
	"/events/:eventId/challenges",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "コンテストへチャレンジ追加",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(challengeSchema),
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
	zValidator("json", challengeSchema),
	async (c) => {
		const eventId = c.req.param("eventId");
		const challengeData = c.req.valid("json");

		const result = await addChallengeToContest(eventId, challengeData);
		return c.json(result, result.success ? 201 : 400);
	},
);

// 問題削除
contestRoutes.delete(
	"/events/:eventId/challenges/:challengeId",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "コンテストからチャレンジ削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const challengeId = c.req.param("challengeId");

	const result = await removeChallengeFromContest(eventId, challengeId);
	return c.json(result, result.success ? 200 : 400);
});

export { contestRoutes };
