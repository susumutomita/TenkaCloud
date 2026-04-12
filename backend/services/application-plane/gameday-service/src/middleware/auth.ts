import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import * as jose from "jose";

export interface AuthContext {
	userId: string;
	tenantId: string;
	roles: string[];
}

const DEV_USER_ID_HEADER = "x-tenkacloud-dev-user-id";
const DEV_TENANT_ID_HEADER = "x-tenkacloud-dev-tenant-id";
const DEV_ROLES_HEADER = "x-tenkacloud-dev-roles";

function sanitizeDevIdentity(
	value: string | undefined,
	fallback: string,
	maxLength = 128,
): string {
	if (!value) {
		return fallback;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return fallback;
	}

	const sanitized = trimmed
		.replace(/[^A-Za-z0-9@._:/+=,-]/g, "-")
		.slice(0, maxLength);

	return sanitized || fallback;
}

declare module "hono" {
	interface ContextVariableMap {
		auth: AuthContext;
	}
}

/* v8 ignore start -- Production safety guard */
if (process.env.AUTH_SKIP === "1" && process.env.NODE_ENV === "production") {
	throw new Error("AUTH_SKIP cannot be enabled in production");
}
/* v8 ignore stop */

const authSkipEnabled =
	process.env.AUTH_SKIP === "1" &&
	process.env.NODE_ENV !== "production";

function parseAuthSkipRoles(envValue?: string): string[] {
	if (!envValue) {
		return ["participant"];
	}

	const roles = envValue
		.split(",")
		.map((role) => role.trim())
		.filter(Boolean);

	return roles.length > 0 ? roles : ["participant"];
}

/* v8 ignore start -- Development-only warning */
if (authSkipEnabled && typeof console !== "undefined") {
	console.warn(
		"\x1b[33m⚠️  AUTH_SKIP mode is enabled. JWT verification is bypassed.\x1b[0m",
	);
	console.warn(
		"\x1b[33m   This should only be used for local development.\x1b[0m",
	);
}
/* v8 ignore stop */

function createMockAuth(
	headers?: {
		[DEV_USER_ID_HEADER]?: string;
		[DEV_TENANT_ID_HEADER]?: string;
		[DEV_ROLES_HEADER]?: string;
	},
): AuthContext {
	return {
		userId: sanitizeDevIdentity(headers?.[DEV_USER_ID_HEADER], "dev-user"),
		tenantId: sanitizeDevIdentity(
			headers?.[DEV_TENANT_ID_HEADER],
			"dev-tenant",
		),
		roles: parseAuthSkipRoles(
			headers?.[DEV_ROLES_HEADER] ?? process.env.AUTH_SKIP_ROLES,
		),
	};
}

const JWKS_URI =
	process.env.JWKS_URI ??
	"http://localhost:8080/realms/tenkacloud/protocol/openid-connect/certs";
const ISSUER =
	process.env.JWT_ISSUER ?? "http://localhost:8080/realms/tenkacloud";

let jwks: jose.JWTVerifyGetKey | null = null;

async function getJWKS() {
	if (!jwks) {
		jwks = jose.createRemoteJWKSet(new URL(JWKS_URI));
	}
	return jwks;
}

export const authMiddleware = createMiddleware(async (c, next) => {
	// AUTH_SKIP=1: 開発用にJWT検証をバイパス
	if (authSkipEnabled) {
		c.set(
			"auth",
			createMockAuth({
				"x-tenkacloud-dev-user-id": c.req.header("X-TenkaCloud-Dev-User-Id"),
				"x-tenkacloud-dev-tenant-id": c.req.header(
					"X-TenkaCloud-Dev-Tenant-Id",
				),
				"x-tenkacloud-dev-roles": c.req.header("X-TenkaCloud-Dev-Roles"),
			}),
		);
		await next();
		return;
	}

	const authHeader = c.req.header("Authorization");

	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "認証が必要です" }, StatusCodes.UNAUTHORIZED);
	}

	const token = authHeader.slice(7);

	try {
		const jwksSet = await getJWKS();
		const verifyOptions: jose.JWTVerifyOptions = {
			issuer: ISSUER,
		};
		if (process.env.JWT_AUDIENCE) {
			verifyOptions.audience = process.env.JWT_AUDIENCE;
		}
		const { payload } = await jose.jwtVerify(token, jwksSet, verifyOptions);

		if (!payload.sub) {
			return c.json(
				{ error: "トークンに sub がありません" },
				StatusCodes.UNAUTHORIZED,
			);
		}

		const tenantId = (payload as Record<string, unknown>)["tenant_id"] as
			| string
			| undefined;
		if (!tenantId) {
			return c.json(
				{ error: "テナント情報がありません" },
				StatusCodes.FORBIDDEN,
			);
		}

		c.set("auth", {
			userId: payload.sub,
			tenantId,
			roles:
				(
					(payload as Record<string, unknown>)["realm_access"] as {
						roles?: string[];
					}
				)?.roles ?? [],
		});

		await next();
	} catch (error) {
		if (error instanceof jose.errors.JWTExpired) {
			return c.json(
				{ error: "トークンの有効期限が切れています" },
				StatusCodes.UNAUTHORIZED,
			);
		}
		if (error instanceof jose.errors.JWTClaimValidationFailed) {
			return c.json(
				{ error: "トークンの検証に失敗しました" },
				StatusCodes.UNAUTHORIZED,
			);
		}
		return c.json({ error: "認証に失敗しました" }, StatusCodes.UNAUTHORIZED);
	}
});

export const requireAdmin = createMiddleware(async (c, next) => {
	const auth = c.get("auth");
	if (
		!auth.roles.includes("admin") &&
		!auth.roles.includes("platform-admin") &&
		!auth.roles.includes("tenant-admin") &&
		!auth.roles.includes("organizer")
	) {
		return c.json({ error: "管理者権限が必要です" }, StatusCodes.FORBIDDEN);
	}
	await next();
});
