import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
	execFileMock: vi.fn((_file, _args, _options, callback) => callback(null, "")),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

vi.mock("../providers/problem-assets", () => ({
	resolveProblemAssetPath: vi.fn(async () => "/tmp/problem/local/docker-compose.yaml"),
}));

import {
	getLocalProvider,
	LocalCloudProvider,
} from "../providers/local";

describe("LocalCloudProvider", () => {
	beforeEach(() => {
		execFileMock.mockClear();
	});

	it("getLocalProvider は同じインスタンスを返すべき", () => {
		expect(getLocalProvider()).toBe(getLocalProvider());
	});

	it("スタックを削除したあとでも新しいデプロイでポートを再利用しないべき", async () => {
		const provider = new LocalCloudProvider();
		const credentials = {
			provider: "local" as const,
			accountId: "local-dev",
		};
		const problem = {
			id: "problem-1",
			deployment: {
				templates: {
					local: {
						path: "gameday/local/docker-compose.yaml",
					},
				},
			},
		} as never;

		const first = await provider.deployStack(problem, credentials, {
			stackName: "team-a",
			region: "local",
			dryRun: false,
		});
		await provider.deleteStack("team-a", credentials);
		const second = await provider.deployStack(problem, credentials, {
			stackName: "team-b",
			region: "local",
			dryRun: false,
		});

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(first.outputs?.ApiUrl).toBe("http://localhost:18080");
		expect(second.outputs?.ApiUrl).toBe("http://localhost:18090");
		expect(execFileMock).toHaveBeenCalledTimes(3);
	});
});
