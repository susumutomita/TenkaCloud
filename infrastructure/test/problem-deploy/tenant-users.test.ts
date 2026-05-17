import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  ListUsersCommand,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CognitoUserClientDeps,
  CognitoUserSummary,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/users-cognito";
import {
  assertUserBelongsToTenant,
  createUser,
  DuplicateUserError,
  deleteUser,
  listUsersByTenant,
  TenantMismatchError,
  UserNotFoundError,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/users-cognito";
import { InviteUserRequestSchema } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/users-routes";

/**
 * Issue #925 Phase 1: Tenant user CRUD wrapper の単体テスト。 Cognito SDK は \`vi.fn\` でモック
 * 化し、 入力 → SDK command の引数 + 戻り値の正規化を pin する。
 */

interface MockCognito {
  client: { send: ReturnType<typeof vi.fn> };
  userPoolId: string;
}

function mockClient(): MockCognito {
  return {
    client: { send: vi.fn() },
    userPoolId: "ap-northeast-1_XXXXXXXXX",
  };
}

describe("InviteUserRequestSchema", () => {
  it("email が必須、 valid email なら通すべき", () => {
    expect(InviteUserRequestSchema.safeParse({ email: "u@example.com" }).success).toBe(true);
  });

  it("invalid email は reject", () => {
    expect(InviteUserRequestSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(InviteUserRequestSchema.safeParse({}).success).toBe(false);
  });

  it("userRole が未指定なら TenantAdmin が default で入るべき", () => {
    const r = InviteUserRequestSchema.parse({ email: "u@example.com" });
    expect(r.userRole).toBe("TenantAdmin");
  });

  it("ADR-020 / #926 Phase B: 3 role を全て受け入れるべき (Admin / Operator / Viewer)", () => {
    for (const role of ["TenantAdmin", "TenantOperator", "TenantViewer"] as const) {
      expect(
        InviteUserRequestSchema.safeParse({ email: "u@example.com", userRole: role }).success,
      ).toBe(true);
    }
  });

  it("ADR-020 で未定義の role (= Auditor 等) は reject", () => {
    expect(
      InviteUserRequestSchema.safeParse({ email: "u@example.com", userRole: "Auditor" }).success,
    ).toBe(false);
    expect(
      InviteUserRequestSchema.safeParse({ email: "u@example.com", userRole: "SystemAdmin" })
        .success,
    ).toBe(false);
  });
});

describe("listUsersByTenant", () => {
  let mock: MockCognito;
  beforeEach(() => {
    mock = mockClient();
  });
  afterEach(() => vi.clearAllMocks());

  it("ListUsersCommand は Filter を **渡さない** べき (= Cognito 仕様: custom:* は filter 不可)", async () => {
    mock.client.send.mockResolvedValueOnce({ Users: [] });
    await listUsersByTenant(mock as CognitoUserClientDeps, "tenant-acme");
    const cmd = mock.client.send.mock.calls[0]?.[0] as ListUsersCommand;
    expect(cmd).toBeInstanceOf(ListUsersCommand);
    expect(cmd.input.Filter).toBeUndefined();
    expect(cmd.input.UserPoolId).toBe(mock.userPoolId);
  });

  it("Lambda 側で custom:tenantId が一致する user だけを返すべき (= pooled tier の越境防止)", async () => {
    mock.client.send.mockResolvedValueOnce({
      Users: [
        {
          Username: "alice@example.com",
          Enabled: true,
          UserStatus: "CONFIRMED",
          Attributes: [{ Name: "custom:tenantId", Value: "tenant-acme" }],
        },
        {
          Username: "bob@example.com",
          Enabled: true,
          UserStatus: "CONFIRMED",
          Attributes: [{ Name: "custom:tenantId", Value: "tenant-other" }],
        },
        {
          Username: "ghost@example.com",
          Enabled: true,
          UserStatus: "CONFIRMED",
          Attributes: [],
        },
      ],
    });
    const out = await listUsersByTenant(mock as CognitoUserClientDeps, "tenant-acme");
    expect(out.map((u) => u.username)).toEqual(["alice@example.com"]);
  });

  it("Cognito の Users[] を CognitoUserSummary[] に整形して返すべき", async () => {
    mock.client.send.mockResolvedValueOnce({
      Users: [
        {
          Username: "alice@example.com",
          Enabled: true,
          UserStatus: "CONFIRMED",
          UserCreateDate: new Date("2026-01-01T00:00:00Z"),
          Attributes: [
            { Name: "email", Value: "alice@example.com" },
            { Name: "custom:tenantId", Value: "tenant-acme" },
            { Name: "custom:userRole", Value: "TenantAdmin" },
          ],
        },
      ],
    });
    const out: CognitoUserSummary[] = await listUsersByTenant(
      mock as CognitoUserClientDeps,
      "tenant-acme",
    );
    expect(out).toEqual([
      {
        username: "alice@example.com",
        email: "alice@example.com",
        enabled: true,
        status: "CONFIRMED",
        createdAt: "2026-01-01T00:00:00.000Z",
        tenantId: "tenant-acme",
        userRole: "TenantAdmin",
      },
    ]);
  });

  it("Users が undefined でも空配列を返すべき", async () => {
    mock.client.send.mockResolvedValueOnce({});
    expect(await listUsersByTenant(mock as CognitoUserClientDeps, "tenant-acme")).toEqual([]);
  });
});

describe("createUser", () => {
  let mock: MockCognito;
  beforeEach(() => {
    mock = mockClient();
  });
  afterEach(() => vi.clearAllMocks());

  it("AdminCreateUser に email + custom:tenantId + custom:userRole を渡すべき", async () => {
    mock.client.send.mockResolvedValueOnce({
      User: {
        Username: "bob@example.com",
        Enabled: true,
        UserStatus: "FORCE_CHANGE_PASSWORD",
        UserCreateDate: new Date("2026-05-17T12:00:00Z"),
      },
    });
    const out = await createUser(mock as CognitoUserClientDeps, {
      email: "bob@example.com",
      tenantId: "tenant-acme",
      userRole: "TenantAdmin",
      tenantName: "Acme",
      tenantTier: "PREMIUM",
    });
    const cmd = mock.client.send.mock.calls[0]?.[0] as AdminCreateUserCommand;
    expect(cmd).toBeInstanceOf(AdminCreateUserCommand);
    expect(cmd.input.Username).toBe("bob@example.com");
    expect(cmd.input.UserAttributes).toEqual(
      expect.arrayContaining([
        { Name: "email", Value: "bob@example.com" },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:tenantId", Value: "tenant-acme" },
        { Name: "custom:userRole", Value: "TenantAdmin" },
        { Name: "custom:tenantName", Value: "Acme" },
        { Name: "custom:tenantTier", Value: "PREMIUM" },
      ]),
    );
    expect(cmd.input.DesiredDeliveryMediums).toEqual(["EMAIL"]);
    expect(out.email).toBe("bob@example.com");
    expect(out.tenantId).toBe("tenant-acme");
    expect(out.status).toBe("FORCE_CHANGE_PASSWORD");
  });

  it("UsernameExistsException は DuplicateUserError に正規化すべき", async () => {
    mock.client.send.mockRejectedValueOnce(
      new UsernameExistsException({
        message: "User account already exists",
        $metadata: {},
      }),
    );
    await expect(
      createUser(mock as CognitoUserClientDeps, {
        email: "dup@example.com",
        tenantId: "tenant-acme",
        userRole: "TenantAdmin",
        tenantName: undefined,
        tenantTier: undefined,
      }),
    ).rejects.toBeInstanceOf(DuplicateUserError);
  });
});

describe("deleteUser", () => {
  let mock: MockCognito;
  beforeEach(() => {
    mock = mockClient();
  });
  afterEach(() => vi.clearAllMocks());

  it("AdminDeleteUserCommand を呼び、 username / UserPoolId を渡すべき", async () => {
    mock.client.send.mockResolvedValueOnce({});
    await deleteUser(mock as CognitoUserClientDeps, "alice@example.com");
    const cmd = mock.client.send.mock.calls[0]?.[0] as AdminDeleteUserCommand;
    expect(cmd).toBeInstanceOf(AdminDeleteUserCommand);
    expect(cmd.input.Username).toBe("alice@example.com");
    expect(cmd.input.UserPoolId).toBe(mock.userPoolId);
  });

  it("UserNotFoundException は UserNotFoundError に正規化すべき", async () => {
    mock.client.send.mockRejectedValueOnce(
      new UserNotFoundException({ message: "User does not exist", $metadata: {} }),
    );
    await expect(
      deleteUser(mock as CognitoUserClientDeps, "ghost@example.com"),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe("assertUserBelongsToTenant (越境チェック)", () => {
  let mock: MockCognito;
  beforeEach(() => {
    mock = mockClient();
  });
  afterEach(() => vi.clearAllMocks());

  it("custom:tenantId が一致すれば throw しない", async () => {
    mock.client.send.mockResolvedValueOnce({
      UserAttributes: [{ Name: "custom:tenantId", Value: "tenant-acme" }],
    });
    await expect(
      assertUserBelongsToTenant(mock as CognitoUserClientDeps, "alice@example.com", "tenant-acme"),
    ).resolves.toBeUndefined();
    const cmd = mock.client.send.mock.calls[0]?.[0] as AdminGetUserCommand;
    expect(cmd).toBeInstanceOf(AdminGetUserCommand);
  });

  it("custom:tenantId が異なれば TenantMismatchError を throw すべき", async () => {
    mock.client.send.mockResolvedValueOnce({
      UserAttributes: [{ Name: "custom:tenantId", Value: "tenant-other" }],
    });
    await expect(
      assertUserBelongsToTenant(mock as CognitoUserClientDeps, "alice@example.com", "tenant-acme"),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it("UserNotFoundException は UserNotFoundError に正規化すべき", async () => {
    mock.client.send.mockRejectedValueOnce(
      new UserNotFoundException({ message: "User does not exist", $metadata: {} }),
    );
    await expect(
      assertUserBelongsToTenant(mock as CognitoUserClientDeps, "ghost@example.com", "tenant-acme"),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
