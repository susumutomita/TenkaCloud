/**
 * 問題テンプレート管理ルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	logger,
	templateRepository,
	problemRepository,
} from "./admin-shared";

const templateRoutes = new Hono();

// テンプレート変数スキーマ
const templateVariableSchema = z.object({
	name: z.string().min(1),
	type: z.enum(["string", "number", "boolean", "select"]),
	description: z.string(),
	defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
	options: z.array(z.string()).optional(),
	required: z.boolean(),
});

// テンプレート作成スキーマ
const createTemplateSchema = z.object({
	name: z.string().min(1),
	description: z.string(),
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
	status: z.enum(["draft", "published", "archived"]).default("draft"),
	variables: z.array(templateVariableSchema).default([]),
	descriptionTemplate: z.object({
		overviewTemplate: z.string(),
		objectivesTemplate: z.array(z.string()),
		hintsTemplate: z.array(z.string()),
		prerequisites: z.array(z.string()).optional(),
		estimatedTime: z.number().optional(),
	}),
	deployment: z.object({
		providers: z.array(z.enum(["aws", "gcp", "azure", "local"])).min(1),
		templateType: z.enum([
			"cloudformation",
			"sam",
			"cdk",
			"terraform",
			"deployment-manager",
			"arm",
			"docker-compose",
		]),
		templateContent: z.string(),
		regions: z
			.record(z.enum(["aws", "gcp", "azure", "local"]), z.array(z.string()))
			.optional(),
		timeout: z.number().optional(),
	}),
	scoring: z.object({
		type: z.enum(["lambda", "container", "api", "manual"]),
		criteriaTemplate: z.array(
			z.object({
				weight: z.number(),
				maxPoints: z.number(),
				description: z.string().optional(),
				validationType: z.string().optional(),
				validationConfig: z.record(z.unknown()).optional(),
			}),
		),
		timeoutMinutes: z.number(),
	}),
	tags: z.array(z.string()).default([]),
	author: z.string(),
	version: z.string().default("1.0.0"),
});

const updateTemplateSchema = createTemplateSchema.partial();

// テンプレート一覧取得
templateRoutes.get(
	"/templates",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレート一覧取得",
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
	const status = c.req.query("status");
	const provider = c.req.query("provider");
	const limit = parseInt(c.req.query("limit") || "100");
	const offset = parseInt(c.req.query("offset") || "0");

	try {
		const templates = await templateRepository.findAll({
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
			status: status as "draft" | "published" | "archived" | undefined,
			provider: provider as "aws" | "gcp" | "azure" | "local" | undefined,
			limit,
			offset,
		});

		const total = await templateRepository.count({
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
			status: status as "draft" | "published" | "archived" | undefined,
			provider: provider as "aws" | "gcp" | "azure" | "local" | undefined,
		});

		return c.json({ templates, total });
	} catch (error) {
		logger.error({ error }, "Failed to get templates");
		return c.json({ error: "Failed to get templates" }, 500);
	}
});

// テンプレート検索
templateRoutes.get(
	"/templates/search",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレート検索",
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
	const status = c.req.query("status");
	const provider = c.req.query("provider");
	const tags = c.req.query("tags")?.split(",").filter(Boolean);
	const sortBy = c.req.query("sortBy") || "updated";
	const page = parseInt(c.req.query("page") || "1");
	const limit = parseInt(c.req.query("limit") || "20");

	try {
		const result = await templateRepository.search({
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
			status: status as "draft" | "published" | "archived" | undefined,
			provider: provider as "aws" | "gcp" | "azure" | "local" | undefined,
			tags,
			sortBy: sortBy as "name" | "usageCount" | "newest" | "updated",
			page,
			limit,
		});

		return c.json(result);
	} catch (error) {
		logger.error({ error }, "Failed to search templates");
		return c.json({ error: "Failed to search templates" }, 500);
	}
});

// テンプレート詳細取得
templateRoutes.get(
	"/templates/:templateId",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレート詳細取得",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
	const templateId = c.req.param("templateId");

	try {
		const template = await templateRepository.findById(templateId);
		if (!template) {
			return c.json({ error: "Template not found" }, 404);
		}
		return c.json(template);
	} catch (error) {
		logger.error({ error }, "Failed to get template");
		return c.json({ error: "Failed to get template" }, 500);
	}
});

// テンプレート作成
templateRoutes.post(
	"/templates",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレート作成",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(createTemplateSchema),
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
	zValidator("json", createTemplateSchema),
	async (c) => {
		const data = c.req.valid("json");

		try {
			const template = await templateRepository.create({
				...data,
				usageCount: 0,
			});
			return c.json(template, 201);
		} catch (error) {
			logger.error({ error }, "Failed to create template");
			return c.json({ error: "Failed to create template" }, 500);
		}
	},
);

// テンプレート更新
templateRoutes.put(
	"/templates/:templateId",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレート更新",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(updateTemplateSchema),
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
	zValidator("json", updateTemplateSchema),
	async (c) => {
		const templateId = c.req.param("templateId");
		const data = c.req.valid("json");

		try {
			const exists = await templateRepository.exists(templateId);
			if (!exists) {
				return c.json({ error: "Template not found" }, 404);
			}

			const template = await templateRepository.update(templateId, data);
			return c.json(template);
		} catch (error) {
			logger.error({ error }, "Failed to update template");
			return c.json({ error: "Failed to update template" }, 500);
		}
	},
);

// テンプレート削除
templateRoutes.delete(
	"/templates/:templateId",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレート削除",
		responses: {
			200: { description: "成功" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	async (c) => {
	const templateId = c.req.param("templateId");

	try {
		const exists = await templateRepository.exists(templateId);
		if (!exists) {
			return c.json({ error: "Template not found" }, 404);
		}

		await templateRepository.delete(templateId);
		return c.json({ success: true });
	} catch (error) {
		logger.error({ error }, "Failed to delete template");
		return c.json({ error: "Failed to delete template" }, 500);
	}
});

// テンプレートから問題を生成
const createProblemFromTemplateSchema = z.object({
	title: z.string().min(1),
	variables: z.record(z.union([z.string(), z.number(), z.boolean()])),
	overrides: z
		.object({
			category: z
				.enum([
					"architecture",
					"security",
					"cost",
					"performance",
					"reliability",
					"operations",
				])
				.optional(),
			difficulty: z.enum(["easy", "medium", "hard", "expert"]).optional(),
			tags: z.array(z.string()).optional(),
		})
		.optional(),
});

templateRoutes.post(
	"/templates/:templateId/create-problem",
	describeRoute({
		tags: ["Admin / Templates"],
		summary: "テンプレートから問題生成",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(createProblemFromTemplateSchema),
				},
			},
		},
		responses: {
			201: { description: "作成成功" },
			400: { description: "バリデーションエラー" },
			401: { description: "認証エラー" },
			403: { description: "権限エラー" },
			404: { description: "リソースが見つからない" },
		},
	}),
	zValidator("json", createProblemFromTemplateSchema),
	async (c) => {
		const templateId = c.req.param("templateId");
		const data = c.req.valid("json");

		try {
			const template = await templateRepository.findById(templateId);
			if (!template) {
				return c.json({ error: "Template not found" }, 404);
			}

			// 必須変数のバリデーション
			const missingVariables = template.variables
				.filter((v) => v.required && !(v.name in data.variables))
				.map((v) => v.name);

			if (missingVariables.length > 0) {
				return c.json(
					{
						error: `Missing required variables: ${missingVariables.join(", ")}`,
					},
					400,
				);
			}

			// 変数を置換する関数
			const replaceVariables = (text: string): string => {
				let result = text;
				for (const [key, value] of Object.entries(data.variables)) {
					result = result.replace(
						new RegExp(`\\{\\{${key}\\}\\}`, "g"),
						String(value),
					);
				}
				return result;
			};

			// テンプレートから問題を生成
			const problemData = {
				id: crypto.randomUUID(),
				title: data.title,
				type: template.type,
				category: data.overrides?.category || template.category,
				difficulty: data.overrides?.difficulty || template.difficulty,
				metadata: {
					author: template.author,
					version: template.version,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					tags: data.overrides?.tags || template.tags,
				},
				description: {
					overview: replaceVariables(
						template.descriptionTemplate.overviewTemplate,
					),
					objectives:
						template.descriptionTemplate.objectivesTemplate.map(
							replaceVariables,
						),
					hints:
						template.descriptionTemplate.hintsTemplate.map(replaceVariables),
					prerequisites: template.descriptionTemplate.prerequisites,
					estimatedTime: template.descriptionTemplate.estimatedTime,
				},
				deployment: {
					providers: template.deployment.providers,
					templates: Object.fromEntries(
						template.deployment.providers.map((provider) => [
							provider,
							{
								type: template.deployment.templateType,
								path: "",
								parameters: data.variables as Record<string, string>,
							},
						]),
					),
					regions: template.deployment.regions || {},
					timeout: template.deployment.timeout,
				},
				scoring: {
					type: template.scoring.type,
					path: "",
					criteria: template.scoring.criteriaTemplate.map(
						(criterion, index) => ({
							name: `criterion_${index + 1}`,
							...criterion,
						}),
					),
					timeoutMinutes: template.scoring.timeoutMinutes,
				},
			};

			// 問題を作成
			const problem = await problemRepository.create(problemData);

			// テンプレートの使用回数をインクリメント
			await templateRepository.incrementUsageCount(templateId);

			return c.json(problem, 201);
		} catch (error) {
			logger.error({ error }, "Failed to create problem from template");
			return c.json({ error: "Failed to create problem from template" }, 500);
		}
	},
);

export { templateRoutes };
