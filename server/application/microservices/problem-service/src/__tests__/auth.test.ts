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
		it("AUTH_SKIP=1 かつ development では認証成功とモックユーザーを返すべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({});

			expect(result.isValid).toBe(true);
			expect(result.user).not.toBeNull();
		});

		it("AUTH_SKIP=1 かつ development ではモックユーザーの id と email が既定値であるべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({});

			expect(result.user!.id).toBe("dev-user");
			expect(result.user!.email).toBe("dev-user@localhost");
		});

		it("AUTH_SKIP=1 かつ development ではモックユーザーのロールとトークンが既定値であるべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({});

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

		it("開発用ヘッダーでユーザー ID とメールを上書きできるべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({
				"x-tenkacloud-dev-user-id": "tenant-admin@example.com",
				"x-tenkacloud-dev-tenant-id": "tenant-acme",
				"x-tenkacloud-dev-roles": "tenant-admin,participant",
			});

			expect(result.isValid).toBe(true);
			expect(result.user?.id).toBe("tenant-admin@example.com");
			expect(result.user?.email).toBe("tenant-admin@example.com");
		});

		it("開発用ヘッダーでテナント ID とロールを上書きできるべき", async () => {
			process.env.AUTH_SKIP = "1";
			process.env.NODE_ENV = "development";

			const { authenticateRequest } = await import("../auth");
			const result = await authenticateRequest({
				"x-tenkacloud-dev-user-id": "tenant-admin@example.com",
				"x-tenkacloud-dev-tenant-id": "tenant-acme",
				"x-tenkacloud-dev-roles": "tenant-admin,participant",
			});

			expect(result.user?.tenantId).toBe("tenant-acme");
			expect(result.user?.roles).toEqual(["tenant-admin", "participant"]);
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

	describe("verifyToken - Cognito クレーム抽出", () => {
		it("Cognito の custom:tenant_id からテナントIDを抽出すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "cognito-user-123",
						email: "user@example.com",
						preferred_username: "cognitouser",
						"custom:tenant_id": "tenant-from-cognito",
						"cognito:groups": ["organizer", "competitor"],
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-cognito-token");

			expect(user).not.toBeNull();
			expect(user!.tenantId).toBe("tenant-from-cognito");
		});

		it("Cognito の cognito:groups からロールを抽出すべき（複数グループ）", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "cognito-user-123",
						email: "user@example.com",
						preferred_username: "cognitouser",
						"custom:tenant_id": "tenant-from-cognito",
						"cognito:groups": ["organizer", "competitor"],
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-cognito-token");

			expect(user!.roles).toEqual(["organizer", "competitor"]);
		});

		it("Cognito クレームから sub, email, preferred_username を抽出すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "cognito-user-123",
						email: "user@example.com",
						preferred_username: "cognitouser",
						"custom:tenant_id": "tenant-from-cognito",
						"cognito:groups": ["organizer", "competitor"],
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-cognito-token");

			expect(user!.id).toBe("cognito-user-123");
			expect(user!.email).toBe("user@example.com");
			expect(user!.username).toBe("cognitouser");
		});

		it("Cognito の cognito:groups からロールを抽出すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "cognito-user-456",
						"cognito:groups": ["platform-admin"],
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-cognito-token");

			expect(user).not.toBeNull();
			expect(user!.roles).toEqual(["platform-admin"]);
		});

		it("Cognito クレームが Keycloak クレームより優先されるべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "dual-user",
						"custom:tenant_id": "cognito-tenant",
						tenantId: "keycloak-tenant",
						"cognito:groups": ["competitor"],
						realm_access: { roles: ["organizer"] },
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-token");

			expect(user).not.toBeNull();
			expect(user!.tenantId).toBe("cognito-tenant");
			expect(user!.roles).toEqual(["competitor"]);
		});

		it("Cognito クレームがない場合は Keycloak クレームにフォールバックすべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "keycloak-user",
						tenantId: "keycloak-tenant",
						realm_access: { roles: ["organizer", "tenant-admin"] },
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-keycloak-token");

			expect(user).not.toBeNull();
			expect(user!.tenantId).toBe("keycloak-tenant");
			expect(user!.roles).toEqual(["organizer", "tenant-admin"]);
		});

		it("両方のクレームがない場合は空ロールと undefined テナントを返すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";

			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: vi.fn().mockResolvedValue({
					payload: {
						sub: "minimal-user",
					},
				}),
			}));

			const { verifyToken } = await import("../auth");
			const user = await verifyToken("fake-token");

			expect(user).not.toBeNull();
			expect(user!.tenantId).toBeUndefined();
			expect(user!.roles).toEqual([]);
		});
	});

	describe("JWKS_URI / JWT_ISSUER 環境変数", () => {
		it("JWKS_URI が設定されている場合はその URL を使用すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";
			process.env.JWKS_URI = "https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id/.well-known/jwks.json";

			const mockCreateRemoteJWKSet = vi.fn(() => vi.fn());
			vi.doMock("jose", () => ({
				createRemoteJWKSet: mockCreateRemoteJWKSet,
				jwtVerify: vi.fn().mockResolvedValue({
					payload: { sub: "test-user" },
				}),
			}));

			const { verifyToken } = await import("../auth");
			await verifyToken("fake-token");

			expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
				new URL("https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id/.well-known/jwks.json"),
			);
		});

		it("JWT_ISSUER が設定されている場合はその issuer を使用すべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";
			process.env.JWT_ISSUER = "https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id";

			const mockJwtVerify = vi.fn().mockResolvedValue({
				payload: { sub: "test-user" },
			});
			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: mockJwtVerify,
			}));

			const { verifyToken } = await import("../auth");
			await verifyToken("fake-token");

			expect(mockJwtVerify).toHaveBeenCalledWith(
				"fake-token",
				expect.any(Function),
				{ issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id" },
			);
		});

		it("JWKS_URI が未設定の場合は Keycloak パターンにフォールバックすべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";
			delete process.env.JWKS_URI;
			process.env.KEYCLOAK_URL = "http://keycloak.local:8080";
			process.env.KEYCLOAK_REALM = "myrealm";

			const mockCreateRemoteJWKSet = vi.fn(() => vi.fn());
			vi.doMock("jose", () => ({
				createRemoteJWKSet: mockCreateRemoteJWKSet,
				jwtVerify: vi.fn().mockResolvedValue({
					payload: { sub: "test-user" },
				}),
			}));

			const { verifyToken } = await import("../auth");
			await verifyToken("fake-token");

			expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
				new URL("http://keycloak.local:8080/realms/myrealm/protocol/openid-connect/certs"),
			);
		});

		it("JWT_ISSUER が未設定の場合は Keycloak パターンにフォールバックすべき", async () => {
			process.env.AUTH_SKIP = "0";
			process.env.NODE_ENV = "test";
			delete process.env.JWT_ISSUER;
			process.env.KEYCLOAK_URL = "http://keycloak.local:8080";
			process.env.KEYCLOAK_REALM = "myrealm";

			const mockJwtVerify = vi.fn().mockResolvedValue({
				payload: { sub: "test-user" },
			});
			vi.doMock("jose", () => ({
				createRemoteJWKSet: vi.fn(() => vi.fn()),
				jwtVerify: mockJwtVerify,
			}));

			const { verifyToken } = await import("../auth");
			await verifyToken("fake-token");

			expect(mockJwtVerify).toHaveBeenCalledWith(
				"fake-token",
				expect.any(Function),
				{ issuer: "http://keycloak.local:8080/realms/myrealm" },
			);
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
