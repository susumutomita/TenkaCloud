/**
 * AWS デプロイメントルート（1 問題単位の個別デプロイ操作）
 *
 * GameDay の全チーム一括デプロイ系は admin-gameday-deploy.ts を参照。
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getAWSProvider } from "../providers/aws";
import { getLocalProvider } from "../providers/local";
import type { CloudCredentials } from "../types";
import { problemRepository } from "./admin-shared";

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

export { deployRoutes };
