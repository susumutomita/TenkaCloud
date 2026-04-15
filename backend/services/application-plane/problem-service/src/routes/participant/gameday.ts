/**
 * 参加者API - GameDay/JAM 関連ルート
 *
 * JAMチャレンジ詳細・クルー公開・回答提出・チーム参加
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createLogger } from "../../lib/logger";
import type { AuthenticatedUser } from "../../auth";
import {
	PrismaProblemRepository,
	getEventWithProblems,
	prisma as _prisma,
} from "../../repositories";
import { getChallengeDetail } from "../../jam/challenge";
import { openClue, validateAnswer } from "../../jam/scoring";
import type { ScoringCriterion } from "../../types";

const logger = createLogger("participant-gameday");
const gamedayRoutes = new Hono();
const problemRepository = new PrismaProblemRepository();

/** JAMチャレンジ詳細を取得（クルー付き） */
gamedayRoutes.get(
	"/events/:eventId/challenges/:challengeId/jam",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "JAMチャレンジ詳細取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チャレンジが見つかりません" },
		},
	}),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId, challengeId } = c.req.param();

		try {
			const result = await getEventWithProblems(eventId);
			if (!result || result.event.tenantId !== user.tenantId) {
				return c.json({ error: "Event not found" }, 404);
			}

			const { event: eventData, problems: eventProblems } = result;
			if (eventData.type !== "JAM") {
				return c.json({ error: "Not a JAM event" }, 400);
			}

			const eventProblem = eventProblems.find(
				(ep) => ep.problemId === challengeId,
			);
			if (!eventProblem) {
				return c.json({ error: "Challenge not found" }, 404);
			}

			if (_prisma && user.teamId) {
				const detail = await getChallengeDetail(eventId, user.teamId, challengeId);
				if (detail.success && detail.challenge) {
					const ch = detail.challenge;
					return c.json({
						id: challengeId, title: ch.title, type: "jam",
						category: ch.category, difficulty: "",
						overview: ch.description, objectives: [],
						order: eventProblem.order,
						pointMultiplier: eventProblem.pointMultiplier,
						maxScore: ch.taskScoring,
						isUnlocked: !eventProblem.unlockTime || new Date() >= eventProblem.unlockTime,
						isCompleted: ch.completed, myScore: ch.score,
						description: ch.description, instructions: [],
						clues: ch.tasks.flatMap((task) =>
							task.clues.map((clue) => ({
								id: `${task.taskId}:${clue.order}`, order: clue.order,
								title: clue.title,
								content: task.usedClues[clue.order] || "",
								costPoints:
									(clue.order === 0 ? task.clue1PenaltyPoints
										: clue.order === 1 ? task.clue2PenaltyPoints
										: task.clue3PenaltyPoints) || 0,
								isRevealed: clue.order < task.usedClues.length,
								revealedAt: undefined,
							})),
						),
						tasks: ch.tasks, resources: [],
						scoringCriteria: [], answerFormat: "text",
						answerValidation: undefined,
					});
				}
			}

			// フォールバック: DynamoDB の問題データから返す
			const problem = await problemRepository.findById(eventProblem.problemId);
			const maxScore =
				problem?.scoring.criteria?.reduce(
					(sum: number, sc: ScoringCriterion) => sum + sc.maxPoints, 0,
				) || 0;

			return c.json({
				id: problem?.id || eventProblem.problemId,
				title: problem?.title || "Unknown",
				type: problem?.type || "jam",
				category: problem?.category || "architecture",
				difficulty: problem?.difficulty || "medium",
				overview: problem?.description.overview || "",
				objectives: problem?.description.objectives || [],
				order: eventProblem.order,
				pointMultiplier: eventProblem.pointMultiplier,
				maxScore,
				isUnlocked: !eventProblem.unlockTime || new Date() >= eventProblem.unlockTime,
				isCompleted: false, myScore: undefined,
				description: problem?.description.overview || "",
				instructions: problem?.description.objectives || [],
				clues: [], resources: [],
				scoringCriteria: problem?.scoring.criteria || [],
				answerFormat: "text", answerValidation: undefined,
			});
		} catch (error) {
			logger.error({ error }, "Failed to fetch JAM challenge");
			return c.json({ error: "Failed to fetch challenge" }, 500);
		}
	},
);

/** クルーを公開（JAM） — clueId は "taskId:clueOrder" 形式 */
gamedayRoutes.post(
	"/events/:eventId/challenges/:challengeId/clues/:clueId/reveal",
	describeRoute({
		tags: ["Participant / Challenges"], summary: "クルー公開",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" }, 404: { description: "クルーが見つかりません" },
		},
	}),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId, challengeId, clueId } = c.req.param();

		try {
			if (!_prisma) {
				return c.json({
					error: "Clue reveal not yet available",
					message: "Database migration in progress. This feature requires Prisma client.",
				}, 501);
			}
			if (!user.teamId) {
				return c.json({ error: "Team membership required" }, 400);
			}

			const parts = clueId.split(":");
			const taskId = parts.length === 2 ? parts[0] : clueId;
			const clueOrder = parts.length === 2 ? Number.parseInt(parts[1], 10) : 0;

			const result = await openClue(eventId, user.teamId, challengeId, taskId, clueOrder);
			if (!result.success) {
				return c.json({ error: result.message }, 400);
			}

			return c.json({
				id: clueId, order: clueOrder, title: "",
				content: result.message, costPoints: 0,
				isRevealed: true, revealedAt: new Date().toISOString(),
			});
		} catch (error) {
			logger.error({ error }, "Failed to reveal clue");
			return c.json({ error: "Failed to reveal clue" }, 500);
		}
	},
);

