import { createServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => {
	const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
	const getStdout = (args: unknown[]) =>
		Array.isArray(args) && args.includes("config") && args.includes("--services")
			? "mysql\napi\nfrontend\n"
			: Array.isArray(args) &&
				  args.includes("ps") &&
				  args.includes("--status") &&
				  args.includes("running")
				? "mysql\napi\nfrontend\n"
				: "";

	const execFileMock = vi.fn((_file, args, maybeOptions, maybeCallback) => {
		const callback =
			typeof maybeOptions === "function" ? maybeOptions : maybeCallback;
		callback?.(null, getStdout(args), "");
	});

	Object.defineProperty(execFileMock, promisifyCustom, {
		value: async (_file: string, args: unknown[]) => ({
			stdout: getStdout(args),
			stderr: "",
		}),
	});

	return { execFileMock };
});

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

	it("スタックを削除したあとは空いたポートを再利用できるべき", async () => {
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
		expect(second.outputs?.ApiUrl).toBe("http://localhost:18080");
	});

	it("既に使用中のポートをスキップしてデプロイすべき", async () => {
		const occupiedFrontend = createServer();
		const occupiedApi = createServer();
		const occupiedDb = createServer();

		await Promise.all([
			new Promise<void>((resolve) =>
				occupiedFrontend.listen(13080, "127.0.0.1", () => resolve()),
			),
			new Promise<void>((resolve) =>
				occupiedApi.listen(18080, "127.0.0.1", () => resolve()),
			),
			new Promise<void>((resolve) =>
				occupiedDb.listen(3306, "127.0.0.1", () => resolve()),
			),
		]);

		try {
			const provider = new LocalCloudProvider();
			const credentials = {
				provider: "local" as const,
				accountId: "local-dev",
			};
			const problem = {
				id: "problem-2",
				deployment: {
					templates: {
						local: {
							path: "gameday/local/docker-compose.yaml",
						},
					},
				},
			} as never;

			const result = await provider.deployStack(problem, credentials, {
				stackName: "team-c",
				region: "local",
				dryRun: false,
			});

			expect(result.success).toBe(true);
			expect(result.outputs?.FrontendUrl).toBe("http://localhost:13090");
			expect(result.outputs?.ApiUrl).toBe("http://localhost:18090");
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => occupiedFrontend.close(() => resolve())),
				new Promise<void>((resolve) => occupiedApi.close(() => resolve())),
				new Promise<void>((resolve) => occupiedDb.close(() => resolve())),
			]);
		}
	});

});
