/**
 * ProblemDeployPublisher Tests
 *
 * EventBridge を使った問題デプロイイベントの publish をテストする。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProblemDeployRequestedDetail } from "@tenkacloud/events";

// ============================================================
// モック
// ============================================================

const mocks = vi.hoisted(() => ({
	mockSend: vi.fn(),
	mockDeployProblem: vi.fn(),
}));

vi.mock("@aws-sdk/client-eventbridge", () => {
	return {
		EventBridgeClient: class {
			send = mocks.mockSend;
		},
		PutEventsCommand: class {
			input: unknown;
			constructor(input: unknown) {
				this.input = input;
			}
		},
	};
});

// Note: dev-only inline mode previously dynamically imported lib/handlers/deploy-problem,
// but that path is dead post-PR-#398. Tests now inject inlineRunner directly.

// ============================================================
// テストデータ
// ============================================================

const makeDetail = (
	overrides: Partial<ProblemDeployRequestedDetail> = {},
): ProblemDeployRequestedDetail => ({
	problemId: "problem-1",
	teamId: "team-1",
	tenantId: "tenant-1",
	eventId: "event-1",
	jobId: "job-1",
	targetRoleArn: "arn:aws:iam::123456789012:role/DeployRole",
	externalId: "ext-id-123",
	templateUrl: "https://s3.amazonaws.com/bucket/template.yaml",
	deploymentKey: "event-1:problem-1:job-1",
	timestamp: "2026-01-01T00:00:00.000Z",
	...overrides,
});

// ============================================================
// テスト
// ============================================================

describe("ProblemDeployPublisher", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("EventBridge モード", () => {
		async function callPublish() {
			const { ProblemDeployPublisher } = await import("../deploy-publisher");
			mocks.mockSend.mockResolvedValueOnce({
				FailedEntryCount: 0,
				Entries: [{ EventId: "evt-1" }],
			});
			const publisher = new ProblemDeployPublisher({
				deliveryMode: "eventbridge",
				eventBusName: "test-bus",
			});
			await publisher.publishDeployRequested(makeDetail());
			return mocks.mockSend.mock.calls[0][0].input.Entries[0];
		}

		it("EventBridge に 1 回だけ publish すべき", async () => {
			await callPublish();
			expect(mocks.mockSend).toHaveBeenCalledOnce();
		});

		it("entry の EventBusName が指定値になるべき", async () => {
			const entry = await callPublish();
			expect(entry.EventBusName).toBe("test-bus");
		});

		it("entry の Source と DetailType が正しいべき", async () => {
			const entry = await callPublish();
			expect(entry.Source).toBe("tenkacloud.problem-service");
			expect(entry.DetailType).toBe("ProblemDeployRequested");
		});

		it("detail に problemId / teamId / tenantId が含まれるべき", async () => {
			const entry = await callPublish();
			const parsed = JSON.parse(entry.Detail);
			expect(parsed.problemId).toBe("problem-1");
			expect(parsed.teamId).toBe("team-1");
			expect(parsed.tenantId).toBe("tenant-1");
		});

		it("detail に targetRoleArn が含まれるべき", async () => {
			const entry = await callPublish();
			const parsed = JSON.parse(entry.Detail);
			expect(parsed.targetRoleArn).toBe(
				"arn:aws:iam::123456789012:role/DeployRole",
			);
		});

		it("EventBridge 送信失敗時にエラーを投げるべき", async () => {
			const { ProblemDeployPublisher } = await import("../deploy-publisher");

			mocks.mockSend.mockResolvedValueOnce({
				FailedEntryCount: 1,
				Entries: [
					{
						ErrorCode: "InternalFailure",
						ErrorMessage: "Service unavailable",
					},
				],
			});

			const publisher = new ProblemDeployPublisher({
				deliveryMode: "eventbridge",
				eventBusName: "test-bus",
			});

			await expect(
				publisher.publishDeployRequested(makeDetail()),
			).rejects.toThrow(
				"Failed to publish problem deploy event: InternalFailure - Service unavailable",
			);
		});
	});

	describe("inline モード", () => {
		it("inline モードで inlineRunner が DI されていれば呼ぶべき", async () => {
			const { ProblemDeployPublisher } = await import("../deploy-publisher");

			const customRunner = vi.fn().mockResolvedValue(undefined);
			const publisher = new ProblemDeployPublisher({
				deliveryMode: "inline",
				inlineRunner: customRunner,
			});

			const detail = makeDetail();
			await publisher.publishDeployRequested(detail);

			expect(customRunner).toHaveBeenCalledOnce();
			expect(customRunner).toHaveBeenCalledWith(detail);
			expect(mocks.mockSend).not.toHaveBeenCalled();
		});

		it("inline モードで inlineRunner が DI されていなければエラーを投げるべき", async () => {
			const { ProblemDeployPublisher } = await import("../deploy-publisher");

			const publisher = new ProblemDeployPublisher({
				deliveryMode: "inline",
			});

			await expect(
				publisher.publishDeployRequested(makeDetail()),
			).rejects.toThrow(/inline delivery mode requires an inlineRunner/);
		});

		it("inlineRunner が reject した場合はそれを伝播すべき", async () => {
			const { ProblemDeployPublisher } = await import("../deploy-publisher");

			const customRunner = vi
				.fn()
				.mockRejectedValue(
					new Error(
						"Problem deployment failed for problem problem-1 team team-1",
					),
				);
			const publisher = new ProblemDeployPublisher({
				deliveryMode: "inline",
				inlineRunner: customRunner,
			});

			await expect(
				publisher.publishDeployRequested(makeDetail()),
			).rejects.toThrow(
				"Problem deployment failed for problem problem-1 team team-1",
			);
		});
	});
});
