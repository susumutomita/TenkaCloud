/**
 * 参加者API
 *
 * - イベント参照・登録
 * - チャレンジ取得
 * - 採点リクエスト
 * - リーダーボード
 * - チーム管理
 * - プロフィール
 */

import { createLogger } from "../lib/logger";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	authenticateRequest,
	hasRole,
	UserRole,
	type AuthenticatedUser,
} from "../auth";
import {
	PrismaEventRepository,
	PrismaProblemRepository,
	getEventWithProblems,
	prisma as _prisma,
} from "../repositories";
import { getLeaderboard } from "../jam/dashboard";
import { getChallengeDetail } from "../jam/challenge";
import { openClue, validateAnswer } from "../jam/scoring";
import type { EventStatus, EventType, ScoringCriterion } from "../types";

const logger = createLogger("participant-routes");

const participantRouter = new Hono();

// リポジトリインスタンス
const eventRepository = new PrismaEventRepository();
const problemRepository = new PrismaProblemRepository();

// 認証ミドルウェア
participantRouter.use("*", async (c, next) => {
	const authContext = await authenticateRequest({
		authorization: c.req.header("Authorization"),
		authorizationtoken: c.req.header("AuthorizationToken"),
	});

	if (!authContext.isValid || !authContext.user) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	// 参加者権限チェック（COMPETITOR, PLATFORM_ADMIN, TENANT_ADMIN, ORGANIZER）
	const isParticipant =
		hasRole(authContext.user, UserRole.COMPETITOR) ||
		hasRole(authContext.user, UserRole.PLATFORM_ADMIN) ||
		hasRole(authContext.user, UserRole.TENANT_ADMIN) ||
		hasRole(authContext.user, UserRole.ORGANIZER);

	if (!isParticipant) {
		return c.json({ error: "Forbidden: Participant access required" }, 403);
	}

	c.set("user", authContext.user);
	return next();
});

// ====================
// イベント一覧・詳細
// ====================

/**
 * 参加可能なイベント一覧を取得
 */
participantRouter.get(
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
		// EventFilterOptions に合わせた型
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

		// tenantId でフィルタするには findByTenant を使用
		const events = user.tenantId
			? await eventRepository.findByTenant(user.tenantId, options)
			: await eventRepository.findAll(options);
		const total = await eventRepository.count({
			...options,
			tenantId: user.tenantId,
		});

		// 参加状況を追加
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
		// DynamoDB 接続エラー時は空リストを返す（ローカル開発で LocalStack 未起動の場合）
		if (
			error instanceof Error &&
			"code" in error &&
			(error as { code: string }).code === "ECONNREFUSED"
		) {
			logger.warn("DynamoDB is not available. Returning empty events list.");
			return c.json({ events: [], total: 0 });
		}
		logger.error({ error }, "Failed to fetch events");
		return c.json({ error: "Failed to fetch events" }, 500);
	}
});

/**
 * 参加中のイベント一覧を取得
 */
participantRouter.get(
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
		// TODO: 実際の参加イベントを取得（Team/Participantテーブルから）
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
			logger.warn("DynamoDB is not available. Returning empty events list.");
			return c.json({ events: [] });
		}
		logger.error({ error }, "Failed to fetch my events");
		return c.json({ error: "Failed to fetch events" }, 500);
	}
});

/**
 * イベント詳細を取得
 */
