/**
 * GameDay Deployer Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Problem } from "../types";

// ============================================================
// モック
// ============================================================

const mocks = vi.hoisted(() => ({
	mockCreate: vi.fn(),
	mockFindByEventId: vi.fn(),
	mockFindActive: vi.fn(),
	mockUpdateStatus: vi.fn(),
	mockFindById: vi.fn(),
	mockValidateAwsCredentials: vi.fn(),
	mockDeployAwsStack: vi.fn(),
	mockValidateLocalCredentials: vi.fn(),
	mockDeployLocalStack: vi.fn(),
}));

const {
	mockCreate,
	mockFindByEventId,
	mockFindActive,
	mockUpdateStatus,
	mockFindById,
	mockValidateAwsCredentials,
	mockDeployAwsStack,
	mockValidateLocalCredentials,
	mockDeployLocalStack,
} = mocks;

vi.mock("../repositories/competitor-account-repository", () => ({
	CompetitorAccountRepository: class {
		create = mocks.mockCreate;
		findByEventId = mocks.mockFindByEventId;
		findById = vi.fn();
		updateStatus = vi.fn();
		delete = vi.fn();
	},
}));

vi.mock("../repositories/gameday-deployment-job-repository", () => ({
	GameDayDeploymentJobRepository: class {
		create = mocks.mockCreate;
		findByEventAndProblem = vi.fn();
		findById = mocks.mockFindById;
		findActive = mocks.mockFindActive;
		updateStatus = mocks.mockUpdateStatus;
	},
}));

vi.mock("../providers/aws", () => ({
	getAWSProvider: () => ({
		validateCredentials: mocks.mockValidateAwsCredentials,
		deployStack: mocks.mockDeployAwsStack,
	}),
}));

vi.mock("../providers/local", () => ({
	getLocalProvider: () => ({
		validateCredentials: mocks.mockValidateLocalCredentials,
		deployStack: mocks.mockDeployLocalStack,
	}),
}));

// ============================================================
// テストデータ
// ============================================================

const makeProblem = (): Problem => ({
	id: "problem-1",
	title: "Test Problem",
	type: "gameday",
	category: "security",
	difficulty: "medium",
	metadata: {
		author: "test",
		version: "1.0.0",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		tags: [],
		license: "MIT",
	},
	description: {
		overview: "Test",
		objectives: [],
		hints: [],
		prerequisites: [],
		estimatedTime: 60,
	},
	deployment: {
		providers: ["aws"],
		templates: {
			aws: {
				type: "cloudformation",
				path: "https://raw.githubusercontent.com/example/repo/main/template.yaml",
			},
		},
		regions: { aws: ["ap-northeast-1"] },
		timeout: 60,
	},
	scoring: {
		type: "manual",
		path: "/scoring",
		criteria: [],
		timeoutMinutes: 5,
	},
});

const makeLocalProblem = (): Problem => ({
	...makeProblem(),
	deployment: {
		providers: ["aws", "local"],
		templates: {
			aws: makeProblem().deployment.templates.aws,
			local: {
				type: "docker-compose",
				path: "gameday/security-battle-royale/local/docker-compose.yaml",
			},
		},
		regions: { aws: ["ap-northeast-1"], local: ["local"] },
		timeout: 60,
	},
});

const makeAccount = (id: string, name: string) => ({
	id,
	eventId: "event-1",
	name,
	provider: "aws" as const,
	accountId: "123456789012",
	region: "ap-northeast-1",
	roleArn: "arn:aws:iam::123456789012:role/DeployRole",
	status: "pending" as const,
});

const makeLocalAccount = (id: string, name: string) => ({
	id,
	eventId: "event-1",
	name,
	provider: "local" as const,
	accountId: `local-${id}`,
	region: "local",
	status: "pending" as const,
});

const makeJob = (overrides: Record<string, unknown> = {}) => ({
	id: "job-1",
	eventId: "event-1",
	problemId: "problem-1",
	competitorAccountId: "account-1",
	provider: "aws" as const,
	region: "ap-northeast-1",
	status: "pending" as const,
	retryCount: 0,
	maxRetries: 3,
	createdAt: new Date(),
	...overrides,
});

// ============================================================
// テスト
// ============================================================

describe("gameday-deployer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("getGameDayDeploymentValidationError", () => {
		it("GameDay の AWS 問題はデプロイ可能と判定すべき", async () => {
			const { getGameDayDeploymentValidationError } = await import(
				"../problems/gameday-deployer"
			);

			expect(getGameDayDeploymentValidationError(makeProblem())).toBeNull();
		});

		it("GameDay 以外の問題は未対応と判定すべき", async () => {
			const { getGameDayDeploymentValidationError } = await import(
				"../problems/gameday-deployer"
			);

			expect(
				getGameDayDeploymentValidationError({
					...makeProblem(),
					type: "jam",
				}),
			).toBe("Team deployment is only supported for GameDay problems");
		});

		it("AWS テンプレートがない問題は未対応と判定すべき", async () => {
			const { getGameDayDeploymentValidationError } = await import(
				"../problems/gameday-deployer"
			);

			expect(
				getGameDayDeploymentValidationError({
					...makeProblem(),
					deployment: {
						...makeProblem().deployment,
						templates: {},
					},
				}),
			).toBe("Team deployment requires an AWS deployment template");
		});

		it("local provider に対応した問題は local チームデプロイ可能と判定すべき", async () => {
			const { getGameDayDeploymentValidationError } = await import(
				"../problems/gameday-deployer"
			);

			expect(
				getGameDayDeploymentValidationError(makeLocalProblem(), "local"),
			).toBeNull();
		});
	});

	describe("reconcile", () => {
		it("アクティブジョブがない場合は何もしないべき", async () => {
			mockFindActive.mockResolvedValueOnce([]);
			const { reconcile } = await import("../problems/gameday-deployer");

			await reconcile();
			expect(mockUpdateStatus).not.toHaveBeenCalled();
		});

		it("アクティブジョブを failed にリセットするべき", async () => {
			const activeJob = makeJob({ status: "in_progress" });
			mockFindActive.mockResolvedValueOnce([activeJob]);
			mockFindByEventId.mockResolvedValueOnce([makeAccount("account-1", "team01")]);
			mockUpdateStatus.mockResolvedValueOnce(undefined);

			const { reconcile } = await import("../problems/gameday-deployer");
			await reconcile();

			expect(mockUpdateStatus).toHaveBeenCalledWith(
				"event-1",
				"problem-1",
				"job-1",
				"failed",
				expect.objectContaining({ error: expect.stringContaining("restarted") }),
			);
		});

		it("アカウントが見つからない場合も failed にリセットするべき", async () => {
			const activeJob = makeJob({ status: "pending", competitorAccountId: "non-existent" });
			mockFindActive.mockResolvedValueOnce([activeJob]);
			mockFindByEventId.mockResolvedValueOnce([]); // アカウントなし
			mockUpdateStatus.mockResolvedValueOnce(undefined);

			const { reconcile } = await import("../problems/gameday-deployer");
			await reconcile();

			expect(mockUpdateStatus).toHaveBeenCalledWith(
				"event-1",
				"problem-1",
				"job-1",
				"failed",
				expect.objectContaining({ error: expect.stringContaining("not found") }),
			);
		});
	});

	describe("deployProblemToTeams", () => {
		it("アカウントがない場合は空配列を返すべき", async () => {
			mockFindByEventId.mockResolvedValueOnce([]);

			const { deployProblemToTeams } = await import("../problems/gameday-deployer");
			const problem = makeProblem();
			const result = await deployProblemToTeams(problem, "event-no-accounts");

			expect(result).toEqual([]);
		});

		it("local competitor account に対して local provider のジョブを作成すべき", async () => {
			const job = makeJob({
				id: "job-local-1",
				competitorAccountId: "account-local-1",
				provider: "local",
				region: "local",
			});
			mockFindByEventId.mockResolvedValueOnce([
				makeLocalAccount("account-local-1", "team-local-1"),
			]);
			mockCreate.mockResolvedValueOnce(job);
			mockUpdateStatus.mockResolvedValue(undefined);
			mockFindById
				.mockResolvedValueOnce(job)
				.mockResolvedValueOnce({
					...job,
					status: "in_progress",
				})
				.mockResolvedValueOnce({
					...job,
					status: "completed",
					result: {
						success: true,
						stackName: "tc-teamlocal1-problem1",
						stackId: "local-stack-1",
						outputs: { FrontendUrl: "http://localhost:4301" },
						startedAt: new Date(),
						completedAt: new Date(),
					},
				});
			mockValidateLocalCredentials.mockResolvedValueOnce(true);
			mockDeployLocalStack.mockResolvedValueOnce({
				success: true,
				stackName: "tc-teamlocal1-problem1",
				stackId: "local-stack-1",
				outputs: { FrontendUrl: "http://localhost:4301" },
				startedAt: new Date(),
				completedAt: new Date(),
			});

			const { deployProblemToTeams } = await import("../problems/gameday-deployer");
			const jobs = await deployProblemToTeams(makeLocalProblem(), "event-1", 1);

			expect(jobs).toHaveLength(1);
			expect(jobs[0]?.provider).toBe("local");

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockValidateLocalCredentials).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: "local",
					region: "local",
					accountId: "local-account-local-1",
				}),
			);
			expect(mockDeployLocalStack).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({ provider: "local" }),
				expect.objectContaining({
					region: "local",
					parameters: expect.objectContaining({ TeamName: "team-local-1" }),
				}),
			);
		});
	});

	describe("retryJob", () => {
		it("failed でないジョブはリトライできないべき", async () => {
			mockFindById.mockResolvedValueOnce(makeJob({ status: "in_progress" }));
			mockFindByEventId.mockResolvedValueOnce([makeAccount("account-1", "team01")]);

			const { retryJob } = await import("../problems/gameday-deployer");
			const problem = makeProblem();

			const result = await retryJob("event-1", "problem-1", "job-1", problem);

			expect(result).toBeNull();
		});

		it("存在しないジョブはリトライできないべき", async () => {
			mockFindById.mockResolvedValueOnce(null);

			const { retryJob } = await import("../problems/gameday-deployer");
			const problem = makeProblem();

			const result = await retryJob("event-1", "problem-1", "non-existent", problem);

			expect(result).toBeNull();
		});
	});
});
