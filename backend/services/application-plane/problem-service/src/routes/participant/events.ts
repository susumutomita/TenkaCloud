/**
 * 参加者API - イベント関連ルート
 *
 * - イベント一覧・詳細取得
 * - イベント登録・登録キャンセル
 */

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { createLogger } from "../../lib/logger";
import type { AuthenticatedUser } from "../../auth";
import {
	PrismaEventRepository,
	PrismaProblemRepository,
	getEventWithProblems,
} from "../../repositories";
import type { EventStatus, EventType, ScoringCriterion } from "../../types";

const logger = createLogger("participant-events");

const eventRoutes = new Hono();

const eventRepository = new PrismaEventRepository();
const problemRepository = new PrismaProblemRepository();

/**
 * 参加可能なイベント一覧を取得
 */
eventRoutes.get(
	"/events",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "イベント一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;
	const { status, type, limit = "50", offset = "0" } = c.req.query();

	try {
		const options: {
			type?: EventType;
			status?: EventStatus | EventStatus[];
			limit?: number;
			offset?: number;
		} = {
			limit: Number.parseInt(limit, 10),
			offset: Number.parseInt(offset, 10),
		};

		if (status) {
			options.status = status.split(",") as EventStatus[];
		}
		if (type === "gameday" || type === "jam") {
			options.type = type as EventType;
		}

		const events = user.tenantId
			? await eventRepository.findByTenant(user.tenantId, options)
			: await eventRepository.findAll(options);
		const total = await eventRepository.count({
			...options,
			tenantId: user.tenantId,
		});

		const eventsWithRegistration = await Promise.all(
			events.map(async (event) => {
				const [isRegistered, participantCount] = await Promise.all([
					eventRepository
						.isParticipantRegistered(event.id, user.id)
						.catch(() => false),
					eventRepository.getParticipantCount(event.id).catch(() => 0),
				]);
				return {
					...event,
					problemCount: 0,
					participantCount,
					isRegistered,
					myRank: undefined,
					myScore: undefined,
				};
			}),
		);

		return c.json({ events: eventsWithRegistration, total });
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as { code: string }).code === "ECONNREFUSED"
		) {
				return c.json({ error: "Service unavailable", message: "Failed to fetch events" }, 503);
		}
		logger.error({ error }, "Failed to fetch events");
		return c.json({ error: "Failed to fetch events" }, 500);
	}
});

/**
 * 参加中のイベント一覧を取得
 */
eventRoutes.get(
	"/events/me",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "参加中イベント一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;

	try {
		const events = user.tenantId
			? await eventRepository.findByTenant(user.tenantId, {
					status: ["active", "scheduled"] as EventStatus[],
					limit: 50,
				})
			: [];

		return c.json({ events });
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as { code: string }).code === "ECONNREFUSED"
		) {
				return c.json({ error: "Service unavailable", message: "Failed to fetch events" }, 503);
		}
		logger.error({ error }, "Failed to fetch my events");
		return c.json({ error: "Failed to fetch events" }, 500);
	}
});

/**
 * イベント詳細を取得
 */
eventRoutes.get(
	"/events/:eventId",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "イベント詳細取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "イベントが見つかりません" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;
	const { eventId } = c.req.param();

	try {
		const result = await getEventWithProblems(eventId);

		if (!result) {
			return c.json({ error: "Event not found" }, 404);
		}

		const { event: eventData, problems: eventProblems } = result;

		if (eventData.tenantId !== user.tenantId) {
			return c.json({ error: "Event not found" }, 404);
		}

		const problems = await Promise.all(
			eventProblems.map(async (ep) => {
				const problem = await problemRepository.findById(ep.problemId);
				const maxScore =
					problem?.scoring.criteria?.reduce(
						(sum: number, c: ScoringCriterion) => sum + c.maxPoints,
						0,
					) || 0;

				return {
					id: ep.problemId,
					title: problem?.title || "Unknown",
					type: problem?.type || "gameday",
					category: problem?.category || "architecture",
					difficulty: problem?.difficulty || "medium",
					overview: problem?.description.overview || "",
					objectives: problem?.description.objectives || [],
					order: ep.order,
					unlockTime: ep.unlockTime?.toISOString(),
					isUnlocked: !ep.unlockTime || new Date() >= ep.unlockTime,
					pointMultiplier: ep.pointMultiplier,
					maxScore,
					myScore: undefined,
					isCompleted: false,
					estimatedTimeMinutes: problem?.description.estimatedTime,
				};
			}),
		);

		const [isRegistered, participantCount] = await Promise.all([
			eventRepository.isParticipantRegistered(eventId, user.id),
			eventRepository.getParticipantCount(eventId),
		]);

		return c.json({
			id: eventData.id,
			name: eventData.name,
			type: eventData.type.toLowerCase(),
			status: eventData.status.toLowerCase(),
			startTime: eventData.startTime.toISOString(),
			endTime: eventData.endTime.toISOString(),
			timezone: eventData.timezone,
			participantType: eventData.participantType.toLowerCase(),
			cloudProvider: eventData.cloudProvider.toLowerCase(),
			regions: eventData.regions,
			scoringType: eventData.scoringType.toLowerCase(),
			leaderboardVisible: eventData.leaderboardVisible,
			problemCount: problems.length,
			participantCount,
			isRegistered,
			problems,
			teamInfo: undefined,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch event");
		return c.json({ error: "Failed to fetch event" }, 500);
	}
});

/**
 * イベントに登録
 */
eventRoutes.post(
	"/events/:eventId/register",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "イベント登録",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "イベントが見つかりません" },
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

		if (event.tenantId !== user.tenantId) {
			return c.json({ error: "Event not found" }, 404);
		}

		if (event.status !== "scheduled" && event.status !== "active") {
			return c.json({ error: "Event is not open for registration" }, 400);
		}

		const alreadyRegistered = await eventRepository.isParticipantRegistered(
			eventId,
			user.id,
		);
		if (alreadyRegistered) {
			return c.json({ success: true, message: "Already registered" });
		}

		await eventRepository.registerParticipant(eventId, user.id);

		return c.json({
			success: true,
			message: "Successfully registered for the event",
		});
	} catch (error) {
		logger.error({ error }, "Failed to register for event");
		return c.json({ error: "Failed to register" }, 500);
	}
});

/**
 * イベント登録をキャンセル
 */
eventRoutes.post(
	"/events/:eventId/unregister",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "イベント登録キャンセル",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "イベントが見つかりません" },
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

		if (event.tenantId !== user.tenantId) {
			return c.json({ error: "Event not found" }, 404);
		}

		if (event.status === "active") {
			return c.json({ error: "Cannot unregister from an active event" }, 400);
		}

		await eventRepository.unregisterParticipant(eventId, user.id);

		return c.json({
			success: true,
			message: "Successfully unregistered from the event",
		});
	} catch (error) {
		logger.error({ error }, "Failed to unregister from event");
		return c.json({ error: "Failed to unregister" }, 500);
	}
});

export { eventRoutes };