participantRouter.get(
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

		// テナントチェック
		if (eventData.tenantId !== user.tenantId) {
			return c.json({ error: "Event not found" }, 404);
		}

		// 問題情報を参加者向けに変換（解答は含めない）
		const problems = await Promise.all(
			eventProblems.map(async (ep) => {
				const problem = await problemRepository.findById(ep.problemId);
				// ScoringCriterion の maxPoints を合計して maxScore を計算
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
					myScore: undefined, // TODO: 実際のスコアを取得
					isCompleted: false, // TODO: 実際の完了状態を取得
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
			teamInfo: undefined, // TODO: チーム情報を取得
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch event");
		return c.json({ error: "Failed to fetch event" }, 500);
	}
});

/**
 * イベントに登録
 */
participantRouter.post(
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

		// status は lowercase に変換済み
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
participantRouter.post(
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

		// テナント分離チェック
		if (event.tenantId !== user.tenantId) {
			return c.json({ error: "Event not found" }, 404);
		}

		// status は lowercase
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

/**
 * リーダーボードを取得
 */
participantRouter.get(
	"/events/:eventId/leaderboard",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "リーダーボード取得",
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

		if (!event.leaderboardVisible) {
			return c.json({ error: "Leaderboard is not visible" }, 403);
		}

		// getLeaderboard は LeaderboardEntry[] を返す
		const entries = await getLeaderboard(eventId);

		// 自分のポジションをマーク
		const entriesWithMe = entries.map((entry) => ({
			...entry,
			isMe: entry.teamId === user.teamId,
		}));

		const myPosition = entriesWithMe.findIndex((e) => e.isMe) + 1;

		return c.json({
			eventId,
			entries: entriesWithMe,
			isFrozen: false, // TODO: 実際の frozen 状態を取得
			updatedAt: new Date().toISOString(),
			myPosition: myPosition > 0 ? myPosition : undefined,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch leaderboard");
		return c.json({ error: "Failed to fetch leaderboard" }, 500);
	}
});

/**
 * 自分のランキングを取得
 */
participantRouter.get(
	"/events/:eventId/my-ranking",
	describeRoute({
		tags: ["Participant / Events"],
		summary: "自分のランキング取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "ランキング情報が見つかりません" },
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
// チャレンジ（問題）
// ====================

/**
 * チャレンジ詳細を取得
 */
participantRouter.get(
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

		// ロック状態チェック
		if (eventProblem.unlockTime && new Date() < eventProblem.unlockTime) {
			return c.json({ error: "Challenge is locked" }, 403);
		}

		// イベントがアクティブかチェック（DynamoDB の enum は大文字）
		if (eventData.status !== "ACTIVE") {
			return c.json({ error: "Event is not active" }, 403);
		}

		// maxScore を criteria から計算
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
			isCompleted: false, // TODO: 実際の完了状態
			myScore: undefined, // TODO: 実際のスコア
			estimatedTimeMinutes: problem?.description.estimatedTime,
			description: problem?.description.overview || "",
			instructions: problem?.description.objectives || [],
			hints: (problem?.description.hints || []).map(
				(_hint: string, index: number) => ({
					id: `hint-${index}`,
					content: "", // 公開されていない場合は空
					costPoints: 10, // デフォルト値
					isRevealed: false, // TODO: 実際の公開状態
				}),
			),
			resources: [], // TODO: 静的ファイルから取得
			scoringCriteria: (problem?.scoring.criteria || []).map(
				(sc: ScoringCriterion) => ({
					name: sc.name,
					description: sc.description || "",
					maxPoints: sc.maxPoints,
					currentPoints: undefined, // TODO: 実際のスコア
					isPassed: undefined,
				}),
			),
			awsAccountId: undefined, // TODO: 割り当てられたアカウントID
			awsConsoleUrl: undefined, // TODO: コンソールURL生成
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch challenge");
		return c.json({ error: "Failed to fetch challenge" }, 500);
	}
});

/**
 * JAMチャレンジ詳細を取得（クルー付き）
 */
participantRouter.get(
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

			// DynamoDB の enum は大文字
			if (eventData.type !== "JAM") {
				return c.json({ error: "Not a JAM event" }, 400);
			}

			const eventProblem = eventProblems.find(
				(ep) => ep.problemId === challengeId,
			);
			if (!eventProblem) {
				return c.json({ error: "Challenge not found" }, 404);
			}

			// Prisma が利用可能な場合は JAM モジュールを使用
			if (_prisma && user.teamId) {
				const detail = await getChallengeDetail(
					eventId,
					user.teamId,
					challengeId,
				);

				if (detail.success && detail.challenge) {
					const ch = detail.challenge;
					return c.json({
						id: challengeId,
						title: ch.title,
						type: "jam",
						category: ch.category,
						difficulty: "",
						overview: ch.description,
						objectives: [],
						order: eventProblem.order,
						pointMultiplier: eventProblem.pointMultiplier,
						maxScore: ch.taskScoring,
						isUnlocked:
							!eventProblem.unlockTime || new Date() >= eventProblem.unlockTime,
						isCompleted: ch.completed,
						myScore: ch.score,
						description: ch.description,
						instructions: [],
						clues: ch.tasks.flatMap((task) =>
							task.clues.map((clue) => ({
								id: `${task.taskId}:${clue.order}`,
								order: clue.order,
								title: clue.title,
								content: task.usedClues[clue.order] || "",
								costPoints:
									(clue.order === 0
										? task.clue1PenaltyPoints
										: clue.order === 1
											? task.clue2PenaltyPoints
											: task.clue3PenaltyPoints) || 0,
								isRevealed: clue.order < task.usedClues.length,
								revealedAt: undefined,
							})),
						),
						tasks: ch.tasks,
						resources: [],
						scoringCriteria: [],
						answerFormat: "text",
						answerValidation: undefined,
					});
				}
			}

			// フォールバック: DynamoDB の問題データから返す
			const problem = await problemRepository.findById(eventProblem.problemId);
			const maxScore =
				problem?.scoring.criteria?.reduce(
					(sum: number, sc: ScoringCriterion) => sum + sc.maxPoints,
					0,
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
				isUnlocked:
					!eventProblem.unlockTime || new Date() >= eventProblem.unlockTime,
				isCompleted: false,
				myScore: undefined,
				description: problem?.description.overview || "",
				instructions: problem?.description.objectives || [],
				clues: [],
				resources: [],
				scoringCriteria: problem?.scoring.criteria || [],
				answerFormat: "text",
				answerValidation: undefined,
			});
		} catch (error) {
			logger.error({ error }, "Failed to fetch JAM challenge");
			return c.json({ error: "Failed to fetch challenge" }, 500);
		}
	},
);

/**
 * AWS クレデンシャルを取得
 */
participantRouter.get(
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
			// イベントとチャレンジの存在確認
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

			// TODO: 実際のクレデンシャル発行処理
			// - 参加者に割り当てられたAWSアカウントからSTSでセッショントークンを取得
			// - CompetitorAccount テーブルから暗号化されたクレデンシャルを取得
			// - セキュリティ制約を適用

			// 現在は未実装のため 501 を返す
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
participantRouter.post(
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
			// TODO: 実際のヒント公開処理
			// - ポイント減点を記録
			// - ヒント公開状態を保存

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
 * クルーを公開（JAM）
 *
 * clueId は "taskId:clueOrder" 形式
 */
participantRouter.post(
	"/events/:eventId/challenges/:challengeId/clues/:clueId/reveal",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "クルー公開",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "クルーが見つかりません" },
		},
	}),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId, challengeId, clueId } = c.req.param();

		try {
			// Prisma が利用不可の場合は 501 を返す
			if (!_prisma) {
				return c.json(
					{
						error: "Clue reveal not yet available",
						message:
							"Database migration in progress. This feature requires Prisma client.",
					},
					501,
				);
			}

			if (!user.teamId) {
				return c.json({ error: "Team membership required" }, 400);
			}

			// clueId は "taskId:clueOrder" 形式をパース
			const parts = clueId.split(":");
			const taskId = parts.length === 2 ? parts[0] : clueId;
			const clueOrder = parts.length === 2 ? Number.parseInt(parts[1], 10) : 0;

			const result = await openClue(
				eventId,
				user.teamId,
				challengeId,
				taskId,
				clueOrder,
			);

			if (!result.success) {
				return c.json({ error: result.message }, 400);
			}

			return c.json({
				id: clueId,
				order: clueOrder,
				title: "",
				content: result.message,
				costPoints: 0,
				isRevealed: true,
				revealedAt: new Date().toISOString(),
			});
		} catch (error) {
			logger.error({ error }, "Failed to reveal clue");
			return c.json({ error: "Failed to reveal clue" }, 500);
		}
	},
);

