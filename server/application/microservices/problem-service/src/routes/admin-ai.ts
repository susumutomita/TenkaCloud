/**
 * AI 問題生成ヘルパー + ルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type {
	ProblemCategory,
	DifficultyLevel,
	CloudProvider,
} from "../types";
import { logger, problemRepository } from "./admin-shared";

const aiRoutes = new Hono();

// ====================
// AI 問題生成ヘルパー
// ====================

interface AiGenerationInput {
	topic: string;
	type: "gameday" | "jam";
	category: ProblemCategory;
	difficulty: DifficultyLevel;
	cloudProvider: CloudProvider;
	targetServices?: string[];
	additionalContext?: string;
	language: "ja" | "en";
}

interface AiGeneratedProblem {
	title: string;
	description: {
		overview: string;
		objectives: string[];
		hints: string[];
		prerequisites: string[];
		estimatedTime?: number;
	};
	scoring?: {
		criteria: {
			name: string;
			description?: string;
			weight: number;
			maxPoints: number;
		}[];
	};
	suggestedResources?: string[];
}

async function callAnthropicApi(
	input: AiGenerationInput,
): Promise<
	| { success: true; data: AiGeneratedProblem }
	| { success: false; error: string }
> {
	const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
	if (!anthropicApiKey) {
		return {
			success: false,
			error: "AI generation not configured: ANTHROPIC_API_KEY is missing",
		};
	}

	const systemPrompt = `あなたはクラウド技術の競技問題を作成する専門家です。
TenkaCloud プラットフォーム用の問題を生成してください。

出力は以下の JSON 形式で返してください：
{
  "title": "問題タイトル",
  "description": {
    "overview": "問題の概要（シナリオ背景を含む）",
    "objectives": ["目標1", "目標2", ...],
    "hints": ["ヒント1", "ヒント2", ...],
    "prerequisites": ["前提知識1", "前提知識2", ...],
    "estimatedTime": 60
  },
  "scoring": {
    "criteria": [
      {"name": "criterion_1", "description": "評価基準の説明", "weight": 0.5, "maxPoints": 50},
      ...
    ]
  },
  "suggestedResources": ["参考リソースURL1", ...]
}

注意事項:
- 問題は実践的で、実際のクラウド運用シナリオに基づくこと
- 難易度に応じた適切な複雑さにすること
- セキュリティベストプラクティスを考慮すること`;

	const userPrompt = `以下の条件で問題を生成してください：

トピック: ${input.topic}
タイプ: ${input.type === "gameday" ? "GameDay（トラブルシューティング）" : "Jam（構築課題）"}
カテゴリ: ${input.category}
難易度: ${input.difficulty}
クラウドプロバイダー: ${input.cloudProvider.toUpperCase()}
${input.targetServices ? `使用サービス: ${input.targetServices.join(", ")}` : ""}
${input.additionalContext ? `追加コンテキスト: ${input.additionalContext}` : ""}
言語: ${input.language === "ja" ? "日本語" : "英語"}`;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 60000);

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": anthropicApiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				max_tokens: 4096,
				system: systemPrompt,
				messages: [{ role: "user", content: userPrompt }],
			}),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errorText = await response.text();
			logger.error({ errorText }, "Anthropic API error");
			return { success: false, error: "AI generation failed" };
		}

		const result = (await response.json()) as {
			content?: { type: string; text: string }[];
		};
		const content = result.content?.[0]?.text;

		if (!content) {
			return { success: false, error: "AI returned empty response" };
		}

		// JSON を抽出（マークダウンコードブロック対応）
		let jsonContent = content;
		const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonContent = jsonMatch[1].trim();
		}

		const generatedProblem = JSON.parse(jsonContent) as AiGeneratedProblem;
		return { success: true, data: generatedProblem };
	} catch (error) {
		logger.error({ error }, "Failed to generate problem with AI");
		if (error instanceof Error && error.name === "AbortError") {
			return { success: false, error: "AI generation request timed out" };
		}
		if (error instanceof SyntaxError) {
			return { success: false, error: "AI returned invalid JSON format" };
		}
		return { success: false, error: "Failed to generate problem with AI" };
	}
}

function getAiErrorStatusCode(error: string): 500 | 503 | 504 {
	if (error.includes("not configured")) return 503;
	if (error.includes("timed out")) return 504;
	return 500;
}

interface BuildProblemOptions {
	includeSuggestedResources?: boolean;
	includeTimestamps?: boolean;
	includeAiGeneratedTag?: boolean;
}

function buildProblemFromAiResult(
	input: AiGenerationInput,
	generated: AiGeneratedProblem,
	options: BuildProblemOptions = {},
): Record<string, unknown> {
	const {
		includeSuggestedResources = false,
		includeTimestamps = false,
		includeAiGeneratedTag = false,
	} = options;

	const tags = [input.topic, input.cloudProvider, input.category];
	if (includeAiGeneratedTag) {
		tags.push("ai-generated");
	}

	const metadata: Record<string, unknown> = {
		author: "AI Generated",
		version: "1.0.0",
		tags,
	};

	if (includeTimestamps) {
		const now = new Date().toISOString();
		metadata.createdAt = now;
		metadata.updatedAt = now;
	}

	const problem: Record<string, unknown> = {
		title: generated.title,
		type: input.type,
		category: input.category,
		difficulty: input.difficulty,
		description: generated.description,
		metadata,
		deployment: {
			providers: [input.cloudProvider],
			timeout: 60,
			templates: {},
			regions: {},
		},
		scoring: {
			type: "manual" as const,
			path: "",
			timeoutMinutes: 5,
			criteria: generated.scoring?.criteria || [],
		},
	};

	if (includeSuggestedResources) {
		problem.suggestedResources = generated.suggestedResources || [];
	}

	return problem;
}

// ====================
// AI 問題生成ルート
// ====================

// AI 問題生成リクエストスキーマ
const aiGenerateProblemSchema = z.object({
	topic: z.string().min(1).max(200).describe("生成する問題のトピック"),
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
	cloudProvider: z.enum(["aws", "gcp", "azure", "local"]),
	targetServices: z
		.array(z.string().max(100))
		.max(20)
		.optional()
		.describe("使用するクラウドサービス"),
	additionalContext: z
		.string()
		.max(4000)
		.optional()
		.describe("追加のコンテキスト"),
	language: z.enum(["ja", "en"]).default("ja"),
});

// AI 問題生成（プレビュー）
aiRoutes.post(
	"/ai/generate/preview",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "AI問題生成プレビュー",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(aiGenerateProblemSchema),
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
	zValidator("json", aiGenerateProblemSchema),
	async (c) => {
		const input = c.req.valid("json");
		const result = await callAnthropicApi(input);

		if (!result.success) {
			return c.json(
				{ error: result.error },
				getAiErrorStatusCode(result.error),
			);
		}

		const preview = buildProblemFromAiResult(input, result.data, {
			includeSuggestedResources: true,
		});
		return c.json({
			preview,
			rawResponse: result.data,
			inputParameters: input,
		});
	},
);

// AI 問題生成（作成）
aiRoutes.post(
	"/ai/generate",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "AI問題生成（保存）",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(aiGenerateProblemSchema),
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
	zValidator("json", aiGenerateProblemSchema),
	async (c) => {
		const input = c.req.valid("json");
		const result = await callAnthropicApi(input);

		if (!result.success) {
			return c.json(
				{ error: result.error },
				getAiErrorStatusCode(result.error),
			);
		}

		const problemData = buildProblemFromAiResult(input, result.data, {
			includeTimestamps: true,
			includeAiGeneratedTag: true,
		});

		try {
			const problem = await problemRepository.create({
				id: crypto.randomUUID(),
				...(problemData as Omit<
					Parameters<typeof problemRepository.create>[0],
					"id"
				>),
			});

			return c.json(problem, 201);
		} catch (error) {
			logger.error({ error }, "Failed to save AI-generated problem");
			return c.json(
				{ error: "Failed to save generated problem to database" },
				500,
			);
		}
	},
);

export { aiRoutes };
