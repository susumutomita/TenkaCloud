import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  type CognitoIdentityProviderClient,
  DeliveryMediumType,
  ListUsersCommand,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Issue #925 Phase 1: Tenant Admin が画面から自 tenant の Cognito user を CRUD するための
 * SDK wrapper。 self-targeting (= UserPoolId は handler 側で JWT iss から runtime 抽出)
 * の pure-ish 関数群で書く。
 *
 *   listUsersByTenant: `custom:tenantId = <tenantId>` filter で ListUsers
 *   createUser:        AdminCreateUser (email 招待 + 属性 set)
 *   deleteUser:        AdminDeleteUser
 *
 * 競合動作:
 *   - email 重複 → `UsernameExistsException` を `DuplicateUserError` に正規化
 *   - 存在しない user の削除 → `UserNotFoundException` を `UserNotFoundError` に正規化
 *
 * tenant 越境防止:
 *   - create 時の `custom:tenantId` は JWT から取った値で server 側が上書きする (= caller から body で
 *     渡された tenantId を信頼しない)
 *   - delete 前に AdminGetUser で `custom:tenantId === <jwt tenantId>` を確認する責務は **caller 側** に
 *     持たせる (= 本 wrapper は AdminDelete を素直に呼ぶ pure 層)
 */

export interface CognitoUserClientDeps {
  readonly client: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
}

export interface CognitoUserSummary {
  readonly username: string;
  readonly email: string | undefined;
  readonly enabled: boolean;
  readonly status: string | undefined;
  readonly createdAt: string | undefined;
  readonly tenantId: string | undefined;
  readonly userRole: string | undefined;
}

export class DuplicateUserError extends Error {
  constructor(public readonly email: string) {
    super(`user with email ${email} already exists`);
    this.name = "DuplicateUserError";
  }
}

export class UserNotFoundError extends Error {
  constructor(public readonly username: string) {
    super(`user ${username} not found`);
    this.name = "UserNotFoundError";
  }
}

export class TenantMismatchError extends Error {
  constructor(
    public readonly expectedTenantId: string,
    public readonly actualTenantId: string | undefined,
  ) {
    super(`user belongs to tenant "${actualTenantId ?? "(none)"}" not "${expectedTenantId}"`);
    this.name = "TenantMismatchError";
  }
}

function pickAttr(
  attrs: ReadonlyArray<{ Name?: string; Value?: string }> | undefined,
  name: string,
): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

/**
 * tenant 内の全 user を返す。 Cognito の \`ListUsersCommand\` filter は \`attr = "value"\` 形式
 * のみ対応 (= prefix match の \`^=\` は string attr で、 custom: は完全一致 = だけ)。
 * 1 page = 60 件 (Cognito 上限) を超える tenant は paginate。 Phase 1 は 60 件まで暗黙仮定 (=
 * P0 は SPOF 解消が主目的、 paginate UI は follow-up)。
 */
export async function listUsersByTenant(
  deps: CognitoUserClientDeps,
  tenantId: string,
): Promise<CognitoUserSummary[]> {
  const out = await deps.client.send(
    new ListUsersCommand({
      UserPoolId: deps.userPoolId,
      Filter: `"custom:tenantId" = "${tenantId}"`,
      Limit: 60,
    }),
  );
  return (out.Users ?? []).map((u) => ({
    username: u.Username ?? "",
    email: pickAttr(u.Attributes, "email"),
    enabled: u.Enabled ?? false,
    status: u.UserStatus,
    createdAt: u.UserCreateDate?.toISOString(),
    tenantId: pickAttr(u.Attributes, "custom:tenantId"),
    userRole: pickAttr(u.Attributes, "custom:userRole"),
  }));
}

export interface CreateUserInput {
  readonly email: string;
  readonly tenantId: string;
  readonly userRole: string;
  readonly tenantName: string | undefined;
  readonly tenantTier: string | undefined;
}

export async function createUser(
  deps: CognitoUserClientDeps,
  input: CreateUserInput,
): Promise<CognitoUserSummary> {
  const attrs: { Name: string; Value: string }[] = [
    { Name: "email", Value: input.email },
    { Name: "email_verified", Value: "true" },
    { Name: "custom:tenantId", Value: input.tenantId },
    { Name: "custom:userRole", Value: input.userRole },
  ];
  if (input.tenantName) attrs.push({ Name: "custom:tenantName", Value: input.tenantName });
  if (input.tenantTier) attrs.push({ Name: "custom:tenantTier", Value: input.tenantTier });

  try {
    const out = await deps.client.send(
      new AdminCreateUserCommand({
        UserPoolId: deps.userPoolId,
        Username: input.email,
        UserAttributes: attrs,
        DesiredDeliveryMediums: [DeliveryMediumType.EMAIL],
      }),
    );
    const u = out.User;
    return {
      username: u?.Username ?? input.email,
      email: input.email,
      enabled: u?.Enabled ?? true,
      status: u?.UserStatus,
      createdAt: u?.UserCreateDate?.toISOString(),
      tenantId: input.tenantId,
      userRole: input.userRole,
    };
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new DuplicateUserError(input.email);
    }
    throw err;
  }
}

/**
 * username (= Cognito の primary key、 email 招待の場合は email 文字列が入る) で削除。
 * tenant 越境を防ぐため caller は事前に AdminGetUser で \`custom:tenantId\` 検証する。
 */
export async function deleteUser(deps: CognitoUserClientDeps, username: string): Promise<void> {
  try {
    await deps.client.send(
      new AdminDeleteUserCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) {
      throw new UserNotFoundError(username);
    }
    throw err;
  }
}

/**
 * tenant 越境 check: username が JWT tenantId と同じ tenant に属するかを確認する。
 * 不在なら \`UserNotFoundError\`、 別 tenant なら \`TenantMismatchError\`。
 */
export async function assertUserBelongsToTenant(
  deps: CognitoUserClientDeps,
  username: string,
  expectedTenantId: string,
): Promise<void> {
  try {
    const out = await deps.client.send(
      new AdminGetUserCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
      }),
    );
    const actual = pickAttr(out.UserAttributes, "custom:tenantId");
    if (actual !== expectedTenantId) {
      throw new TenantMismatchError(expectedTenantId, actual);
    }
  } catch (err) {
    if (err instanceof UserNotFoundException) {
      throw new UserNotFoundError(username);
    }
    throw err;
  }
}
