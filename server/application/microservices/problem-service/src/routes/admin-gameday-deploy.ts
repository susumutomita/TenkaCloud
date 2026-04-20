/**
 * GameDay チームデプロイルート (admin)
 *
 * /events/:eventId/competitor-accounts の CRUD と
 * /events/:eventId/problems/:problemId/deploy 系。
 */

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	deployProblemToTeams,
	getGameDayDeploymentValidationError,
	retryJob,
} from "../problems/gameday-deployer";
import {
	logger,
	eventRepository,
	problemRepository,
	competitorAccountRepo,
	gamedayJobRepo,
} from "./admin-shared";

export const gamedayDeployRoutes = new Hono();

function buildCompetitorExternalId(eventId: string, accountId: string): string {
	const sanitize = (value: string) =>
		value.replace(/[^A-Za-z0-9+=,.@:/-]/g, "-");

	return `tc-${sanitize(eventId)}-${sanitize(accountId)}`.slice(0, 122);
}

// チームアカウント登録
gamedayDeployRoutes.post(
	"/events/:eventId/competitor-accounts",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "競技アカウント登録",
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
			name: z.string().min(1),
			provider: z.enum(["aws", "gcp", "azure", "local"]).default("aws"),
			accountId: z.string().min(1),
			region: z.string().min(1),
			roleArn: z.string().optional(),
			externalId: z.string().min(1).max(122).optional(),
		}),
	),
	async (c) => {
		const eventId = c.req.param("eventId");
		const data = c.req.valid("json");

		try {
			const account = await competitorAccountRepo.create({
				eventId,
				name: data.name,
				provider: data.provider,
				accountId: data.accountId,
				region: data.region,
				roleArn: data.roleArn,
				externalId:
					data.roleArn && data.provider === "aws"
						? (data.externalId ??
							buildCompetitorExternalId(eventId, data.accountId))
						: data.externalId,
			});
			return c.json(account, 201);
		} catch (error) {
			logger.error({ error }, "Failed to create competitor account");
			return c.json({ error: "Failed to create competitor account" }, 500);
		}
	},
);

// チームアカウント一覧取得
gamedayDeployRoutes.get(
	"/events/:eventId/competitor-accounts",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "競技アカウント一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
		const eventId = c.req.param("eventId");
		try {
			const accounts = await competitorAccountRepo.findByEventId(eventId);
			return c.json({ accounts });
		} catch (error) {
			logger.error({ error }, "Failed to list competitor accounts");
			return c.json({ error: "Failed to list competitor accounts" }, 500);
		}
	},
);

// チームアカウント削除
gamedayDeployRoutes.delete(
	"/events/:eventId/competitor-accounts/:accountId",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "競技アカウント削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
		const eventId = c.req.param("eventId");
		const accountId = c.req.param("accountId");
		try {
			await competitorAccountRepo.delete(eventId, accountId);
			return c.json({ success: true });
		} catch (error) {
			logger.error({ error }, "Failed to delete competitor account");
			return c.json({ error: "Failed to delete competitor account" }, 500);
		}
	},
);

// 問題を全チームへデプロイ
gamedayDeployRoutes.post(
	"/events/:eventId/problems/:problemId/deploy",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "問題を全チームへデプロイ",
		responses: {
			202: { description: "デプロイ受付完了" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
		const eventId = c.req.param("eventId");
		const problemId = c.req.param("problemId");

		const event = await eventRepository.findById(eventId);
		if (!event) {
			return c.json({ error: "Event not found" }, 404);
		}
		if (event.type !== "gameday") {
			return c.json(
				{ error: "Team deployment is only supported for GameDay events" },
				400,
			);
		}

		const problem = await problemRepository.findById(problemId);
		if (!problem) {
			return c.json({ error: "Problem not found" }, 404);
		}

		const declaredValidationError =
			(problem.deployment.providers.length > 0
				? problem.deployment.providers
				: ["aws"]
			).reduce<string | null>(
				(currentError, provider) =>
					currentError ??
					getGameDayDeploymentValidationError(
						problem,
						provider as "aws" | "local",
					),
				null,
			);
		if (declaredValidationError) {
			return c.json({ error: declaredValidationError }, 400);
		}

		const accounts = await competitorAccountRepo.findByEventId(eventId);
		if (accounts.length === 0) {
			return c.json(
				{ error: "No competitor accounts configured for this event" },
				400,
			);
		}

		const validationError = [
			...new Set(accounts.map((account) => account.provider)),
		].reduce<string | null>(
			(currentError, provider) =>
				currentError ??
				getGameDayDeploymentValidationError(
					problem,
					provider as "aws" | "local",
				),
			null,
		);
		if (validationError) {
			return c.json({ error: validationError }, 400);
		}

		try {
			const jobs = await deployProblemToTeams(problem, eventId, event.tenantId);
			return c.json({ jobs }, 202);
		} catch (error) {
			logger.error({ error }, "Failed to deploy problem to teams");
			return c.json({ error: "Failed to start deployment" }, 500);
		}
	},
);

// デプロイジョブ一覧取得
gamedayDeployRoutes.get(
	"/events/:eventId/problems/:problemId/deployments",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "デプロイジョブ一覧取得",
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
			const jobs = await gamedayJobRepo.findByEventAndProblem(
				eventId,
				problemId,
			);
			const accounts = await competitorAccountRepo.findByEventId(eventId);
			const accountMap = new Map(accounts.map((a) => [a.id, a]));

			const enriched = jobs.map((job) => ({
				...job,
				teamName:
					accountMap.get(job.competitorAccountId)?.name ??
					job.competitorAccountId,
				awsAccountId: accountMap.get(job.competitorAccountId)?.accountId,
			}));

			return c.json({ jobs: enriched });
		} catch (error) {
			logger.error({ error }, "Failed to list deployment jobs");
			return c.json({ error: "Failed to list deployment jobs" }, 500);
		}
	},
);

// ジョブのリトライ
gamedayDeployRoutes.post(
	"/events/:eventId/problems/:problemId/deployments/:jobId/retry",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "失敗したデプロイジョブをリトライ",
		responses: {
			202: { description: "リトライ受付完了" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
		const eventId = c.req.param("eventId");
		const problemId = c.req.param("problemId");
		const jobId = c.req.param("jobId");

		const problem = await problemRepository.findById(problemId);
		if (!problem) {
			return c.json({ error: "Problem not found" }, 404);
		}

		try {
			const job = await retryJob(eventId, problemId, jobId, problem);
			if (!job) {
				return c.json({ error: "Job not found or not in failed state" }, 400);
			}
			return c.json({ job }, 202);
		} catch (error) {
			logger.error({ error }, "Failed to retry deployment job");
			return c.json({ error: "Failed to retry job" }, 500);
		}
	},
);
