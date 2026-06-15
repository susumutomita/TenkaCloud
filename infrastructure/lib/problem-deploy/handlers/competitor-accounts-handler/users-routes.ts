import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  type AttributeType,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import {
  extractClaims,
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
  TENANT_VIEWER_ROLE,
  type TenantRole,
} from "../deploy-handler/auth.js";
import { extractAuditContext, writeAuditEvent } from "../shared/audit-log.js";
import { extractUserPoolIdFromIss } from "./cognito-saml.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";

const USER_LIST_LIMIT = 60;
const MAX_LISTED_USERS = 500;
const TENANT_USER_ROLES = [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE, TENANT_VIEWER_ROLE] as const;

export const InviteUserRequestSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(TENANT_USER_ROLES).default(TENANT_VIEWER_ROLE),
});

export const ChangeRoleRequestSchema = z.object({
  role: z.enum(TENANT_USER_ROLES),
});

export interface TenantUserView {
  readonly username: string;
  readonly email?: string;
  readonly role?: TenantRole;
  readonly enabled: boolean;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface UsersRouteResult {
  readonly status: number;
  readonly body: unknown;
}

export interface UsersOrchestratorDeps {
  readonly shared: CompetitorAccountsSharedResources;
}

interface JwtClaims {
  readonly iss?: string;
  readonly [k: string]: unknown;
}

function attributeRecord(attributes: readonly AttributeType[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of attributes ?? []) {
    if (attr.Name && attr.Value !== undefined) out[attr.Name] = attr.Value;
  }
  return out;
}

function isTenantRole(value: string | undefined): value is TenantRole {
  return TENANT_USER_ROLES.includes(value as TenantRole);
}

function toIso(value: Date | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function userToView(user: UserType): TenantUserView {
  const attrs = attributeRecord(user.Attributes);
  return {
    username: user.Username ?? attrs.email ?? "",
    email: attrs.email,
    role: isTenantRole(attrs["custom:userRole"]) ? attrs["custom:userRole"] : undefined,
    enabled: user.Enabled === true,
    status: user.UserStatus,
    createdAt: toIso(user.UserCreateDate),
    updatedAt: toIso(user.UserLastModifiedDate),
  };
}

function resolvedUserToView(
  username: string,
  attributes: readonly AttributeType[] | undefined,
  enabled: boolean | undefined,
  status: string | undefined,
  createdAt?: Date,
  updatedAt?: Date,
): TenantUserView {
  const attrs = attributeRecord(attributes);
  return {
    username,
    email: attrs.email,
    role: isTenantRole(attrs["custom:userRole"]) ? attrs["custom:userRole"] : undefined,
    enabled: enabled === true,
    status,
    createdAt: toIso(createdAt),
    updatedAt: toIso(updatedAt),
  };
}

function resolveCallerUserPoolId(c: Context): string | undefined {
  const claims = extractClaims(c) as JwtClaims | undefined;
  const fromIssuer = extractUserPoolIdFromIss(claims?.iss);
  if (fromIssuer) return fromIssuer;
  const fromEnv = process.env.DEFAULT_USER_POOL_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function missingCognitoContext(): UsersRouteResult {
  return {
    status: StatusCodes.UNPROCESSABLE_ENTITY,
    body: { error: "missing_cognito_claims", message: "iss claim is required" },
  };
}

async function readJson(c: Context): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function isNamedAwsError(err: unknown, names: readonly string[]): boolean {
  return err instanceof Error && names.includes(err.name);
}

function isTenantScoped(
  user: {
    readonly UserAttributes?: readonly AttributeType[];
    readonly Attributes?: readonly AttributeType[];
  },
  tenantId: string,
): boolean {
  const attrs = attributeRecord(user.UserAttributes ?? user.Attributes);
  return attrs["custom:tenantId"] === tenantId;
}

function auditBase(
  c: Context,
  tenantId: string,
): ReturnType<typeof extractAuditContext> & {
  readonly tenantId: string;
} {
  return { tenantId, ...extractAuditContext(c) };
}

function writeUserAudit(
  audit: ReturnType<typeof auditBase>,
  action: string,
  outcome: "success" | "not_found" | "conflict" | "error",
  target: string | undefined,
  extra?: Readonly<Record<string, string>>,
): void {
  void writeAuditEvent({
    tenantId: audit.tenantId,
    actor: audit.actor,
    actorUsername: audit.actorUsername,
    action,
    outcome,
    target,
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
    occurredAtMs: Date.now(),
    extra,
  });
}

async function getTenantUser(
  shared: CompetitorAccountsSharedResources,
  userPoolId: string,
  tenantId: string,
  username: string,
): Promise<
  | {
      readonly found: true;
      readonly subject?: string;
      readonly view: TenantUserView;
      readonly tenantScoped: boolean;
    }
  | { readonly found: false }
> {
  try {
    const user = await shared.cognito.send(
      new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
    const attrs = attributeRecord(user.UserAttributes);
    const tenantScoped = attrs["custom:tenantId"] === tenantId;
    return {
      found: true,
      subject: attrs.sub,
      tenantScoped,
      view: resolvedUserToView(
        username,
        user.UserAttributes,
        user.Enabled,
        user.UserStatus,
        user.UserCreateDate,
        user.UserLastModifiedDate,
      ),
    };
  } catch (err) {
    if (isNamedAwsError(err, ["UserNotFoundException", "ResourceNotFoundException"])) {
      return { found: false };
    }
    throw err;
  }
}

export async function routeListUsers(
  deps: UsersOrchestratorDeps,
  c: Context,
): Promise<UsersRouteResult> {
  const tenantId = resolveTenantId(c);
  const userPoolId = resolveCallerUserPoolId(c);
  if (!userPoolId) return missingCognitoContext();

  const items: TenantUserView[] = [];
  let paginationToken: string | undefined;
  do {
    const response = await deps.shared.cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: USER_LIST_LIMIT,
        PaginationToken: paginationToken,
      }),
    );
    for (const user of response.Users ?? []) {
      if (!isTenantScoped(user, tenantId)) continue;
      items.push(userToView(user));
      if (items.length >= MAX_LISTED_USERS) break;
    }
    paginationToken = response.PaginationToken;
  } while (paginationToken && items.length < MAX_LISTED_USERS);

  items.sort((a, b) => (a.email ?? a.username).localeCompare(b.email ?? b.username));
  return { status: StatusCodes.OK, body: { items } };
}

export async function routeCreateUser(
  deps: UsersOrchestratorDeps,
  c: Context,
): Promise<UsersRouteResult> {
  const tenantId = resolveTenantId(c);
  const userPoolId = resolveCallerUserPoolId(c);
  if (!userPoolId) return missingCognitoContext();

  const body = await readJson(c);
  if (body === undefined)
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_body" } };
  const parsed = InviteUserRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: StatusCodes.BAD_REQUEST,
      body: { error: "validation_failed", issues: parsed.error.issues },
    };
  }

  const audit = auditBase(c, tenantId);
  const actorSub = resolveCognitoSub(c);
  try {
    const response = await deps.shared.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: parsed.data.email,
        DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [
          { Name: "email", Value: parsed.data.email },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:tenantId", Value: tenantId },
          { Name: "custom:userRole", Value: parsed.data.role },
        ],
        ClientMetadata: {
          invitedBy: actorSub,
          tenantId,
        },
      }),
    );
    writeUserAudit(audit, "invite_user", "success", parsed.data.email, {
      role: parsed.data.role,
    });
    return {
      status: StatusCodes.CREATED,
      body: {
        item: response.User
          ? userToView(response.User)
          : resolvedUserToView(
              parsed.data.email,
              [
                { Name: "email", Value: parsed.data.email },
                { Name: "custom:tenantId", Value: tenantId },
                { Name: "custom:userRole", Value: parsed.data.role },
              ],
              true,
              "FORCE_CHANGE_PASSWORD",
            ),
      },
    };
  } catch (err) {
    if (isNamedAwsError(err, ["UsernameExistsException"])) {
      writeUserAudit(audit, "invite_user", "conflict", parsed.data.email);
      return {
        status: StatusCodes.CONFLICT,
        body: { error: "duplicate_user", email: parsed.data.email },
      };
    }
    writeUserAudit(audit, "invite_user", "error", parsed.data.email);
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[tenant-users] invite failed", { message });
    return { status: StatusCodes.INTERNAL_SERVER_ERROR, body: { error: "internal_error" } };
  }
}