/**
 * 採点をリクエスト（GameDay）
 */
participantRouter.post(
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
			// TODO: 実際の採点リクエスト処理
			// - 採点キューに追加
			// - 提出IDを返す

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
 * 回答を提出（JAM）
 */
const submitAnswerSchema = z.object({
	answer: z.string().min(1),
	titleId: z.string().min(1), // タスク識別子（どのタスクへの回答か）
});

participantRouter.post(
	"/events/:eventId/challenges/:challengeId/submit",
	describeRoute({
		tags: ["Participant / Challenges"],
		summary: "解答提出",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(submitAnswerSchema),
				},
			},
		},
		responses: {
			200: { description: "成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チャレンジが見つかりません" },
		},
	}),
	zValidator("json", submitAnswerSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId, challengeId } = c.req.param();
		const { answer, titleId } = c.req.valid("json");

		try {
			// Prisma が利用不可の場合は 501 を返す
			if (!_prisma) {
				return c.json(
					{
						error: "Answer submission not yet available",
						message:
							"Database migration in progress. This feature requires Prisma client.",
					},
					501,
				);
			}

			if (!user.teamId) {
				return c.json({ error: "Team membership required" }, 400);
			}

			// validateAnswer で回答を検証し、スコア更新まで一括処理
			const result = await validateAnswer(
				eventId,
				user.teamId,
				challengeId,
				titleId,
				answer,
			);

			const submissionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

			return c.json({
				id: submissionId,
				problemId: challengeId,
				eventId,
				titleId,
				submittedAt: new Date().toISOString(),
				status: "completed",
				score: result.correct ? 100 : 0,
				maxScore: 100,
				answer,
				isCorrect: result.correct,
				message: result.message,
				cluesUsed: 0,
				clueDeduction: 0,
			});
		} catch (error) {
			logger.error({ error }, "Failed to submit answer");
			return c.json({ error: "Failed to submit answer" }, 500);
		}
	},
);