const submitAnswerSchema = z.object({
	answer: z.string().min(1),
	titleId: z.string().min(1),
});

/** 回答を提出（JAM） */
gamedayRoutes.post(
	"/events/:eventId/challenges/:challengeId/submit",
	describeRoute({
		tags: ["Participant / Challenges"], summary: "解答提出",
		requestBody: {
			required: true,
			content: { "application/json": { schema: resolver(submitAnswerSchema) } },
		},
		responses: {
			200: { description: "成功" }, 400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" }, 403: { description: "権限エラー" },
			404: { description: "チャレンジが見つかりません" },
		},
	}),
	zValidator("json", submitAnswerSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId, challengeId } = c.req.param();
		const { answer, titleId } = c.req.valid("json");

		try {
			if (!_prisma) {
				return c.json({
					error: "Answer submission not yet available",
					message: "Database migration in progress. This feature requires Prisma client.",
				}, 501);
			}
			if (!user.teamId) {
				return c.json({ error: "Team membership required" }, 400);
			}

			const result = await validateAnswer(eventId, user.teamId, challengeId, titleId, answer);
			const submissionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

			return c.json({
				id: submissionId, problemId: challengeId, eventId, titleId,
				submittedAt: new Date().toISOString(), status: "completed",
				score: result.correct ? 100 : 0, maxScore: 100,
				answer, isCorrect: result.correct, message: result.message,
				cluesUsed: 0, clueDeduction: 0,
			});
		} catch (error) {
			logger.error({ error }, "Failed to submit answer");
			return c.json({ error: "Failed to submit answer" }, 500);
		}
	},
);

// ====================
// チーム管理
// ====================

/** 自分のチーム情報を取得 */
gamedayRoutes.get(
	"/events/:eventId/team",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チーム情報取得",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" }, 404: { description: "チームが見つかりません" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();
	try {
		return c.json({ error: "Team not found" }, 404);
	} catch (error) {
		logger.error({ error }, "Failed to fetch team");
		return c.json({ error: "Failed to fetch team" }, 500);
	}
});

const createTeamSchema = z.object({ name: z.string().min(1).max(50) });

/** チームを作成 */
gamedayRoutes.post(
	"/events/:eventId/team",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チーム作成",
		requestBody: {
			required: true,
			content: { "application/json": { schema: resolver(createTeamSchema) } },
		},
		responses: {
			201: { description: "チーム作成成功" }, 400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" }, 403: { description: "権限エラー" },
		},
	}),
	zValidator("json", createTeamSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId: _eventId } = c.req.param();
		const { name } = c.req.valid("json");
		try {
			const inviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();
			return c.json({
				id: `team_${Date.now()}`, name,
				members: [{
					id: user.id, name: user.username || "Unknown",
					email: user.email || "", role: "captain",
					joinedAt: new Date().toISOString(),
				}],
				captainId: user.id, inviteCode,
			});
		} catch (error) {
			logger.error({ error }, "Failed to create team");
			return c.json({ error: "Failed to create team" }, 500);
		}
	},
);

const joinTeamSchema = z.object({ inviteCode: z.string().min(1) });

/** チームに参加 */
gamedayRoutes.post(
	"/events/:eventId/team/join",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チーム参加",
		requestBody: {
			required: true,
			content: { "application/json": { schema: resolver(joinTeamSchema) } },
		},
		responses: {
			200: { description: "成功" }, 400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" }, 403: { description: "権限エラー" },
			404: { description: "チームが見つかりません" },
		},
	}),
	zValidator("json", joinTeamSchema),
	async (c) => {
		const { eventId: _eventId } = c.req.param();
		const { inviteCode: _inviteCode } = c.req.valid("json");
		try {
			return c.json({
				id: "team_example", name: "Example Team",
				members: [], captainId: "captain_id",
			});
		} catch (error) {
			logger.error({ error }, "Failed to join team");
			return c.json({ error: "Failed to join team" }, 500);
		}
	},
);

/** チームから離脱 */
gamedayRoutes.post(
	"/events/:eventId/team/leave",
	describeRoute({
		tags: ["Participant / Teams"], summary: "チーム離脱",
		responses: {
			200: { description: "成功" }, 401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();
	try {
		return c.json({ success: true, message: "Successfully left the team" });
	} catch (error) {
		logger.error({ error }, "Failed to leave team");
		return c.json({ error: "Failed to leave team" }, 500);
	}
});

export { gamedayRoutes };
