/**
 * Internal Deploy Events Receiver Tests
 *
 * /api/internal/deploy-events — EventBridge API Destination から呼ばれる
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

const { mockUpdateStatus } = vi.hoisted(() => ({
	mockUpdateStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../repositories/gameday-deployment-job-repository", () => ({
	GameDayDeploymentJobRepository: class {
		updateStatus = mockUpdateStatus;
	},
}));

vi.mock("../repositories", () => ({
	PrismaEventRepository: class {},
	PrismaProblemRepository: class {},
	PrismaMarketplaceRepository: class {},
	PrismaProblemTemplateRepository: class {},
}));

vi.mock("../repositories/competitor-account-repository", () => ({
	CompetitorAccountRepository: class {},
}));

vi.mock("../auth", () => ({
	authenticateRequest: vi.fn(),
	hasRole: vi.fn(),
	UserRole: {
		PLATFORM_ADMIN: "platform-admin",
		TENANT_ADMIN: "tenant-admin",
		ORGANIZER: "organizer",
		COMPETITOR: "competitor",
	},
}));

describe("POST /deploy-events", () => {
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.INTERNAL_EVENT_TOKEN = "test-token";
		process.env.NODE_ENV = "production";
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	async function getApp() {
		const { internalDeployEventsRoutes } = await import(
			"../routes/internal-deploy-events"
		);
		const app = new Hono();
		app.route("/api/internal", internalDeployEventsRoutes);
		return app;
	}

	it("認証トークンが一致しない場合は 401 を返すべき", async () => {
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-TenkaCloud-Internal-Token": "wrong-token",
			},
			body: JSON.stringify({
				"detail-type": "problem.deploy.completed",
				detail: {
					deploymentKey: "event-1:problem-1:job-1",
					jobOutput: { tenantData: { deployStatus: "completed" } },
				},
			}),
		});

		expect(res.status).toBe(401);
		expect(mockUpdateStatus).not.toHaveBeenCalled();
	});

	it("completed イベントの stackOutputs を JSON パースして outputs に保存すべき", async () => {
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-TenkaCloud-Internal-Token": "test-token",
			},
			body: JSON.stringify({
				"detail-type": "problem.deploy.completed",
				detail: {
					deploymentKey: "event-1:problem-1:job-1",
					jobOutput: {
						tenantData: {
							deployStatus: "completed",
							stackName: "tc-team01",
							stackOutputs: JSON.stringify({
								Endpoint: "https://x.example",
								BucketName: "bkt-1",
							}),
						},
					},
				},
			}),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateStatus).toHaveBeenCalledWith(
			"event-1",
			"problem-1",
			"job-1",
			"completed",
			expect.objectContaining({
				result: expect.objectContaining({
					outputs: { Endpoint: "https://x.example", BucketName: "bkt-1" },
				}),
			}),
		);
	});

	it("不正な stackOutputs JSON は空の outputs に fallback すべき", async () => {
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-TenkaCloud-Internal-Token": "test-token",
			},
			body: JSON.stringify({
				"detail-type": "problem.deploy.completed",
				detail: {
					deploymentKey: "event-1:problem-1:job-1",
					jobOutput: {
						tenantData: {
							deployStatus: "completed",
							stackOutputs: "not-json",
						},
					},
				},
			}),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateStatus).toHaveBeenCalledWith(
			"event-1",
			"problem-1",
			"job-1",
			"completed",
			expect.objectContaining({
				result: expect.objectContaining({ outputs: {} }),
			}),
		);
	});

	it("completed イベントで job を completed に更新すべき", async () => {
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-TenkaCloud-Internal-Token": "test-token",
			},
			body: JSON.stringify({
				"detail-type": "problem.deploy.completed",
				source: "tenkacloud.problem-deploy-plane",
				detail: {
					deploymentKey: "event-1:problem-1:job-1",
					jobOutput: {
						tenantData: {
							deployStatus: "completed",
							stackName: "tc-team01",
							stackId: "arn:aws:cloudformation:...",
						},
					},
				},
			}),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateStatus).toHaveBeenCalledWith(
			"event-1",
			"problem-1",
			"job-1",
			"completed",
			expect.objectContaining({
				result: expect.objectContaining({
					success: true,
					stackName: "tc-team01",
					stackId: "arn:aws:cloudformation:...",
				}),
			}),
		);
	});

	it("failed イベントで job を failed に errorReason 付きで更新すべき", async () => {
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-TenkaCloud-Internal-Token": "test-token",
			},
			body: JSON.stringify({
				"detail-type": "problem.deploy.failed",
				detail: {
					deploymentKey: "event-1:problem-1:job-1",
					jobOutput: { deployStatus: "failed" },
				},
			}),
		});

		expect(res.status).toBe(200);
		expect(mockUpdateStatus).toHaveBeenCalledWith(
			"event-1",
			"problem-1",
			"job-1",
			"failed",
			expect.objectContaining({
				error: expect.any(String),
			}),
		);
	});

	it("不正な deploymentKey は 400 を返すべき", async () => {
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-TenkaCloud-Internal-Token": "test-token",
			},
			body: JSON.stringify({
				"detail-type": "problem.deploy.completed",
				detail: {
					deploymentKey: "invalid-key",
					jobOutput: { tenantData: { deployStatus: "completed" } },
				},
			}),
		});

		expect(res.status).toBe(400);
		expect(mockUpdateStatus).not.toHaveBeenCalled();
	});

	it("production で INTERNAL_EVENT_TOKEN 未設定なら 401 を返すべき", async () => {
		delete process.env.INTERNAL_EVENT_TOKEN;
		process.env.NODE_ENV = "production";
		const app = await getApp();

		const res = await app.request("/api/internal/deploy-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				"detail-type": "problem.deploy.completed",
				detail: {
					deploymentKey: "event-1:problem-1:job-1",
					jobOutput: { tenantData: { deployStatus: "completed" } },
				},
			}),
		});

		expect(res.status).toBe(401);
		expect(mockUpdateStatus).not.toHaveBeenCalled();
	});
});
