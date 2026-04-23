/**
 * イベント CRUD + 問題管理ルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	getEventWithProblems,
	addProblemToEvent,
	removeProblemFromEvent,
} from "../repositories";
import {
	validateTransition,
	InvalidStatusTransitionError,
	getValidTransitions,
} from "../services/event-lifecycle";
import {
	logger,
	eventRepository,
	type AuthenticatedUser,
} from "./admin-shared";

const eventRoutes = new Hono();

// イベントスキーマ
const createEventSchema = z.object({
	name: z.string().min(1),
	type: z.enum(["gameday", "jam"]),
	startTime: z.string().datetime(),
	endTime: z.string().datetime(),
	timezone: z.string().default("Asia/Tokyo"),
	participantType: z.enum(["individual", "team"]),
	maxParticipants: z.number().min(1),
	minTeamSize: z.number().min(1).optional(),
	maxTeamSize: z.number().min(1).optional(),
	cloudProvider: z.enum(["aws", "gcp", "azure", "local"]),
	regions: z.array(z.string()).min(1),
	scoringType: z.enum(["realtime", "batch"]),
	scoringIntervalMinutes: z.number().min(1),
	leaderboardVisible: z.boolean().default(true),
	freezeLeaderboardMinutes: z.number().optional(),
	problemIds: z.array(z.string()).optional(),
});

const updateEventSchema = createEventSchema.partial().extend({
	status: z
		.enum(["draft", "scheduled", "active", "paused", "completed", "cancelled"])
		.optional(),
});

// イベント一覧取得
eventRoutes.get(
	"/events",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベント一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;
	const tenantId = user.tenantId || "default";

	const status = c.req.query("status");
	const type = c.req.query("type");
	const limit = parseInt(c.req.query("limit") || "100");
	const offset = parseInt(c.req.query("offset") || "0");

	try {
		const events = await eventRepository.findByTenant(tenantId, {
			status: status as
				| "draft"
				| "scheduled"
				| "active"
				| "paused"
				| "completed"
				| "cancelled"
				| undefined,
			type: type as "gameday" | "jam" | undefined,
			limit,
			offset,
		});

		const total = await eventRepository.count({
			tenantId,
			type: type as "gameday" | "jam" | undefined,
			status: status as
				| "draft"
				| "scheduled"
				| "active"
				| "paused"
				| "completed"
				| "cancelled"
				| undefined,
		});

		return c.json({ events, total });
	} catch (error) {
		logger.error({ error }, "Failed to get events");
		return c.json({ error: "Failed to get events" }, 500);
	}
});

// イベント詳細取得
eventRoutes.get(
	"/events/:eventId",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベント詳細取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");

	try {
		const result = await getEventWithProblems(eventId);
		if (!result) {
			return c.json({ error: "Event not found" }, 404);
		}

		const { event: eventData, problems } = result;

		// レスポンス形式に変換
		const event = {
			id: eventData.id,
			externalId: eventData.externalId,
			name: eventData.name,
			type: eventData.type.toLowerCase(),
			status: eventData.status.toLowerCase(),
			tenantId: eventData.tenantId,
			startTime: eventData.startTime.toISOString(),
			endTime: eventData.endTime.toISOString(),
			timezone: eventData.timezone,
			participantType: eventData.participantType.toLowerCase(),
			maxParticipants: eventData.maxParticipants,
			minTeamSize: eventData.minTeamSize,
			maxTeamSize: eventData.maxTeamSize,
			cloudProvider: eventData.cloudProvider.toLowerCase(),
			regions: eventData.regions,
			scoringType: eventData.scoringType.toLowerCase(),
			scoringIntervalMinutes: eventData.scoringIntervalMinutes,
			leaderboardVisible: eventData.leaderboardVisible,
			freezeLeaderboardMinutes: eventData.freezeLeaderboardMinutes,
			problemCount: problems.length,
			problems: problems.map((ep) => ({
				problemId: ep.problemId,
				problemTitle:
					(ep as { problem?: { title: string } }).problem?.title || "Unknown",
				order: ep.order,
				unlockTime: ep.unlockTime?.toISOString(),
				pointMultiplier: ep.pointMultiplier,
			})),
			createdAt: eventData.createdAt.toISOString(),
			updatedAt: eventData.updatedAt.toISOString(),
		};

		return c.json(event);
	} catch (error) {
		logger.error({ error }, "Failed to get event");
		return c.json({ error: "Failed to get event" }, 500);
	}
});

// イベント作成
eventRoutes.post(
	"/events",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベント作成",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(createEventSchema),
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
	zValidator("json", createEventSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const tenantId = user.tenantId || "default";
		const data = c.req.valid("json");

		try {
			const event = await eventRepository.create({
				tenantId,
				name: data.name,
				type: data.type,
				status: "draft",
				startTime: new Date(data.startTime),
				endTime: new Date(data.endTime),
				timezone: data.timezone,
				participantType: data.participantType,
				maxParticipants: data.maxParticipants,
				minTeamSize: data.minTeamSize,
				maxTeamSize: data.maxTeamSize,
				cloudProvider: data.cloudProvider,
				regions: data.regions,
				scoringType: data.scoringType,
				scoringIntervalMinutes: data.scoringIntervalMinutes,
				leaderboardVisible: data.leaderboardVisible,
				freezeLeaderboardMinutes: data.freezeLeaderboardMinutes,
				createdBy: user.id,
			});

			// 問題を関連付け
			if (data.problemIds && data.problemIds.length > 0) {
				for (let i = 0; i < data.problemIds.length; i++) {
					await addProblemToEvent(event.id, data.problemIds[i], {
						order: i + 1,
					});
				}
			}

			return c.json(event, 201);
		} catch (error) {
			logger.error({ error }, "Failed to create event");
			return c.json({ error: "Failed to create event" }, 500);
		}
	},
);

// イベント更新
eventRoutes.put(
	"/events/:eventId",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベント更新",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(updateEventSchema),
				},
			},
		},
		responses: {
			200: { description: "成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	zValidator("json", updateEventSchema),
	async (c) => {
		const eventId = c.req.param("eventId");
		const data = c.req.valid("json");

		try {
			const updates: Record<string, unknown> = {};

			if (data.name !== undefined) updates.name = data.name;
			if (data.status !== undefined) updates.status = data.status;
			if (data.startTime !== undefined)
				updates.startTime = new Date(data.startTime);
			if (data.endTime !== undefined) updates.endTime = new Date(data.endTime);
			if (data.timezone !== undefined) updates.timezone = data.timezone;
			if (data.participantType !== undefined)
				updates.participantType = data.participantType;
			if (data.maxParticipants !== undefined)
				updates.maxParticipants = data.maxParticipants;
			if (data.minTeamSize !== undefined)
				updates.minTeamSize = data.minTeamSize;
			if (data.maxTeamSize !== undefined)
				updates.maxTeamSize = data.maxTeamSize;
			if (data.cloudProvider !== undefined)
				updates.cloudProvider = data.cloudProvider;
			if (data.regions !== undefined) updates.regions = data.regions;
			if (data.scoringType !== undefined)
				updates.scoringType = data.scoringType;
			if (data.scoringIntervalMinutes !== undefined)
				updates.scoringIntervalMinutes = data.scoringIntervalMinutes;
			if (data.leaderboardVisible !== undefined)
				updates.leaderboardVisible = data.leaderboardVisible;
			if (data.freezeLeaderboardMinutes !== undefined)
				updates.freezeLeaderboardMinutes = data.freezeLeaderboardMinutes;

			const event = await eventRepository.update(eventId, updates);
			return c.json(event);
		} catch (error) {
			logger.error({ error }, "Failed to update event");
			return c.json({ error: "Failed to update event" }, 500);
		}
	},
);

// イベント削除
eventRoutes.delete(
	"/events/:eventId",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベント削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");

	try {
		await eventRepository.delete(eventId);
		return c.json({ success: true });
	} catch (error) {
		logger.error({ error }, "Failed to delete event");
		return c.json({ error: "Failed to delete event" }, 500);
	}
});

// イベントステータス更新
eventRoutes.patch(
	"/events/:eventId/status",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベントステータス更新",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["status"],
						properties: {
							status: {
								type: "string",
								enum: [
									"draft",
									"scheduled",
									"active",
									"paused",
									"completed",
									"cancelled",
								],
							},
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
			status: z.enum([
				"draft",
				"scheduled",
				"active",
				"paused",
				"completed",
				"cancelled",
			]),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const { status: targetStatus } = c.req.valid("json");

		try {
			const event = await eventRepository.findById(eventId);
			if (!event) {
				return c.json({ error: "Event not found" }, 404);
			}

			validateTransition(event.status, targetStatus);

			await eventRepository.updateStatus(eventId, targetStatus);
			return c.json({
				success: true,
				status: targetStatus,
				validTransitions: getValidTransitions(targetStatus),
			});
		} catch (error) {
			if (error instanceof InvalidStatusTransitionError) {
				return c.json(
					{
						error: error.message,
						currentStatus: error.currentStatus,
						targetStatus: error.targetStatus,
						validTransitions: getValidTransitions(error.currentStatus),
					},
					400,
				);
			}
			logger.error({ error }, "Failed to update event status");
			return c.json({ error: "Failed to update event status" }, 500);
		}
	},
);

// イベントに問題を追加
eventRoutes.post(
	"/events/:eventId/problems",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベントへ問題追加",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["problemId"],
						properties: {
							problemId: { type: "string" },
							order: { type: "number" },
							unlockTime: { type: "string", format: "date-time" },
							pointMultiplier: { type: "number" },
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
			problemId: z.string(),
			order: z.number().optional(),
			unlockTime: z.string().datetime().optional(),
			pointMultiplier: z.number().optional(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const data = c.req.valid("json");

		try {
			const eventProblem = await addProblemToEvent(eventId, data.problemId, {
				order: data.order,
				unlockTime: data.unlockTime ? new Date(data.unlockTime) : undefined,
				pointMultiplier: data.pointMultiplier,
			});
			return c.json(eventProblem, 201);
		} catch (error) {
			logger.error({ error }, "Failed to add problem to event");
			return c.json({ error: "Failed to add problem to event" }, 500);
		}
	},
);

// イベントから問題を削除
eventRoutes.delete(
	"/events/:eventId/problems/:problemId",
	describeRoute({
		tags: ["Admin / Events"],
		summary: "イベントから問題削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const eventId = c.req.param("eventId");
	const problemId = c.req.param("problemId");

	try {
		await removeProblemFromEvent(eventId, problemId);
		return c.json({ success: true });
	} catch (error) {
		logger.error({ error }, "Failed to remove problem from event");
		return c.json({ error: "Failed to remove problem from event" }, 500);
	}
});

export { eventRoutes };
