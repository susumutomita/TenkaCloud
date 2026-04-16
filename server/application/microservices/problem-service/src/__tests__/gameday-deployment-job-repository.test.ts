/**
 * GameDayDeploymentJobRepository Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSend = vi.fn();
vi.mock("@tenkacloud/dynamodb", () => ({
	getDocClient: () => ({ send: mockSend }),
	getTableName: () => "TestTable",
}));

vi.mock("ulid", () => ({
	ulid: () => "job-ulid-001",
}));

import { GameDayDeploymentJobRepository } from "../repositories/gameday-deployment-job-repository";

const makeItem = (overrides: Record<string, unknown> = {}) => ({
	PK: "GAMEDAY_DEPLOY#EVENT#event-1#PROBLEM#problem-1",
	SK: "JOB#job-ulid-001",
	GSI1PK: "GAMEDAY_DEPLOY_ACTIVE",
	GSI1SK: "2024-01-01T00:00:00.000Z#job-ulid-001",
	EntityType: "GAMEDAY_DEPLOYMENT_JOB",
	CreatedAt: "2024-01-01T00:00:00.000Z",
	UpdatedAt: "2024-01-01T00:00:00.000Z",
	id: "job-ulid-001",
	eventId: "event-1",
	problemId: "problem-1",
	competitorAccountId: "account-1",
	provider: "aws",
	region: "ap-northeast-1",
	status: "pending",
	retryCount: 0,
	maxRetries: 3,
	...overrides,
});

describe("GameDayDeploymentJobRepository", () => {
	let repo: GameDayDeploymentJobRepository;

	beforeEach(() => {
		vi.clearAllMocks();
		repo = new GameDayDeploymentJobRepository();
	});

	describe("create", () => {
		it("デプロイジョブを作成できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			const result = await repo.create({
				eventId: "event-1",
				problemId: "problem-1",
				competitorAccountId: "account-1",
				provider: "aws",
				region: "ap-northeast-1",
				maxRetries: 3,
			});

			expect(result.id).toBe("job-ulid-001");
			expect(result.status).toBe("pending");
			expect(result.retryCount).toBe(0);
			expect(result.maxRetries).toBe(3);
		});

		it("maxRetries のデフォルト値は 3 であるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			const result = await repo.create({
				eventId: "event-1",
				problemId: "problem-1",
				competitorAccountId: "account-1",
				provider: "aws",
				region: "us-east-1",
			});

			expect(result.maxRetries).toBe(3);
		});
	});

	describe("findById", () => {
		it("存在するジョブを取得できるべき", async () => {
			mockSend.mockResolvedValueOnce({ Item: makeItem() });

			const result = await repo.findById(
				"event-1",
				"problem-1",
				"job-ulid-001",
			);

			expect(result).not.toBeNull();
			expect(result?.id).toBe("job-ulid-001");
			expect(result?.status).toBe("pending");
		});

		it("存在しないジョブは null を返すべき", async () => {
			mockSend.mockResolvedValueOnce({ Item: undefined });

			const result = await repo.findById("event-1", "problem-1", "non-existent");

			expect(result).toBeNull();
		});
	});

	describe("findByEventAndProblem", () => {
		it("イベントと問題に紐づくジョブを取得できるべき", async () => {
			mockSend.mockResolvedValueOnce({ Items: [makeItem(), makeItem({ id: "job-002" })] });

			const result = await repo.findByEventAndProblem("event-1", "problem-1");

			expect(result).toHaveLength(2);
		});

		it("ジョブがない場合は空配列を返すべき", async () => {
			mockSend.mockResolvedValueOnce({ Items: [] });

			const result = await repo.findByEventAndProblem("event-1", "problem-none");

			expect(result).toEqual([]);
		});
	});

	describe("findActive", () => {
		it("アクティブなジョブを取得できるべき", async () => {
			mockSend.mockResolvedValueOnce({ Items: [makeItem()] });

			const result = await repo.findActive();

			expect(result).toHaveLength(1);
		});
	});

	describe("updateStatus", () => {
		it("ステータスを in_progress に更新できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			await repo.updateStatus("event-1", "problem-1", "job-ulid-001", "in_progress");

			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it("ステータスを completed に更新できるべき（GSI 削除）", async () => {
			mockSend.mockResolvedValueOnce({});

			await repo.updateStatus("event-1", "problem-1", "job-ulid-001", "completed", {
				result: {
					success: true,
					stackName: "tc-team01-problem1",
					stackId: "arn:aws:cfn:...",
					outputs: { WebsiteURL: "https://example.com" },
					startedAt: new Date(),
					completedAt: new Date(),
				},
			});

			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it("エラーメッセージ付きで failed に更新できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			await repo.updateStatus("event-1", "problem-1", "job-ulid-001", "failed", {
				error: "Deployment failed: timeout",
			});

			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it("retryCount を更新できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			await repo.updateStatus("event-1", "problem-1", "job-ulid-001", "pending", {
				retryCount: 2,
			});

			expect(mockSend).toHaveBeenCalledTimes(1);
		});
	});
});