/**
 * 提出履歴を取得
 */
participantRouter.get(
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
			// TODO: 実際の提出履歴を取得

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
participantRouter.get(
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

			// チャレンジを取得
			const challenge = await prisma.challenge.findFirst({
				where: { eventId, challengeId },
			});

			if (!challenge) {
				return c.json({ error: "No submissions found" }, 404);
			}

			// チームチャレンジ回答を取得
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

// ====================
// チーム管理
// ====================

/**
 * 自分のチーム情報を取得
 */
participantRouter.get(
	"/events/:eventId/team",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チーム情報取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チームが見つかりません" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();

	try {
		// TODO: 実際のチーム情報を取得

		return c.json({ error: "Team not found" }, 404);
	} catch (error) {
		logger.error({ error }, "Failed to fetch team");
		return c.json({ error: "Failed to fetch team" }, 500);
	}
});

/**
 * チームを作成
 */
const createTeamSchema = z.object({
	name: z.string().min(1).max(50),
});

participantRouter.post(
	"/events/:eventId/team",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チーム作成",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(createTeamSchema),
				},
			},
		},
		responses: {
			201: { description: "チーム作成成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	zValidator("json", createTeamSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const { eventId: _eventId } = c.req.param();
		const { name } = c.req.valid("json");

		try {
			// TODO: 実際のチーム作成処理

			const inviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();

			return c.json({
				id: `team_${Date.now()}`,
				name,
				members: [
					{
						id: user.id,
						name: user.username || "Unknown",
						email: user.email || "",
						role: "captain",
						joinedAt: new Date().toISOString(),
					},
				],
				captainId: user.id,
				inviteCode,
			});
		} catch (error) {
			logger.error({ error }, "Failed to create team");
			return c.json({ error: "Failed to create team" }, 500);
		}
	},
);

/**
 * チームに参加
 */
const joinTeamSchema = z.object({
	inviteCode: z.string().min(1),
});

participantRouter.post(
	"/events/:eventId/team/join",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チーム参加",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(joinTeamSchema),
				},
			},
		},
		responses: {
			200: { description: "成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チームが見つかりません" },
		},
	}),
	zValidator("json", joinTeamSchema),
	async (c) => {
		const { eventId: _eventId } = c.req.param();
		const { inviteCode: _inviteCode } = c.req.valid("json");

		try {
			// TODO: 実際のチーム参加処理

			return c.json({
				id: "team_example",
				name: "Example Team",
				members: [],
				captainId: "captain_id",
			});
		} catch (error) {
			logger.error({ error }, "Failed to join team");
			return c.json({ error: "Failed to join team" }, 500);
		}
	},
);

/**
 * チームから離脱
 */
participantRouter.post(
	"/events/:eventId/team/leave",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チーム離脱",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();

	try {
		// TODO: 実際の離脱処理

		return c.json({ success: true, message: "Successfully left the team" });
	} catch (error) {
		logger.error({ error }, "Failed to leave team");
		return c.json({ error: "Failed to leave team" }, 500);
	}
});

/**
 * 招待コードを再生成
 */
participantRouter.post(
	"/events/:eventId/team/invite-code",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "招待コード再生成",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();

	try {
		// TODO: キャプテン権限チェック + 実際の再生成処理

		const newInviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();

		return c.json({ inviteCode: newInviteCode });
	} catch (error) {
		logger.error({ error }, "Failed to regenerate invite code");
		return c.json({ error: "Failed to regenerate invite code" }, 500);
	}
});

/**
 * キャプテンを移譲
 */
const transferCaptainSchema = z.object({
	newCaptainId: z.string().min(1),
});

participantRouter.post(
	"/events/:eventId/team/transfer-captain",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "キャプテン移譲",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(transferCaptainSchema),
				},
			},
		},
		responses: {
			200: { description: "成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "チームが見つかりません" },
		},
	}),
	zValidator("json", transferCaptainSchema),
	async (c) => {
		const { eventId: _eventId } = c.req.param();
		const { newCaptainId } = c.req.valid("json");

		try {
			// TODO: 実際の移譲処理

			return c.json({
				id: "team_example",
				name: "Example Team",
				members: [],
				captainId: newCaptainId,
			});
		} catch (error) {
			logger.error({ error }, "Failed to transfer captain");
			return c.json({ error: "Failed to transfer captain" }, 500);
		}
	},
);

