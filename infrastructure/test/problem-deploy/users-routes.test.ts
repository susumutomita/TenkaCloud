import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorAccountsSharedResources } from "../../lib/problem-deploy/handlers/competitor-accounts-handler/shared";
import {
  routeChangeUserRole,
  routeCreateUser,
  routeDeleteUser,
  routeListUsers,
} from "../../lib/problem-deploy/handlers/competitor-accounts-handler/users-routes";

const send = vi.fn();

const shared = {
  tableName: "CompetitorAccounts",
  env: "test",
  tenkaCloudAccountId: "111122223333",
  ddb: { send: vi.fn() },
  ssm: { send: vi.fn() },
  sts: { send: vi.fn() },
  cognito: { send },
} as unknown as CompetitorAccountsSharedResources;

function buildApp() {
  const app = new Hono();
  app.get("/admin/users", async (c) => {
    const result = await routeListUsers({ shared }, c);
    return c.json(result.body as never, result.status as 200 | 422);
  });
  app.post("/admin/users", async (c) => {
    const result = await routeCreateUser({ shared }, c);
    return c.json(result.body as never, result.status as 201 | 400 | 409 | 422 | 500);
  });
  app.delete("/admin/users/:username", async (c) => {
    const result = await routeDeleteUser({ shared }, c);
    return c.json(result.body as never, result.status as 200 | 400 | 404 | 409 | 422 | 500);
  });
  app.patch("/admin/users/:username", async (c) => {
    const result = await routeChangeUserRole({ shared }, c);
    return c.json(result.body as never, result.status as 200 | 400 | 404 | 409 | 422 | 500);
  });
  return app;
}

function buildRouteContext(username: string, body: unknown): Parameters<typeof routeDeleteUser>[1] {
  return {
    req: {
      param: (name: string) => (name === "username" ? username : undefined),
      json: async () => body,
      header: () => undefined,
    },
    env: {
      event: {
        requestContext: {
          authorizer: {
            claims: {
              sub: "actor-sub",
              "custom:tenantId": "tenant-a",
            },
          },
        },
      },
    },
  } as unknown as Parameters<typeof routeDeleteUser>[1];
}

