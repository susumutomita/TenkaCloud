/**
 * 問題 CRUD ルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	logger,
	problemRepository,
	marketplaceRepository,
} from "./admin-shared";

const problemRoutes = new Hono();

// 問題一覧取得
problemRoutes.get(
	"/problems",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題一覧取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const type = c.req.query("type");
	const category = c.req.query("category");
	const difficulty = c.req.query("difficulty");
	const limit = parseInt(c.req.query("limit") || "100");
	const offset = parseInt(c.req.query("offset") || "0");

	try {
		const problems = await problemRepository.findAll({
			type: type as "gameday" | "jam" | undefined,
			category: category as
				| "architecture"
				| "security"
				| "cost"
				| "performance"
				| "reliability"
				| "operations"
				| undefined,
			difficulty: difficulty as
				| "easy"
				| "medium"
				| "hard"
				| "expert"
				| undefined,
			limit,
			offset,
		});

		const total = await problemRepository.count({
			type: type as "gameday" | "jam" | undefined,
			category: category as
				| "architecture"
				| "security"
				| "cost"
				| "performance"
				| "reliability"
				| "operations"
				| undefined,
			difficulty: difficulty as
				| "easy"
				| "medium"
				| "hard"
				| "expert"
				| undefined,
		});

		return c.json({ problems, total });
	} catch (error) {
		logger.error({ error }, "Failed to get problems");
		return c.json({ error: "Failed to get problems" }, 500);
	}
});

// 問題詳細取得
problemRoutes.get(
	"/problems/:problemId",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題詳細取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
	const problemId = c.req.param("problemId");

	try {
		const problem = await problemRepository.findById(problemId);
		if (!problem) {
			return c.json({ error: "Problem not found" }, 404);
		}
		return c.json(problem);
	} catch (error) {
		logger.error({ error }, "Failed to get problem");
		return c.json({ error: "Failed to get problem" }, 500);
	}
});

// 問題スキーマ
const createProblemSchema = z.object({
	title: z.string().min(1),
	type: z.enum(["gameday", "jam"]),
	category: z.enum([
		"architecture",
		"security",
		"cost",
		"performance",
		"reliability",
		"operations",
	]),
	difficulty: z.enum(["easy", "medium", "hard", "expert"]),
	description: z.object({
		overview: z.string(),
		objectives: z.array(z.string()).default([]),
		hints: z.array(z.string()).default([]),
		prerequisites: z.array(z.string()).default([]),
		estimatedTime: z.number().optional(),
	}),
	metadata: z.object({
		author: z.string(),
		version: z.string().default("1.0.0"),
		tags: z.array(z.string()).default([]),
		license: z.string().optional(),
	}),
	deployment: z.object({
		providers: z.array(z.enum(["aws", "gcp", "azure", "local"])).min(1),
		timeout: z.number().optional(),
		templates: z
			.record(
				z.object({
					type: z.enum([
						"cloudformation",
						"sam",
						"cdk",
						"terraform",
						"deployment-manager",
						"arm",
						"docker-compose",
					]),
					path: z.string(),
					parameters: z.record(z.string()).optional(),
				}),
			)
			.optional(),
		regions: z.record(z.array(z.string())).optional(),
	}),
	scoring: z.object({
		type: z.enum(["lambda", "container", "api", "manual"]),
		path: z.string(),
		timeoutMinutes: z.number().default(5),
		intervalMinutes: z.number().optional(),
		criteria: z
			.array(
				z.object({
					name: z.string(),
					description: z.string().optional(),
					weight: z.number(),
					maxPoints: z.number(),
				}),
			)
			.default([]),
	}),
});

const updateProblemSchema = createProblemSchema.partial();

// 問題作成
problemRoutes.post(
	"/problems",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題作成",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(createProblemSchema),
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
	zValidator("json", createProblemSchema),
	async (c) => {
		const data = c.req.valid("json");

		try {
			const problem = await problemRepository.create({
				id: crypto.randomUUID(),
				title: data.title,
				type: data.type,
				category: data.category,
				difficulty: data.difficulty,
				description: data.description,
				metadata: {
					author: data.metadata.author,
					version: data.metadata.version,
					tags: data.metadata.tags,
					license: data.metadata.license,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				deployment: {
					providers: data.deployment.providers,
					timeout: data.deployment.timeout,
					templates: data.deployment.templates || {},
					regions: data.deployment.regions || {},
				},
				scoring: data.scoring,
			});
			return c.json(problem, 201);
		} catch (error) {
			logger.error({ error }, "Failed to create problem");
			return c.json({ error: "Failed to create problem" }, 500);
		}
	},
);

// 問題インポート（テンプレート内容を含む）
const templateTypeEnum = z.enum([
	"cloudformation",
	"sam",
	"cdk",
	"terraform",
	"deployment-manager",
	"arm",
	"docker-compose",
]);

const importProblemSchema = createProblemSchema.extend({
	deployment: z.object({
		providers: z.array(z.enum(["aws", "gcp", "azure", "local"])).min(1),
		timeout: z.number().optional(),
		regions: z.record(z.array(z.string())).optional(),
	}),
	templates: z
		.record(
			z.object({
				type: templateTypeEnum,
				content: z.string().min(1),
			}),
		)
		.default({}),
});

problemRoutes.post(
	"/problems/import",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題インポート",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(importProblemSchema),
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
	zValidator("json", importProblemSchema),
	async (c) => {
		const data = c.req.valid("json");

		try {
			const problem = await problemRepository.create({
				id: crypto.randomUUID(),
				title: data.title,
				type: data.type,
				category: data.category,
				difficulty: data.difficulty,
				description: data.description,
				metadata: {
					author: data.metadata.author,
					version: data.metadata.version,
					tags: data.metadata.tags,
					license: data.metadata.license,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				deployment: {
					providers: data.deployment.providers,
					timeout: data.deployment.timeout,
					templates: Object.fromEntries(
						Object.entries(data.templates).map(([provider, t]) => [
							provider,
							{ type: t.type, content: t.content },
						]),
					),
					regions: data.deployment.regions ?? {},
				},
				scoring: data.scoring,
			});

			return c.json(problem, 201);
		} catch (error) {
			logger.error({ error }, "Failed to import problem");
			return c.json({ error: "Failed to import problem" }, 500);
		}
	},
);

// 問題更新
problemRoutes.put(
	"/problems/:problemId",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題更新",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(updateProblemSchema),
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
	zValidator("json", updateProblemSchema),
	async (c) => {
		const problemId = c.req.param("problemId");
		const data = c.req.valid("json");

		try {
			const existing = await problemRepository.findById(problemId);
			if (!existing) {
				return c.json({ error: "Problem not found" }, 404);
			}

			const updates: Record<string, unknown> = {};

			if (data.title) updates.title = data.title;
			if (data.type) updates.type = data.type;
			if (data.category) updates.category = data.category;
			if (data.difficulty) updates.difficulty = data.difficulty;
			if (data.description) updates.description = data.description;
			if (data.metadata) {
				updates.metadata = {
					...data.metadata,
					createdAt: existing.metadata.createdAt,
					updatedAt: new Date().toISOString(),
				};
			}
			if (data.deployment) {
				updates.deployment = {
					...data.deployment,
					templates: data.deployment.templates || {},
					regions: data.deployment.regions || {},
				};
			}
			if (data.scoring) updates.scoring = data.scoring;

			const problem = await problemRepository.update(problemId, updates);
			return c.json(problem);
		} catch (error) {
			logger.error({ error }, "Failed to update problem");
			return c.json({ error: "Failed to update problem" }, 500);
		}
	},
);

// 問題削除
problemRoutes.delete(
	"/problems/:problemId",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
	const problemId = c.req.param("problemId");

	try {
		const exists = await problemRepository.exists(problemId);
		if (!exists) {
			return c.json({ error: "Problem not found" }, 404);
		}

		await problemRepository.delete(problemId);
		return c.json({ success: true });
	} catch (error) {
		logger.error({ error }, "Failed to delete problem");
		return c.json({ error: "Failed to delete problem" }, 500);
	}
});

// マーケットプレイス検索
problemRoutes.get(
	"/marketplace",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "マーケットプレイス検索",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const query = c.req.query("query");
	const type = c.req.query("type");
	const category = c.req.query("category");
	const difficulty = c.req.query("difficulty");
	const provider = c.req.query("provider");
	const sortBy = c.req.query("sortBy") || "relevance";
	const page = parseInt(c.req.query("page") || "1");
	const limit = parseInt(c.req.query("limit") || "20");

	try {
		const result = await marketplaceRepository.search({
			query,
			type: type as "gameday" | "jam" | undefined,
			category: category as
				| "architecture"
				| "security"
				| "cost"
				| "performance"
				| "reliability"
				| "operations"
				| undefined,
			difficulty: difficulty as
				| "easy"
				| "medium"
				| "hard"
				| "expert"
				| undefined,
			provider: provider as "aws" | "gcp" | "azure" | "local" | undefined,
			sortBy: sortBy as "relevance" | "rating" | "downloads" | "newest",
			page,
			limit,
		});

		return c.json(result);
	} catch (error) {
		logger.error({ error }, "Failed to search marketplace");
		return c.json({ error: "Failed to search marketplace" }, 500);
	}
});

// 問題をインストール
problemRoutes.post(
	"/marketplace/:marketplaceId/install",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "マーケットプレイスから問題をインストール",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
		},
	}),
	async (c) => {
	const marketplaceId = c.req.param("marketplaceId");

	try {
		await marketplaceRepository.incrementDownloads(marketplaceId);
		const problem = await marketplaceRepository.findById(marketplaceId);
		if (!problem) {
			return c.json({ error: "Problem not found" }, 404);
		}
		return c.json({ success: true, installedId: problem.id });
	} catch (error) {
		logger.error({ error }, "Failed to install problem");
		return c.json({ error: "Failed to install problem" }, 500);
	}
});

export { problemRoutes };
