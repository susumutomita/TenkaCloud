import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  type CognitoIdentityProviderClient,
  DeliveryMediumType,
  ListUsersInGroupCommand,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Issue #949 (ADR-020 Phase C): SystemAdmin Console (= `apps/admin-console`) 側の
 * SystemAdmin user CRUD 用 Cognito wrapper。 tenant 側の `users-cognito.ts` と shape は同じだが、
 * 違いは:
 *
 *   - 識別軸が **Cognito group** (= `SystemAdmin` / `SystemAuditor`) であり `custom:tenantId` ではない
 *     → list は `ListUsersInGroup(group="SystemAdmin")` を使う
 *     → create は `AdminCreateUser` の後に `AdminAddUserToGroup` で group を付ける
 *     → role 変更は group の add / remove 操作
 *   - UserPool は固定 (= ControlPlane の UserPool ID を env から取る)。 tenant 側のような
 *     JWT iss から runtime 抽出 (= self-targeting) ではない
 *
 * 競合動作:
 *   - email 重複 → `UsernameExistsException` を `DuplicateSystemUserError` に正規化
 *   - 存在しない user の操作 → `UserNotFoundException` を `SystemUserNotFoundError` に正規化
 *
 * 越境防止:
 *   - 本 wrapper は単一 ControlPlane UserPool 内に閉じている (= tenant 越境 risk なし)
 *   - self-delete 防止は caller layer (route) で sub / username 比較
 */

export const SYSTEM_ADMIN_GROUP = "SystemAdmin";
export const SYSTEM_AUDITOR_GROUP = "SystemAuditor";
export const SYSTEM_GROUPS = [SYSTEM_ADMIN_GROUP, SYSTEM_AUDITOR_GROUP] as const;
export type SystemUserRole = (typeof SYSTEM_GROUPS)[number];

export interface SystemUserClientDeps {
  readonly client: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
}

export interface SystemUserSummary {
  readonly username: string;
  readonly email: string | undefined;
  readonly enabled: boolean;
  readonly status: string | undefined;
  readonly createdAt: string | undefined;
  /** ユーザーが属する全 system group (= `SystemAdmin` / `SystemAuditor`)。 通常 1 つ。 */
  readonly groups: readonly SystemUserRole[];
}

export class DuplicateSystemUserError extends Error {
  constructor(public readonly email: string) {
    super(`SystemAdmin user with email ${email} already exists`);
    this.name = "DuplicateSystemUserError";
  }
}

export class SystemUserNotFoundError extends Error {
  constructor(public readonly username: string) {
    super(`SystemAdmin user ${username} not found`);
    this.name = "SystemUserNotFoundError";
  }
}

function pickAttr(
  attrs: ReadonlyArray<{ Name?: string; Value?: string }> | undefined,
  name: string,
): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

/**
 * SystemAdmin / SystemAuditor 各 group の user を 1 ページ取得して合算する (= 重複 dedupe)。
 * 60 件超は paginate を別途追加する (= Phase 1 は cap 内の想定)。
 */
export async function listSystemUsers(deps: SystemUserClientDeps): Promise<SystemUserSummary[]> {
  const seenByUsername = new Map<string, SystemUserSummary>();
  for (const group of SYSTEM_GROUPS) {
    const out = await deps.client.send(
      new ListUsersInGroupCommand({
        UserPoolId: deps.userPoolId,
        GroupName: group,
        Limit: 60,
      }),
    );
    for (const u of out.Users ?? []) {
      const username = u.Username ?? "";
      if (!username) continue;
      const existing = seenByUsername.get(username);
      const groups: SystemUserRole[] = existing ? [...existing.groups] : [];
      if (!groups.includes(group)) groups.push(group);
      seenByUsername.set(username, {
        username,
        email: pickAttr(u.Attributes, "email"),
        enabled: u.Enabled ?? false,
        status: u.UserStatus,
        createdAt: u.UserCreateDate?.toISOString(),
        groups,
      });
    }
  }
  return Array.from(seenByUsername.values()).sort((a, b) =>
    (a.email ?? a.username).localeCompare(b.email ?? b.username),
  );
}

export interface CreateSystemUserInput {
  readonly email: string;
  readonly role: SystemUserRole;
}