describe("tenant users routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEFAULT_TENANT_ID = "tenant-a";
    process.env.DEFAULT_USER_POOL_ID = "ap-northeast-1_pool";
  });

  afterEach(() => {
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.DEFAULT_USER_POOL_ID;
  });

  it("should list only users scoped to the caller tenant", async () => {
    send.mockResolvedValueOnce({
      Users: [
        {
          Username: "b@example.test",
          Enabled: true,
          UserStatus: "CONFIRMED",
          UserCreateDate: new Date("2026-01-01T00:00:00.000Z"),
          UserLastModifiedDate: new Date("2026-01-02T00:00:00.000Z"),
          Attributes: [
            { Name: "email", Value: "b@example.test" },
            { Name: "custom:tenantId", Value: "tenant-a" },
            { Name: "custom:userRole", Value: "TenantViewer" },
          ],
        },
        {
          Username: "a@example.test",
          Enabled: true,
          UserStatus: "CONFIRMED",
          Attributes: [
            { Name: "email", Value: "a@example.test" },
            { Name: "custom:tenantId", Value: "tenant-a" },
            { Name: "custom:userRole", Value: "TenantAdmin" },
          ],
        },
        {
          Username: "other@example.test",
          Enabled: true,
          UserStatus: "CONFIRMED",
          Attributes: [
            { Name: "email", Value: "other@example.test" },
            { Name: "custom:tenantId", Value: "tenant-b" },
            { Name: "custom:userRole", Value: "TenantAdmin" },
          ],
        },
      ],
    });

    const res = await buildApp().request("/admin/users");

    expect(res.status).toBe(StatusCodes.OK);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListUsersCommand);
    await expect(res.json()).resolves.toEqual({
      items: [
        {
          username: "a@example.test",
          email: "a@example.test",
          role: "TenantAdmin",
          enabled: true,
          status: "CONFIRMED",
        },
        {
          username: "b@example.test",
          email: "b@example.test",
          role: "TenantViewer",
          enabled: true,
          status: "CONFIRMED",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
  });

  it("should invite a tenant user with server-owned tenant and role attributes", async () => {
    send.mockResolvedValueOnce({
      User: {
        Username: "new@example.test",
        Enabled: true,
        UserStatus: "FORCE_CHANGE_PASSWORD",
        Attributes: [
          { Name: "email", Value: "new@example.test" },
          { Name: "custom:tenantId", Value: "tenant-a" },
          { Name: "custom:userRole", Value: "TenantOperator" },
        ],
      },
    });

    const res = await buildApp().request("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.test", role: "TenantOperator" }),
    });

    expect(res.status).toBe(StatusCodes.CREATED);
    const command = send.mock.calls[0][0] as AdminCreateUserCommand;
    expect(command).toBeInstanceOf(AdminCreateUserCommand);
    expect(command.input).toMatchObject({
      UserPoolId: "ap-northeast-1_pool",
      Username: "new@example.test",
      DesiredDeliveryMediums: ["EMAIL"],
      UserAttributes: expect.arrayContaining([
        { Name: "email", Value: "new@example.test" },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:tenantId", Value: "tenant-a" },
        { Name: "custom:userRole", Value: "TenantOperator" },
      ]),
    });
    await expect(res.json()).resolves.toEqual({
      item: {
        username: "new@example.test",
        email: "new@example.test",
        role: "TenantOperator",
        enabled: true,
        status: "FORCE_CHANGE_PASSWORD",
      },
    });
  });

  it("should 400 invalid_body when the invite body is not JSON", async () => {
    const res = await buildApp().request("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(send).not.toHaveBeenCalled();
  });

  it("should 400 validation_failed when the invite body fails the schema", async () => {
    const res = await buildApp().request("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: 123 }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("should return conflict when Cognito reports an existing username", async () => {
    const err = new Error("already exists");
    err.name = "UsernameExistsException";
    send.mockRejectedValueOnce(err);

    const res = await buildApp().request("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.test", role: "TenantViewer" }),
    });

    expect(res.status).toBe(StatusCodes.CONFLICT);
    await expect(res.json()).resolves.toEqual({
      error: "duplicate_user",
      email: "new@example.test",
    });
  });

  it("should block deleting a user from another tenant", async () => {
    send.mockResolvedValueOnce({
      Username: "other@example.test",
      Enabled: true,
      UserStatus: "CONFIRMED",
      UserAttributes: [
        { Name: "email", Value: "other@example.test" },
        { Name: "custom:tenantId", Value: "tenant-b" },
        { Name: "custom:userRole", Value: "TenantAdmin" },
      ],
    });

    const res = await buildApp().request("/admin/users/other%40example.test", {
      method: "DELETE",
    });

    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls).toHaveLength(1);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("should delete a user after verifying tenant ownership", async () => {
    send
      .mockResolvedValueOnce({
        Username: "old@example.test",
        Enabled: true,
        UserStatus: "CONFIRMED",
        UserAttributes: [
          { Name: "email", Value: "old@example.test" },
          { Name: "custom:tenantId", Value: "tenant-a" },
          { Name: "custom:userRole", Value: "TenantViewer" },
        ],
      })
      .mockResolvedValueOnce({});

    const res = await buildApp().request("/admin/users/old%40example.test", {
      method: "DELETE",
    });

    expect(res.status).toBe(StatusCodes.OK);
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(AdminDeleteUserCommand);
    await expect(res.json()).resolves.toEqual({ deleted: true });
  });

  it("should block deleting the signed-in user", async () => {
    send.mockResolvedValueOnce({
      Username: "self@example.test",
      Enabled: true,
      UserStatus: "CONFIRMED",
      UserAttributes: [
        { Name: "sub", Value: "actor-sub" },
        { Name: "email", Value: "self@example.test" },
        { Name: "custom:tenantId", Value: "tenant-a" },
        { Name: "custom:userRole", Value: "TenantAdmin" },
      ],
    });

    const result = await routeDeleteUser(
      { shared },
      buildRouteContext("self@example.test", undefined),
    );

    expect(result).toEqual({
      status: StatusCodes.CONFLICT,
      body: { error: "cannot_delete_self" },
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls).toHaveLength(1);
  });

  it("should change a role after verifying tenant ownership", async () => {
    send
      .mockResolvedValueOnce({
        Username: "member@example.test",
        Enabled: true,
        UserStatus: "CONFIRMED",
        UserAttributes: [
          { Name: "email", Value: "member@example.test" },
          { Name: "custom:tenantId", Value: "tenant-a" },
          { Name: "custom:userRole", Value: "TenantViewer" },
        ],
      })
      .mockResolvedValueOnce({});

    const res = await buildApp().request("/admin/users/member%40example.test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "TenantOperator" }),
    });

    expect(res.status).toBe(StatusCodes.OK);
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
    const command = send.mock.calls[1][0] as AdminUpdateUserAttributesCommand;
    expect(command).toBeInstanceOf(AdminUpdateUserAttributesCommand);
    expect(command.input).toMatchObject({
      UserPoolId: "ap-northeast-1_pool",
      Username: "member@example.test",
      UserAttributes: [{ Name: "custom:userRole", Value: "TenantOperator" }],
    });
    await expect(res.json()).resolves.toMatchObject({
      item: {
        username: "member@example.test",
        email: "member@example.test",
        role: "TenantOperator",
        enabled: true,
        status: "CONFIRMED",
      },
    });
  });

  it("should 400 validation_failed when the change-role body fails the schema", async () => {
    const res = await buildApp().request("/admin/users/member%40example.test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "NotARole" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("should block changing the signed-in user's role", async () => {
    send.mockResolvedValueOnce({
      Username: "self@example.test",
      Enabled: true,
      UserStatus: "CONFIRMED",
      UserAttributes: [
        { Name: "sub", Value: "actor-sub" },
        { Name: "email", Value: "self@example.test" },
        { Name: "custom:tenantId", Value: "tenant-a" },
        { Name: "custom:userRole", Value: "TenantAdmin" },
      ],
    });

    const result = await routeChangeUserRole(
      { shared },
      buildRouteContext("self@example.test", { role: "TenantViewer" }),
    );

    expect(result).toEqual({
      status: StatusCodes.CONFLICT,
      body: { error: "cannot_change_own_role" },
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls).toHaveLength(1);
  });

  it("should fail closed when the caller user pool cannot be resolved", async () => {
    delete process.env.DEFAULT_USER_POOL_ID;

    const res = await buildApp().request("/admin/users");

    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect(send).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ error: "missing_cognito_claims" });
  });
});
