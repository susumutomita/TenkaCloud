import { describe, it, expect, vi, beforeEach } from "vitest";
import { StatusCodes } from "http-status-codes";
import { Hono } from "hono";

// jose をモックして JWT 検証を制御
vi.mock("jose", () => ({
	createRemoteJWKSet: vi.fn(() => vi.fn()),
	jwtVerify: vi.fn(),
	errors: {
		JWTExpired: class JWTExpired extends Error {
			constructor() {
				super("JWT expired");
				this.name = "JWTExpired";
			}
		},
		JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {
			constructor() {
				super("JWT claim validation failed");
				this.name = "JWTClaimValidationFailed";
			}
		},
	},
}));

describe("authMiddleware", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		delete process.env.AUTH_SKIP;
		delete process.env.JWKS_URI;
		delete process.env.JWT_ISSUER;
		delete process.env.JWT_AUDIENCE;
	});

	describe("AUTH_SKIP モード", () => {
		it("AUTH_SKIP モードで JWT 検証をバイパスしてモック認証コンテキストを設定すべき", async () => {
			process.env.AUTH_SKIP = "1";

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json(c.get("auth")));

			const res = await app.request("/test");
			expect(res.status).toBe(StatusCodes.OK);

			const body = await res.json();
			expect(body.userId).toBe("dev-user");
			expect(body.tenantId).toBe("dev-tenant");
			expect(body.roles).toEqual(["admin", "participant"]);
		});

		it("AUTH_SKIP モードで Authorization ヘッダーなしでもアクセスできるべき", async () => {
			process.env.AUTH_SKIP = "1";

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			// No Authorization header
			const res = await app.request("/test");
			expect(res.status).toBe(StatusCodes.OK);
		});
	});

	describe("AUTH_SKIP 無効", () => {
		it("AUTH_SKIP が無効の場合は通常の JWT 検証を行うべき", async () => {
			// AUTH_SKIP is not set (disabled)
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockResolvedValue({
				payload: {
					sub: "user-123",
					tenant_id: "tenant-abc",
					realm_access: { roles: ["participant"] },
					iss: "http://localhost:8080/realms/tenkacloud",
					aud: "",
					iat: 0,
					exp: 0,
				},
				protectedHeader: { alg: "RS256" },
				key: {} as CryptoKey,
			});

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json(c.get("auth")));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer valid-token" },
			});
			expect(res.status).toBe(StatusCodes.OK);

			const body = await res.json();
			expect(body.userId).toBe("user-123");
			expect(body.tenantId).toBe("tenant-abc");
			expect(body.roles).toEqual(["participant"]);
		});

		it("Authorization ヘッダーがない場合は UNAUTHORIZED を返すべき", async () => {
			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(StatusCodes.UNAUTHORIZED);

			const body = await res.json();
			expect(body.error).toBe("認証が必要です");
		});

		it("Bearer プレフィックスがない場合は UNAUTHORIZED を返すべき", async () => {
			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "Basic invalid" },
			});
			expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
		});

		it("トークンに sub がない場合は UNAUTHORIZED を返すべき", async () => {
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockResolvedValue({
				payload: {
					tenant_id: "tenant-abc",
					iss: "",
					aud: "",
					iat: 0,
					exp: 0,
				},
				protectedHeader: { alg: "RS256" },
				key: {} as CryptoKey,
			});

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer token-without-sub" },
			});
			expect(res.status).toBe(StatusCodes.UNAUTHORIZED);

			const body = await res.json();
			expect(body.error).toBe("トークンに sub がありません");
		});

		it("テナント情報がない場合は FORBIDDEN を返すべき", async () => {
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockResolvedValue({
				payload: {
					sub: "user-123",
					iss: "",
					aud: "",
					iat: 0,
					exp: 0,
				},
				protectedHeader: { alg: "RS256" },
				key: {} as CryptoKey,
			});

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer token-without-tenant" },
			});
			expect(res.status).toBe(StatusCodes.FORBIDDEN);

			const body = await res.json();
			expect(body.error).toBe("テナント情報がありません");
		});

		it("トークンの有効期限が切れている場合は UNAUTHORIZED を返すべき", async () => {
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockRejectedValue(
				new jose.errors.JWTExpired("JWT expired", {}),
			);

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer expired-token" },
			});
			expect(res.status).toBe(StatusCodes.UNAUTHORIZED);

			const body = await res.json();
			expect(body.error).toBe("トークンの有効期限が切れています");
		});

		it("トークンの検証に失敗した場合は UNAUTHORIZED を返すべき", async () => {
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockRejectedValue(
				new jose.errors.JWTClaimValidationFailed(
					"JWT claim validation failed",
					{},
				),
			);

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer invalid-claims" },
			});
			expect(res.status).toBe(StatusCodes.UNAUTHORIZED);

			const body = await res.json();
			expect(body.error).toBe("トークンの検証に失敗しました");
		});

		it("その他のエラーの場合は汎用認証エラーを返すべき", async () => {
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockRejectedValue(new Error("Network error"));

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer some-token" },
			});
			expect(res.status).toBe(StatusCodes.UNAUTHORIZED);

			const body = await res.json();
			expect(body.error).toBe("認証に失敗しました");
		});

		it("JWT_AUDIENCE が設定されている場合は audience を検証すべき", async () => {
			process.env.JWT_AUDIENCE = "my-api";
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockResolvedValue({
				payload: {
					sub: "user-123",
					tenant_id: "tenant-abc",
					realm_access: { roles: ["admin"] },
					iss: "",
					aud: "my-api",
					iat: 0,
					exp: 0,
				},
				protectedHeader: { alg: "RS256" },
				key: {} as CryptoKey,
			});

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json(c.get("auth")));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer valid-token" },
			});
			expect(res.status).toBe(StatusCodes.OK);

			// Verify jwtVerify was called with audience option
			expect(jose.jwtVerify).toHaveBeenCalledWith(
				"valid-token",
				expect.any(Function),
				expect.objectContaining({ audience: "my-api" }),
			);
		});

		it("realm_access がない場合は空のロール配列を設定すべき", async () => {
			const jose = await import("jose");
			vi.mocked(jose.jwtVerify).mockResolvedValue({
				payload: {
					sub: "user-123",
					tenant_id: "tenant-abc",
					iss: "",
					aud: "",
					iat: 0,
					exp: 0,
				},
				protectedHeader: { alg: "RS256" },
				key: {} as CryptoKey,
			});

			const { authMiddleware } = await import("./auth");

			const app = new Hono();
			app.use("/*", authMiddleware);
			app.get("/test", (c) => c.json(c.get("auth")));

			const res = await app.request("/test", {
				headers: { Authorization: "Bearer valid-token" },
			});
			expect(res.status).toBe(StatusCodes.OK);

			const body = await res.json();
			expect(body.roles).toEqual([]);
		});
	});
});