export async function routeDeleteUser(
  deps: UsersOrchestratorDeps,
  c: Context,
): Promise<UsersRouteResult> {
  const tenantId = resolveTenantId(c);
  const userPoolId = resolveCallerUserPoolId(c);
  if (!userPoolId) return missingCognitoContext();
  const username = c.req.param("username");
  if (!username) return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_username" } };
  const audit = auditBase(c, tenantId);

  try {
    const existing = await getTenantUser(deps.shared, userPoolId, tenantId, username);
    if (!existing.found || !existing.tenantScoped) {
      writeUserAudit(audit, "delete_user", "not_found", username);
      return { status: StatusCodes.NOT_FOUND, body: { error: "not_found" } };
    }
    const actorSub = resolveCognitoSub(c);
    if (actorSub !== "unknown" && (existing.subject === actorSub || username === actorSub)) {
      writeUserAudit(audit, "delete_user", "conflict", username);
      return { status: StatusCodes.CONFLICT, body: { error: "cannot_delete_self" } };
    }
    await deps.shared.cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
    writeUserAudit(audit, "delete_user", "success", username);
    return { status: StatusCodes.OK, body: { deleted: true } };
  } catch (err) {
    writeUserAudit(audit, "delete_user", "error", username);
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[tenant-users] delete failed", { username, message });
    return { status: StatusCodes.INTERNAL_SERVER_ERROR, body: { error: "internal_error" } };
  }
}

