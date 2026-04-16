import { createMiddleware } from "hono/factory";
import * as jose from "jose";
import { z } from "zod";

export interface AuthContext {
	userId: string;
	tenantId: string;
	roles: string[];
}

declare module "hono" {
	interface ContextVariableMap {
		auth: AuthContext;
	}
}

const JWKS_URI =
	process.env.JWKS_URI ??
	"http://localhost:8080/realms/tenkacloud/protocol/openid-connect/certs";
const ISSUER =
	process.env.JWT_ISSUER ?? "http://localhost:8080/realms/tenkacloud";

const JwtClaimsSchema = z.object({
	sub: z.string().optional(),
	"custom:tenant_id": z.string().min(1).optional(),
	tenant_id: z.string().min(1).optional(),
	"cognito:groups": z.array(z.string()).min(1).optional(),
	realm_access: z.object({ roles: z.array(z.string()) }).optional(),
}).passthrough();

let jwks: jose.JWTVerifyGetKey | null = null;

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

async function getJWKS() {
	if (!jwks) {
		jwks = jose.createRemoteJWKSet(new URL(JWKS_URI));
	}
	return jwks;
}

/* v8 ignore start -- Production safety guard */
if (process.env.AUTH_SKIP === "1" && process.env.NODE_ENV === "production") {
	throw new Error("AUTH_SKIP cannot be enabled in production");
}
/* v8 ignore stop */

const authSkipEnabled =
	process.env.AUTH_SKIP === "1" && process.env.NODE_ENV !== "production";

export const authMiddleware = createMiddleware(async (c, next) => {
	if (authSkipEnabled) {
		c.set("auth", {
			userId: "dev-user",
			tenantId: "dev-tenant",
			roles: parseAuthSkipRoles(process.env.AUTH_SKIP_ROLES),
		});
		return next();
	}

	const authHeader = c.req.header("Authorization");

	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "認証が必要です" }, 401);
	}

	const token = authHeader.slice(7);

	try {
		const jwksSet = await getJWKS();
		const { payload } = await jose.jwtVerify(token, jwksSet, {
			issuer: ISSUER,
		});

		const parsed = JwtClaimsSchema.safeParse(payload);
		const claims = parsed.success ? parsed.data : (payload as Record<string, unknown>);

		const tenantId =
			(claims["custom:tenant_id"] as string | undefined) ||
			(claims["tenant_id"] as string | undefined);
		if (!tenantId) {
			return c.json({ error: "テナント情報がありません" }, 403);
		}

		const cognitoGroups = claims["cognito:groups"] as string[] | undefined;
		const keycloakRoles = (claims["realm_access"] as { roles?: string[] } | undefined)?.roles;

		c.set("auth", {
			userId: (payload.sub as string) ?? "",
			tenantId,
			roles:
				(cognitoGroups && cognitoGroups.length > 0 ? cognitoGroups : undefined) ??
				(keycloakRoles && keycloakRoles.length > 0 ? keycloakRoles : undefined) ??
				[],
		});

		await next();
	} catch (error) {
		if (error instanceof jose.errors.JWTExpired) {
			return c.json({ error: "トークンの有効期限が切れています" }, 401);
		}
		if (error instanceof jose.errors.JWTClaimValidationFailed) {
			return c.json({ error: "トークンの検証に失敗しました" }, 401);
		}
		return c.json({ error: "認証に失敗しました" }, 401);
	}
});
