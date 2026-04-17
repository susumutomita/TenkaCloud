/**
 * 問題インポート/エクスポートルート
 */

import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
	exportProblem,
	exportProblems,
	importProblem,
	importProblems,
	detectFormat,
	type ExternalFormat,
} from "../problems/converter";
import { logger, problemRepository } from "./admin-shared";

const importExportRoutes = new Hono();

// フォーマット検出スキーマ
const formatDetectSchema = z.object({
	filename: z.string(),
});

// エクスポートオプションスキーマ
const exportOptionsSchema = z.object({
	format: z.enum(["tenkacloud-yaml", "tenkacloud-json"]),
	prettyPrint: z.boolean().optional(),
});

// インポートオプションスキーマ
const importOptionsSchema = z.object({
	format: z.enum(["tenkacloud-yaml", "tenkacloud-json"]),
	data: z.string(),
});

// フォーマット検出
importExportRoutes.post(
	"/problems/detect-format",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題ファイルのフォーマット検出",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(formatDetectSchema),
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
	zValidator("json", formatDetectSchema),
	async (c) => {
		const { filename } = c.req.valid("json");
		const format = detectFormat(filename);

		if (!format) {
			return c.json(
				{
					error: "Unable to detect format from filename",
					supported: ["yaml", "yml", "json"],
				},
				400,
			);
		}

		return c.json({ format });
	},
);

// 単一問題エクスポート
importExportRoutes.post(
	"/problems/:problemId/export",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題エクスポート（単一）",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: resolver(exportOptionsSchema),
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
	zValidator("json", exportOptionsSchema),
	async (c) => {
		const problemId = c.req.param("problemId");
		const options = c.req.valid("json");

		try {
			const problem = await problemRepository.findById(problemId);
			if (!problem) {
				return c.json({ error: "Problem not found" }, 404);
			}

			const result = exportProblem(problem, {
				format: options.format as ExternalFormat,
				prettyPrint: options.prettyPrint,
			});

			if (!result.success) {
				return c.json(
					{ error: result.errors.join(", "), warnings: result.warnings },
					400,
				);
			}

			return c.json({
				data: result.data,
				format: options.format,
				warnings: result.warnings,
			});
		} catch (error) {
			logger.error({ error }, "Failed to export problem");
			return c.json({ error: "Failed to export problem" }, 500);
		}
	},
);

// 複数問題エクスポート
importExportRoutes.post(
	"/problems/export",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題エクスポート（複数）",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["format", "problemIds"],
						properties: {
							format: {
								type: "string",
								enum: ["tenkacloud-yaml", "tenkacloud-json"],
							},
							prettyPrint: { type: "boolean" },
							problemIds: {
								type: "array",
								items: { type: "string" },
								minItems: 1,
							},
						},
					},
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
	zValidator(
		"json",
		exportOptionsSchema.extend({
			problemIds: z.array(z.string()).min(1),
		}),
	),
	async (c) => {
		const { format, prettyPrint, problemIds } = c.req.valid("json");

		try {
			const problems = await Promise.all(
				problemIds.map((id) => problemRepository.findById(id)),
			);

			const validProblems = problems.filter((p) => p !== null);
			if (validProblems.length === 0) {
				return c.json({ error: "No valid problems found" }, 404);
			}

			const result = exportProblems(validProblems, {
				format: format as ExternalFormat,
				prettyPrint,
			});

			if (!result.success) {
				return c.json(
					{ error: result.errors.join(", "), warnings: result.warnings },
					400,
				);
			}

			return c.json({
				data: result.data,
				format,
				count: validProblems.length,
				warnings: result.warnings,
			});
		} catch (error) {
			logger.error({ error }, "Failed to export problems");
			return c.json({ error: "Failed to export problems" }, 500);
		}
	},
);

// 単一問題インポート（プレビューのみ - 保存は行わない）
importExportRoutes.post(
	"/problems/import/preview",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題インポートプレビュー（単一）",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["format", "data"],
						properties: {
							format: {
								type: "string",
								enum: ["tenkacloud-yaml", "tenkacloud-json"],
							},
							data: { type: "string" },
						},
					},
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
	zValidator("json", importOptionsSchema),
	async (c) => {
		const { format, data } = c.req.valid("json");

		try {
			const result = importProblem(data, { format: format as ExternalFormat });

			if (!result.success) {
				return c.json(
					{ error: result.errors.join(", "), warnings: result.warnings },
					400,
				);
			}

			return c.json({
				preview: result.data,
				warnings: result.warnings,
			});
		} catch (error) {
			logger.error({ error }, "Failed to preview problem import");
			return c.json({ error: "Failed to preview problem import" }, 500);
		}
	},
);

// 複数問題インポート（プレビューのみ - 保存は行わない）
importExportRoutes.post(
	"/problems/import/batch/preview",
	describeRoute({
		tags: ["Admin / Problems"],
		summary: "問題インポートプレビュー（複数）",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["format", "data"],
						properties: {
							format: {
								type: "string",
								enum: ["tenkacloud-yaml", "tenkacloud-json"],
							},
							data: { type: "string" },
						},
					},
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
	zValidator("json", importOptionsSchema),
	async (c) => {
		const { format, data } = c.req.valid("json");

		try {
			const result = importProblems(data, { format: format as ExternalFormat });

			if (!result.success) {
				return c.json(
					{ error: result.errors.join(", "), warnings: result.warnings },
					400,
				);
			}

			return c.json({
				preview: result.data,
				count: result.data?.length ?? 0,
				warnings: result.warnings,
			});
		} catch (error) {
			logger.error({ error }, "Failed to preview batch problem import");
			return c.json({ error: "Failed to preview batch problem import" }, 500);
		}
	},
);

export { importExportRoutes };
