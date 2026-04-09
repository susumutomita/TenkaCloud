import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { afterEach, describe, expect, it } from "vitest";

const originalProblemsDir = process.env.PROBLEMS_DIR;

afterEach(() => {
	process.env.PROBLEMS_DIR = originalProblemsDir;
	vi.resetModules();
});

describe("problem-assets", () => {
	it("存在しないアセットは明確な not found エラーを返すべき", async () => {
		const baseDir = await mkdtemp(nodePath.join(tmpdir(), "problem-assets-"));
		process.env.PROBLEMS_DIR = baseDir;
		const { resolveProblemAssetPath } = await import("../providers/problem-assets");

		await expect(
			resolveProblemAssetPath("gameday/missing/template.yaml"),
		).rejects.toThrow("Problem asset not found: gameday/missing/template.yaml");
	});

	it("ベースディレクトリ配下のテキストアセットを読み込めるべき", async () => {
		const baseDir = await mkdtemp(nodePath.join(tmpdir(), "problem-assets-"));
		const assetDir = nodePath.join(baseDir, "gameday");
		const assetPath = nodePath.join(assetDir, "template.yaml");
		process.env.PROBLEMS_DIR = baseDir;
		const { loadProblemTextAsset } = await import("../providers/problem-assets");

		await mkdir(assetDir, { recursive: true });
		await writeFile(assetPath, "Resources: {}\n", "utf-8");

		await expect(loadProblemTextAsset("gameday/template.yaml")).resolves.toBe(
			"Resources: {}\n",
		);
	});
});
