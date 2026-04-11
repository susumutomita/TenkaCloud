/**
 * Auth Module Tests
 *
 * AUTH_SKIP ガード、モックユーザー、認証リクエストのテスト
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("auth モジュール", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...originalEnv };
		delete process.env.AUTH_SKIP_ROLES;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("AUTH_SKIP ガード", () => {
		it("NODE_ENV=production で AUTH_SKIP=1 の場合エラーをスローすべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "production";

			await expect(import("../auth")).rejects.toThrow(
				"AUTH_SKIP cannot be enabled in production",
			);
		});

		it("NODE_ENV=development で AUTH_SKIP=1 の場合はエラーにならないべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const mod = await import("../auth");
			expect(mod.authenticateRequest).toBeDefined();
		});

		it("NODE_ENV=test で AUTH_SKIP=1 の場合はエラーにならないべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "test";

			const mod = await import("../auth");
			expect(mod.authenticateRequest).toBeDefined();
		});

		it("NODE_ENV が未設定で AUTH_SKIP=1 の場合はローカル開発としてバイパスすべき", async () => {
			process.env.AUTH_SKIP = "1";
			delete process.env.NODE_ENV;

			const mod = await import("../auth");
			const result = await mod.authenticateRequest({});
			expect(result.isValid).toBe(true);
			expect(result.user?.id).toBe("dev-user");
			expect(result.token).toBe("mock-access-token");
		});
	});

	describe("authenticateRequest - AUTH_SKIP モード", () => {
		it("AUTH_SKIP=1 かつ development ではモックユーザーを返すべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({});

			expect(result.isValid).toBe(true);
			expect(result.user).not.toBeNull();
			expect(result.user!.id).toBe("dev-user");
			expect(result.user!.email).toBe("dev@localhost");
			expect(result.user!.roles).toEqual(["competitor"]);
			expect(result.token).toBe("mock-access-token");
		});

		it("各リクエストで異なるモックユーザーオブジェクトを返すべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result1 = await authenticateRequest({});
			const result2 = await authenticateRequest({});

			expect(result1.user).not.toBe(result2.user);
			expect(result1.user).toEqual(result2.user);
		});

		it("AUTH_SKIP_ROLES が指定された場合はそのロールを使うべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.AUTH_SKIP_ROLES = "platform-admin,competitor";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({});

			expect(result.user?.roles).toEqual(["platform-admin", "competitor"]);
		});
	});

	describe("authenticateRequest - 通常モード", () => {
		it("AUTH_SKIP=0 では mock-access-token を拒否すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({
				authorization: "Bearer mock-access-token",
			});

			expect(result.isValid).toBe(false);
		});

		it("AUTH_SKIP=0 では authorizationtoken ヘッダーの mock-access-token も拒否すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({
				authorizationtoken: "mock-access-token",
			});

			expect(result.isValid).toBe(false);
		});

		it("NODE_ENV 未設定かつ AUTH_SKIP=0 では mock-access-token を拒否すべき", async () => {
			process.env.AUTH_SKIP = "0";
			delete process.env.NODE_ENV;

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({
				authorization: "Bearer mock-access-token",
			});

			expect(result.isValid).toBe(false);
		});

		it("Authorization ヘッダーがない場合は認証失敗を返すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({});

			expect(result.isValid).toBe(false);
			expect(result.user).toBeNull();
			expect(result.error).toBe("No authorization token provided");
		});

		it("無効なトークンの場合は認証失敗を返すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({
				authorization: "Bearer invalid-token",
			});

			expect(result.isValid).toBe(false);
			expect(result.error).toBe("Invalid token");
		});
	});

	describe("ロールチェック", () => {
		it("hasRole はユーザーが指定ロールを持つ場合 true を返すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { hasRole, UserRole } = await import("../auth");
			const user = {
				id: "test",
				email: "test@test.com",
				username: "test",
				roles: [UserRole.PLATFORM_ADMIN],
			};

			expect(hasRole(user, UserRole.PLATFORM_ADMIN)).toBe(true);
			expect(hasRole(user, UserRole.COMPETITOR)).toBe(false);
		});

		it("hasAnyRole は指定ロールのいずれかを持つ場合 true を返すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { hasAnyRole, UserRole } = await import("../auth");
			const user = {
				id: "test",
				email: "test@test.com",
				username: "test",
				roles: [UserRole.COMPETITOR],
			};

			expect(
				hasAnyRole(user, [UserRole.PLATFORM_ADMIN, UserRole.COMPETITOR]),
			).toBe(true);
			expect(
				hasAnyRole(user, [UserRole.PLATFORM_ADMIN, UserRole.ORGANIZER]),
			).toBe(false);
		});
	});

	describe("canAccessTeam", () => {
		it("PLATFORM_ADMIN は任意のチームにアクセスできるべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { canAccessTeam, UserRole } = await import("../auth");
			const user = {
				id: "admin",
				email: "admin@test.com",
				username: "admin",
				roles: [UserRole.PLATFORM_ADMIN],
			};

			expect(canAccessTeam(user, "any-team-id")).toBe(true);
		});

		it("TENANT_ADMIN は任意のチームにアクセスできるべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { canAccessTeam, UserRole } = await import("../auth");
			const user = {
				id: "tenant-admin",
				email: "ta@test.com",
				username: "ta",
				roles: [UserRole.TENANT_ADMIN],
			};

			expect(canAccessTeam(user, "any-team-id")).toBe(true);
		});

		it("ORGANIZER は任意のチームにアクセスできるべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { canAccessTeam, UserRole } = await import("../auth");
			const user = {
				id: "org",
				email: "org@test.com",
				username: "org",
				roles: [UserRole.ORGANIZER],
			};

			expect(canAccessTeam(user, "any-team-id")).toBe(true);
		});

		it("COMPETITOR は自分のチームのみアクセスできるべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			const { canAccessTeam, UserRole } = await import("../auth");
			const user = {
				id: "comp",
				email: "comp@test.com",
				username: "comp",
				roles: [UserRole.COMPETITOR],
				teamId: "my-team",
			};

			expect(canAccessTeam(user, "my-team")).toBe(true);
			expect(canAccessTeam(user, "other-team")).toBe(false);
		});
	});
});
