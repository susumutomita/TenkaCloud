/**
 * Admin GameDay Deploy: competitor-account registration guardrails.
 * Regression coverage for the event-existence + type check added after review.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const { mockFindEventById, mockCreateAccount } = vi.hoisted(() => ({
	mockFindEventById: vi.fn(),
	mockCreateAccount: vi.fn(),
}));

vi.mock("../repositories", () => ({
	PrismaEventRepository: class {
		findById = mockFindEventById;
	},
	PrismaProblemRepository: class {},
	PrismaMarketplaceRepository: class {},
	PrismaProblemTemplateRepository: class {},
}));

vi.mock("../repositories/competitor-account-repository", () => ({
	CompetitorAccountRepository: class {
		create = mockCreateAccount;
		findByEventId = vi.fn();
		delete = vi.fn();
	},
}));

vi.mock("../repositories/gameday-deployment-job-repository", () => ({
	GameDayDeploymentJobRepository: class {
		findByEventAndProblem = vi.fn();
	},
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

async function getApp() {
	const { gamedayDeployRoutes } = await import(
		"../routes/admin-gameday-deploy"
	);
	const app = new Hono();
	app.route("/", gamedayDeployRoutes);
	return app;
}

function validBody() {
	return {
		name: "team-1",
		provider: "aws" as const,
		accountId: "123456789012",
		region: "ap-northeast-1",
		roleArn: "arn:aws:iam::123456789012:role/R",
	};
}

describe("POST /events/:eventId/competitor-accounts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("存在しない event に対しては 404 を返すべき", async () => {
		mockFindEventById.mockResolvedValueOnce(null);
		const app = await getApp();

		const res = await app.request("/events/nope/competitor-accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});

		expect(res.status).toBe(404);
		expect(mockCreateAccount).not.toHaveBeenCalled();
	});

	it("gameday 以外の event に対しては 400 を返すべき", async () => {
		mockFindEventById.mockResolvedValueOnce({ id: "e1", type: "jam" });
		const app = await getApp();

		const res = await app.request("/events/e1/competitor-accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});

		expect(res.status).toBe(400);
		expect(mockCreateAccount).not.toHaveBeenCalled();
	});

	it("gameday event に対してはアカウントを作成すべき", async () => {
		mockFindEventById.mockResolvedValueOnce({ id: "e1", type: "gameday" });
		mockCreateAccount.mockResolvedValueOnce({ id: "acc-1" });
		const app = await getApp();

		const res = await app.request("/events/e1/competitor-accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});

		expect(res.status).toBe(201);
		expect(mockCreateAccount).toHaveBeenCalledOnce();
	});
});