export async function routeChangeUserRole(
  deps: UsersOrchestratorDeps,
  c: Context,
): Promise<UsersRouteResult> {
  const tenantId = resolveTenantId(c);
  const userPoolId = resolveCallerUserPoolId(c);
  if (!userPoolId) return missingCognitoContext();
  const username = c.req.param("username");
  if (!username) return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_username" } };

  const body = await readJson(c);
  if (body === undefined)
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_body" } };
  const parsed = ChangeRoleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: StatusCodes.BAD_REQUEST,
      body: { error: "validation_failed", issues: parsed.error.issues },
    };
  }

  const audit = auditBase(c, tenantId);
  try {
    const existing = await getTenantUser(deps.shared, userPoolId, tenantId, username);
    if (!existing.found || !existing.tenantScoped) {
      writeUserAudit(audit, "patch_user_role", "not_found", username);
      return { status: StatusCodes.NOT_FOUND, body: { error: "not_found" } };
    }
    const actorSub = resolveCognitoSub(c);
    if (actorSub !== "unknown" && (existing.subject === actorSub || username === actorSub)) {
      writeUserAudit(audit, "patch_user_role", "conflict", username);
      return { status: StatusCodes.CONFLICT, body: { error: "cannot_change_own_role" } };
    }
    await deps.shared.cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: [{ Name: "custom:userRole", Value: parsed.data.role }],
      }),
    );
    const updated: TenantUserView = {
      ...existing.view,
      role: parsed.data.role,
      updatedAt: new Date().toISOString(),
    };
    writeUserAudit(audit, "patch_user_role", "success", username, {
      role: parsed.data.role,
    });
    return { status: StatusCodes.OK, body: { item: updated } };
  } catch (err) {
    writeUserAudit(audit, "patch_user_role", "error", username);
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[tenant-users] patch role failed", { username, message });
    return { status: StatusCodes.INTERNAL_SERVER_ERROR, body: { error: "internal_error" } };
  }
}