export async function createSystemUser(
  deps: SystemUserClientDeps,
  input: CreateSystemUserInput,
): Promise<SystemUserSummary> {
  const attrs: { Name: string; Value: string }[] = [
    { Name: "email", Value: input.email },
    { Name: "email_verified", Value: "true" },
  ];
  let createdUsername: string;
  let createdAt: string | undefined;
  let status: string | undefined;
  let enabled = true;
  try {
    const out = await deps.client.send(
      new AdminCreateUserCommand({
        UserPoolId: deps.userPoolId,
        Username: input.email,
        UserAttributes: attrs,
        DesiredDeliveryMediums: [DeliveryMediumType.EMAIL],
      }),
    );
    createdUsername = out.User?.Username ?? input.email;
    createdAt = out.User?.UserCreateDate?.toISOString();
    status = out.User?.UserStatus;
    enabled = out.User?.Enabled ?? true;
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new DuplicateSystemUserError(input.email);
    }
    throw err;
  }
  // AdminCreateUser 直後に group 追加。 失敗時は user が group 無し状態で残るので、 best-effort
  // で AdminDeleteUser で巻き戻す (= idempotent な再 invite を許容)。
  try {
    await deps.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: deps.userPoolId,
        Username: createdUsername,
        GroupName: input.role,
      }),
    );
  } catch (err) {
    try {
      await deps.client.send(
        new AdminDeleteUserCommand({
          UserPoolId: deps.userPoolId,
          Username: createdUsername,
        }),
      );
    } catch {
      // 巻き戻しの失敗は log のみ。 caller に元 throw を伝える方が優先。
      console.error("[system-users] rollback delete failed", { username: createdUsername });
    }
    throw err;
  }
  return {
    username: createdUsername,
    email: input.email,
    enabled,
    status,
    createdAt,
    groups: [input.role],
  };
}

export async function deleteSystemUser(
  deps: SystemUserClientDeps,
  username: string,
): Promise<void> {
  try {
    await deps.client.send(
      new AdminDeleteUserCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) {
      throw new SystemUserNotFoundError(username);
    }
    throw err;
  }
}

/**
 * 既存 user の role を変更する (= group remove + add)。 newRole が現状と同じなら no-op。
 * 不在なら `SystemUserNotFoundError`。
 */
export async function updateSystemUserRole(
  deps: SystemUserClientDeps,
  username: string,
  newRole: SystemUserRole,
): Promise<void> {
  let currentGroups: readonly string[];
  try {
    const out = (await deps.client.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
        Limit: 60,
      }),
    )) as { Groups?: { GroupName?: string }[] };
    currentGroups = (out.Groups ?? []).map((g) => g.GroupName ?? "").filter(Boolean);
  } catch (err) {
    if (err instanceof UserNotFoundException) {
      throw new SystemUserNotFoundError(username);
    }
    throw err;
  }
  for (const g of currentGroups) {
    if ((SYSTEM_GROUPS as readonly string[]).includes(g) && g !== newRole) {
      await deps.client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: deps.userPoolId,
          Username: username,
          GroupName: g,
        }),
      );
    }
  }
  if (!currentGroups.includes(newRole)) {
    await deps.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
        GroupName: newRole,
      }),
    );
  }
}

/**
 * 単一 system user を取得する (= detail view 用)。 不在なら `SystemUserNotFoundError`。
 *
 * AdminGetUser の response 型は `Pick<...>` で void 化されているため、 ad-hoc cast で field を引く
 * (= 既存 admin-insight handlers と同パターン)。
 */
export async function getSystemUser(
  deps: SystemUserClientDeps,
  username: string,
): Promise<SystemUserSummary> {
  let userRaw: unknown;
  try {
    userRaw = await deps.client.send(
      new AdminGetUserCommand({
        UserPoolId: deps.userPoolId,
        Username: username,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) {
      throw new SystemUserNotFoundError(username);
    }
    throw err;
  }
  const groupsOut = (await deps.client.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: deps.userPoolId,
      Username: username,
      Limit: 60,
    }),
  )) as { Groups?: { GroupName?: string }[] };
  const groups = (groupsOut.Groups ?? [])
    .map((g) => g.GroupName ?? "")
    .filter((g): g is SystemUserRole => (SYSTEM_GROUPS as readonly string[]).includes(g));
  const u = userRaw as {
    Username?: string;
    UserAttributes?: { Name?: string; Value?: string }[];
    UserCreateDate?: Date;
    UserStatus?: string;
    Enabled?: boolean;
  };
  return {
    username: u.Username ?? username,
    email: pickAttr(u.UserAttributes, "email"),
    enabled: u.Enabled ?? false,
    status: u.UserStatus,
    createdAt: u.UserCreateDate?.toISOString(),
    groups,
  };
}
