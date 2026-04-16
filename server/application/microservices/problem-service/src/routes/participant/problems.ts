/**
 * 参加者API - チャレンジ（問題）関連ルート
 *
 * - チャレンジ詳細取得
 * - AWSクレデンシャル取得
 * - ヒント公開
 * - 採点リクエスト（GameDay）
 * - 提出履歴取得
 */

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { createLogger } from "../../lib/logger";
import type { AuthenticatedUser } from "../../auth";
import {
	PrismaProblemRepository,
	getEventWithProblems,
} from "../../repositories";
import type { ScoringCriterion } from "../../types";

const logger = createLogger("participant-problems");

const problemRoutes = new Hono();

const problemRepository = new PrismaProblemRepository();

/**
 * チャレンジ詳細を取得
 */
problemRoutes.get(
	"/events/:eventId/challenges/:challengeId",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "チャレンジ詳細取得",
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

		const eventProblem = eventProblems.find(
			(ep) => ep.problemId === challengeId,
		);
		if (!eventProblem) {
			return c.json({ error: "Challenge not found" }, 404);
		}

		const problem = await problemRepository.findById(eventProblem.problemId);

		if (eventProblem.unlockTime && new Date() < eventProblem.unlockTime) {
			return c.json({ error: "Challenge is locked" }, 403);
		}

		if (eventData.status !== "ACTIVE") {
			return c.json({ error: "Event is not active" }, 403);
		}

		const maxScore =
			problem?.scoring.criteria?.reduce(
				(sum: number, sc: ScoringCriterion) => sum + sc.maxPoints,
				0,
			) || 0;

		return c.json({
			id: problem?.id || eventProblem.problemId,
			title: problem?.title || "Unknown",
			type: problem?.type || "gameday",
			category: problem?.category || "architecture",
			difficulty: problem?.difficulty || "medium",
			overview: problem?.description.overview || "",
			objectives: problem?.description.objectives || [],
			order: eventProblem.order,
			pointMultiplier: eventProblem.pointMultiplier,
			maxScore,
			isUnlocked: true,
			isCompleted: false,
			myScore: undefined,
			estimatedTimeMinutes: problem?.description.estimatedTime,
			description: problem?.description.overview || "",
			instructions: problem?.description.objectives || [],
			hints: (problem?.description.hints || []).map(
				(_hint: string, index: number) => ({
					id: `hint-${index}`,
					content: "",
					costPoints: 10,
					isRevealed: false,
				}),
			),
			resources: [],
			scoringCriteria: (problem?.scoring.criteria || []).map(
				(sc: ScoringCriterion) => ({
					name: sc.name,
					description: sc.description || "",
					maxPoints: sc.maxPoints,
					currentPoints: undefined,
					isPassed: undefined,
				}),
			),
			awsAccountId: undefined,
			awsConsoleUrl: undefined,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch challenge");
		return c.json({ error: "Failed to fetch challenge" }, 500);
	}
});

/**
 * AWS クレデンシャルを取得
 */
problemRoutes.get(
	"/events/:eventId/challenges/:challengeId/credentials",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "AWSクレデンシャル取得",
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

			const eventProblem = result.problems.find(
				(ep) => ep.problemId === challengeId,
			);
			if (!eventProblem) {
				return c.json({ error: "Challenge not found" }, 404);
			}

			return c.json(
				{
					error: "Credential provisioning not yet implemented",
					message:
						"AWS credentials will be provided when the competition infrastructure is deployed",
				},
				501,
			);
		} catch (error) {
			logger.error({ error }, "Failed to get credentials");
			return c.json({ error: "Failed to get credentials" }, 500);
		}
	},
);

/**
 * ヒントを公開
 */
problemRoutes.post(
	"/events/:eventId/challenges/:challengeId/hints/:hintId/reveal",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "ヒント公開",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "ヒントが見つかりません" },
		},
	}),
	async (c) => {
		const {
			eventId: _eventId,
			challengeId: _challengeId,
			hintId,
		} = c.req.param();

		try {
			return c.json({
				id: hintId,
				content: "ヒントの内容がここに表示されます",
				costPoints: 10,
				isRevealed: true,
			});
		} catch (error) {
			logger.error({ error }, "Failed to reveal hint");
			return c.json({ error: "Failed to reveal hint" }, 500);
		}
	},
);

/**
 * 採点をリクエスト（GameDay）
 */
problemRoutes.post(
	"/events/:eventId/challenges/:challengeId/score",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "採点リクエスト",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チャレンジが見つかりません" },
		},
	}),
	async (c) => {
		const { eventId: _eventId, challengeId: _challengeId } = c.req.param();

		try {
			const submissionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

			return c.json({
				submissionId,
				message: "採点リクエストを受け付けました。結果は数分後に反映されます。",
			});
		} catch (error) {
			logger.error({ error }, "Failed to request scoring");
			return c.json({ error: "Failed to request scoring" }, 500);
		}
	},
);

/**
 * 提出履歴を取得
 */
problemRoutes.get(
	"/events/:eventId/challenges/:challengeId/submissions",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "提出履歴取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チャレンジが見つかりません" },
		},
	}),
	async (c) => {
		const { eventId: _eventId, challengeId: _challengeId } = c.req.param();

		try {
			return c.json({ submissions: [] });
		} catch (error) {
			logger.error({ error }, "Failed to fetch submissions");
			return c.json({ error: "Failed to fetch submissions" }, 500);
		}
	},
);

/**
 * 最新の提出結果を取得
 */
problemRoutes.get(
	"/events/:eventId/challenges/:challengeId/submissions/latest",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "最新提出結果取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "提出履歴が見つかりません" },
		},
	}),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId, challengeId } = c.req.param();

		try {
			if (!_prisma || !user.teamId) {
				return c.json({ error: "No submissions found" }, 404);
			}

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const prisma = _prisma as any;

			const challenge = await prisma.challenge.findFirst({
				where: { eventId, challengeId },
			});

			if (!challenge) {
				return c.json({ error: "No submissions found" }, 404);
			}

			const teamAnswer = await prisma.teamChallengeAnswer.findUnique({
				where: {
					teamId_challengeId: {
						teamId: user.teamId,
						challengeId: challenge.id,
					},
				},
			});

			if (!teamAnswer) {
				return c.json({ error: "No submissions found" }, 404);
			}

			return c.json({
				id: `sub_${teamAnswer.teamId}_${challengeId}`,
				problemId: challengeId,
				eventId,
				submittedAt: new Date().toISOString(),
				status: teamAnswer.completed ? "completed" : "in_progress",
				score: teamAnswer.score,
				maxScore: 100,
				isCorrect: teamAnswer.completed,
				cluesUsed: 0,
				clueDeduction: 0,
			});
		} catch (error) {
			logger.error({ error }, "Failed to fetch latest submission");
			return c.json({ error: "Failed to fetch submission" }, 500);
		}
	},
);

// prisma インスタンスをインポート（最新提出結果取得で使用）
import { prisma as _prisma } from "../../repositories";

export { problemRoutes };
