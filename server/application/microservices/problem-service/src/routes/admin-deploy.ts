/**
 * AWS デプロイメント + GameDay チームデプロイルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getAWSProvider } from "../providers/aws";
import { getLocalProvider } from "../providers/local";
import type { CloudCredentials } from "../types";
import {
	deployProblemToTeams,
	getGameDayDeploymentValidationError,
	retryJob,
	subscribeToJob,
} from "../problems/gameday-deployer";
import {
	logger,
	eventRepository,
	problemRepository,
	competitorAccountRepo,
	gamedayJobRepo,
} from "./admin-shared";

const deployRoutes = new Hono();

// ====================
// AWS デプロイメント
// ====================

// AWS クレデンシャルを環境変数から取得するヘルパー
function getAWSCredentialsFromEnv(
	region: string,
	overrides?: Partial<CloudCredentials>,
): CloudCredentials | null {
	const accessKeyId =
		overrides?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "";
	const secretAccessKey =
		overrides?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "";
	const accountId = overrides?.accountId || process.env.AWS_ACCOUNT_ID || "";

	if (!accessKeyId || !secretAccessKey || !accountId) {
		return null;
	}

	return {
		provider: "aws",
		accountId,
		accessKeyId,
		secretAccessKey,
		sessionToken: overrides?.sessionToken || process.env.AWS_SESSION_TOKEN,
		roleArn: overrides?.roleArn || process.env.AWS_ROLE_ARN,
		externalId: overrides?.externalId || process.env.AWS_EXTERNAL_ID,
		region,
	};
}

function getLocalCredentials(region?: string): CloudCredentials {
	return {
		provider: "local",
		accountId: "local-dev",
		region: region || "local",
	};
}

// デプロイメント操作の共通バリデーション結果
type DeploymentValidation =
	| { valid: true; credentials: CloudCredentials }
	| { valid: false; error: string; status: 400 | 404 };

// デプロイメント操作の共通バリデーション
async function validateDeploymentRequest(
	problemId: string,
	provider: "aws" | "local",
	region: string | undefined,
): Promise<DeploymentValidation> {
	const exists = await problemRepository.exists(problemId);
	if (!exists) {
		return { valid: false, error: "Problem not found", status: 404 };
	}

	if (provider === "local") {
		return { valid: true, credentials: getLocalCredentials(region) };
	}

	if (!region) {
		return {
			valid: false,
			error: "region query parameter is required",
			status: 400,
		};
	}

	const credentials = getAWSCredentialsFromEnv(region);
	if (!credentials) {
		return {
			valid: false,
			error: "AWS credentials not configured",
			status: 400,
		};
	}

	return { valid: true, credentials };
}

// デプロイリクエストスキーマ
const deployProblemSchema = z.object({
	provider: z.enum(["aws", "local"]).default("aws"),
	region: z.string().min(1).describe("デプロイ先リージョン"),
	stackName: z
		.string()
		.regex(/^[a-zA-Z][a-zA-Z0-9-]*$/)
		.min(1)
		.max(128)
		.optional()
		.describe("CloudFormation スタック名（省略時は自動生成）"),
	parameters: z
		.record(z.string())
		.optional()
		.describe("CloudFormation パラメータ"),
	tags: z.record(z.string()).optional().describe("スタックに付けるタグ"),
	dryRun: z.boolean().optional().describe("テンプレート検証のみ実行"),
	credentials: z
		.object({
			accessKeyId: z.string().optional(),
			secretAccessKey: z.string().optional(),
			sessionToken: z.string().optional(),
			accountId: z.string().optional(),
			roleArn: z.string().optional(),
			externalId: z.string().optional(),
		})
		.optional()
		.describe("AWS クレデンシャル（省略時は環境変数を使用）"),
});

// 問題をクラウド環境にデプロイ
deployRoutes.post(
	"/problems/:problemId/deploy",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題をクラウド環境にデプロイ",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(deployProblemSchema),
				},
			},
		},
		responses: {
			200: { description: "成功（dryRun時）" },
			201: { description: "デプロイ成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	zValidator("json", deployProblemSchema),
	async (c) => {
		const { problemId } = c.req.param();
		const input = c.req.valid("json");

		// 問題を取得
		const problem = await problemRepository.findById(problemId);
		if (!problem) {
			return c.json({ error: "Problem not found" }, 404);
		}

		if (
			!problem.deployment.providers.includes(input.provider) ||
			!problem.deployment.templates[input.provider]
		) {
			return c.json(
				{
					error: `This problem does not have a ${input.provider.toUpperCase()} deployment template`,
				},
				400,
			);
		}

		const credentials =
			input.provider === "local"
				? getLocalCredentials(input.region)
				: getAWSCredentialsFromEnv(input.region, input.credentials);
		if (!credentials) {
			return c.json(
				{
					error:
						"AWS credentials not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_ACCOUNT_ID environment variables or provide them in the request.",
				},
				400,
			);
		}

		// スタック名の生成（UUID で一意性を保証）
		const stackName =
			input.stackName ||
			`tenkacloud-${problem.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;

		const provider =
			input.provider === "local" ? getLocalProvider() : getAWSProvider();

		// クレデンシャル検証
		const isValid = await provider.validateCredentials(credentials);
		if (!isValid) {
			return c.json(
				{
					error:
						input.provider === "local"
							? "Invalid local deployment configuration"
							: "Invalid AWS credentials",
				},
				401,
			);
		}

		// デプロイ実行
		const result = await provider.deployStack(problem, credentials, {
			stackName,
			region: input.region,
			parameters: input.parameters,
			tags: {
				...input.tags,
				"tenkacloud:admin-deploy": "true",
				"tenkacloud:problem-id": problem.id,
				"tenkacloud:problem-title": problem.title
					.slice(0, 256)
					.replace(/[^\w\s.:\-/=+@]/g, "_"),
			},
			dryRun: input.dryRun,
			timeoutSeconds: (problem.deployment.timeout || 60) * 60,
			rollbackOnFailure: true,
		});

		if (result.success) {
			return c.json(
				{
					message: input.dryRun
						? "Template validation successful"
						: "Deployment completed successfully",
					provider: input.provider,
					region: input.region,
					stackName: result.stackName,
					stackId: result.stackId,
					outputs: result.outputs,
					startedAt: result.startedAt,
					completedAt: result.completedAt,
				},
				input.dryRun ? 200 : 201,
			);
		}

		return c.json(
			{
				error: "Deployment failed",
				details: result.error,
				stackName: result.stackName,
				startedAt: result.startedAt,
				completedAt: result.completedAt,
			},
			500,
		);
	},
);

// デプロイメント状態取得
deployRoutes.get(
	"/problems/:problemId/deployments/:stackName/status",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "デプロイメント状態取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
		const { problemId, stackName } = c.req.param();
		const region = c.req.query("region");
		const provider = c.req.query("provider") === "local" ? "local" : "aws";

		const validation = await validateDeploymentRequest(
			problemId,
			provider,
			region,
		);
		if (!validation.valid) {
			return c.json({ error: validation.error }, validation.status);
		}

		const cloudProvider =
			provider === "local" ? getLocalProvider() : getAWSProvider();
		const status = await cloudProvider.getStackStatus(
			stackName,
			validation.credentials,
		);

		if (!status) {
			return c.json({ error: "Stack not found" }, 404);
		}

		return c.json({
			stackName: status.stackName,
			stackId: status.stackId,
			status: status.status,
			statusReason: status.statusReason,
			outputs: status.outputs,
			lastUpdatedTime: status.lastUpdatedTime,
		});
	},
);

// デプロイメント削除
deployRoutes.delete(
	"/problems/:problemId/deployments/:stackName",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "デプロイメント削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
		const { problemId, stackName } = c.req.param();
		const region = c.req.query("region");
		const provider = c.req.query("provider") === "local" ? "local" : "aws";

		const validation = await validateDeploymentRequest(
			problemId,
			provider,
			region,
		);
		if (!validation.valid) {
			return c.json({ error: validation.error }, validation.status);
		}

		const cloudProvider =
			provider === "local" ? getLocalProvider() : getAWSProvider();

		const status = await cloudProvider.getStackStatus(
			stackName,
			validation.credentials,
		);
		if (!status) {
			return c.json({ error: "Stack not found" }, 404);
		}

		const result = await cloudProvider.deleteStack(
			stackName,
			validation.credentials,
		);

		if (result.success) {
			return c.json({
				message: "Stack deletion completed",
				stackName,
				startedAt: result.startedAt,
				completedAt: result.completedAt,
			});
		}

		return c.json(
			{
				error: "Stack deletion failed",
				details: result.error,
				stackName,
			},
			500,
		);
	},
);

// 利用可能なリージョン一覧
deployRoutes.get(
	"/aws/regions",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "利用可能なAWSリージョン一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const awsProvider = getAWSProvider();
	const regions = await awsProvider.getAvailableRegions();
	return c.json({ regions });
});

// ====================
// GameDay チームデプロイ
// ====================

function buildCompetitorExternalId(eventId: string, accountId: string): string {
	const sanitize = (value: string) =>
		value.replace(/[^A-Za-z0-9+=,.@:/-]/g, "-");

	return `tc-${sanitize(eventId)}-${sanitize(accountId)}`.slice(0, 122);
}

// チームアカウント登録
deployRoutes.post(
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
deployRoutes.get(
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
deployRoutes.delete(
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
deployRoutes.post(
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

		const validationError =
			[...new Set(accounts.map((account) => account.provider))].reduce<string | null>(
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
deployRoutes.get(
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
			const jobs = await gamedayJobRepo.findByEventAndProblem(eventId, problemId);
			const accounts = await competitorAccountRepo.findByEventId(eventId);
			const accountMap = new Map(accounts.map((a) => [a.id, a]));

			const enriched = jobs.map((job) => ({
				...job,
				teamName: accountMap.get(job.competitorAccountId)?.name ?? job.competitorAccountId,
				awsAccountId: accountMap.get(job.competitorAccountId)?.accountId,
			}));

			return c.json({ jobs: enriched });
		} catch (error) {
			logger.error({ error }, "Failed to list deployment jobs");
			return c.json({ error: "Failed to list deployment jobs" }, 500);
		}
	},
);

// デプロイ状態 SSE ストリーム
deployRoutes.get(
	"/events/:eventId/problems/:problemId/deployments/stream",
	describeRoute({
		tags: ["Admin / GameDay Deploy"],
		summary: "デプロイ状態 SSE ストリーム",
		responses: {
			200: { description: "SSE ストリーム" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
		const eventId = c.req.param("eventId");
		const problemId = c.req.param("problemId");

		const jobs = await gamedayJobRepo.findByEventAndProblem(eventId, problemId);

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				const send = (data: unknown) => {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
					);
				};

				// 初期状態を送信
				send({ type: "snapshot", jobs });

				// 各ジョブの更新をサブスクライブ
				const unsubscribers = jobs.map((job) =>
					subscribeToJob(job.id, (updated) => {
						send({ type: "update", job: updated });
					}),
				);

				// クライアント切断時にクリーンアップ
				/* istanbul ignore next */
				const cleanup = () => {
					for (const unsub of unsubscribers) unsub();
					try {
						controller.close();
					} catch {
						// already closed
					}
				};

				// 30秒ごとに keepalive を送信
				const keepalive = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": keepalive\n\n"));
					} catch {
						clearInterval(keepalive);
						cleanup();
					}
				}, 30000);
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	},
);

// ジョブのリトライ
deployRoutes.post(
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

export { deployRoutes };