/**
 * チームメンバー一覧を取得
 */
participantRouter.get(
	"/events/:eventId/team/members",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チームメンバー一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();

	try {
		// TODO: 実際のメンバー一覧を取得

		return c.json({ members: [] });
	} catch (error) {
		logger.error({ error }, "Failed to fetch team members");
		return c.json({ error: "Failed to fetch members" }, 500);
	}
});

/**
 * チームメンバーを削除
 */
participantRouter.delete(
	"/events/:eventId/team/members/:memberId",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チームメンバー削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "メンバーが見つかりません" },
		},
	}),
	async (c) => {
		const { eventId: _eventId, memberId: _memberId } = c.req.param();

		try {
			// TODO: キャプテン権限チェック + 実際の削除処理

			return c.json({ success: true, message: "Member removed from team" });
		} catch (error) {
			logger.error({ error }, "Failed to remove member");
			return c.json({ error: "Failed to remove member" }, 500);
		}
	},
);

/**
 * チームを解散
 */
participantRouter.delete(
	"/events/:eventId/team",
	describeRoute({
		tags: ["Participant / Teams"],
		summary: "チーム解散",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { eventId: _eventId } = c.req.param();

	try {
		// TODO: キャプテン権限チェック + 実際の解散処理

		return c.json({ success: true, message: "Team disbanded" });
	} catch (error) {
		logger.error({ error }, "Failed to disband team");
		return c.json({ error: "Failed to disband team" }, 500);
	}
});

// ====================
// プロフィール
// ====================

/**
 * 自分のプロフィールを取得
 */
participantRouter.get(
	"/profile",
	describeRoute({
		tags: ["Participant / Rankings"],
		summary: "プロフィール取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const user = c.get("user") as AuthenticatedUser;

	try {
		// TODO: 実際のプロフィール情報を取得

		return c.json({
			id: user.id,
			name: user.username || "Unknown",
			email: user.email || "",
			avatarUrl: undefined,
			totalEventsParticipated: 0,
			totalScore: 0,
			rank: undefined,
			badges: [],
			recentEvents: [],
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch profile");
		return c.json({ error: "Failed to fetch profile" }, 500);
	}
});

/**
 * プロフィールを更新
 */
const updateProfileSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	avatarUrl: z.string().url().optional(),
});

participantRouter.put(
	"/profile",
	describeRoute({
		tags: ["Participant / Rankings"],
		summary: "プロフィール更新",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(updateProfileSchema),
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
	zValidator("json", updateProfileSchema),
	async (c) => {
		const user = c.get("user") as AuthenticatedUser;
		const data = c.req.valid("json");

		try {
			// TODO: 実際の更新処理

			return c.json({
				id: user.id,
				name: data.name || user.username || "Unknown",
				email: user.email || "",
				avatarUrl: data.avatarUrl,
				totalEventsParticipated: 0,
				totalScore: 0,
				rank: undefined,
				badges: [],
				recentEvents: [],
			});
		} catch (error) {
			logger.error({ error }, "Failed to update profile");
			return c.json({ error: "Failed to update profile" }, 500);
		}
	},
);

/**
 * バッジ一覧を取得
 */
participantRouter.get(
	"/profile/badges",
	describeRoute({
		tags: ["Participant / Rankings"],
		summary: "バッジ一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	try {
		// TODO: 実際のバッジ一覧を取得

		return c.json({ badges: [] });
	} catch (error) {
		logger.error({ error }, "Failed to fetch badges");
		return c.json({ error: "Failed to fetch badges" }, 500);
	}
});

/**
 * 参加イベント履歴を取得
 */
participantRouter.get(
	"/profile/history",
	describeRoute({
		tags: ["Participant / Rankings"],
		summary: "参加イベント履歴取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { limit: _limit = "20", offset: _offset = "0" } = c.req.query();

	try {
		// TODO: 実際の履歴を取得

		return c.json({
			events: [],
			total: 0,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch history");
		return c.json({ error: "Failed to fetch history" }, 500);
	}
});

/**
 * グローバルランキングを取得
 */
participantRouter.get(
	"/rankings",
	describeRoute({
		tags: ["Participant / Rankings"],
		summary: "グローバルランキング取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const { limit: _limit = "50", offset: _offset = "0" } = c.req.query();

	try {
		// TODO: 実際のランキングを取得

		return c.json({
			rankings: [],
			total: 0,
			myRank: undefined,
		});
	} catch (error) {
		logger.error({ error }, "Failed to fetch rankings");
		return c.json({ error: "Failed to fetch rankings" }, 500);
	}
});

export { participantRouter };
