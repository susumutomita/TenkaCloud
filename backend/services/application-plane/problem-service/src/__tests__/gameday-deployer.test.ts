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
	mockValidateCredentials: vi.fn(),
	mockDeployStack: vi.fn(),
}));

const {
	mockCreate,
	mockFindByEventId,
	mockFindActive,
	mockUpdateStatus,
	mockFindById,
	mockValidateCredentials,
	mockDeployStack,
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
		validateCredentials: mocks.mockValidateCredentials,
		deployStack: mocks.mockDeployStack,
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

	describe("subscribeToJob", () => {
		it("コールバックをサブスクライブしてアンサブスクライブできるべき", async () => {
			const { subscribeToJob } = await import("../problems/gameday-deployer");

			const callback = vi.fn();
			const unsub = subscribeToJob("job-test-id", callback);

			expect(typeof unsub).toBe("function");
			// アンサブスクライブが例外を投げないべき
			expect(() => unsub()).not.toThrow();
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
