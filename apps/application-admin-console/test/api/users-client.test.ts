import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  changeTenantUserRole,
  deleteTenantUser,
  inviteTenantUser,
  listTenantUsers,
} from "../../src/api/users-client";

interface CapturedCall {
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
}

function fakeClient(response: unknown): {
  readonly client: ApiClient;
  readonly calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client: ApiClient = {
    get: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "GET" });
      return Promise.resolve(response);
    }),
    post: vi.fn().mockImplementation((path: string, body: unknown) => {
      calls.push({ path, method: "POST", body });
      return Promise.resolve(response);
    }),
    put: vi.fn().mockResolvedValue(response),
    patch: vi.fn().mockImplementation((path: string, body: unknown) => {
      calls.push({ path, method: "PATCH", body });
      return Promise.resolve(response);
    }),
    del: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "DELETE" });
      return Promise.resolve();
    }),
    delJson: vi.fn().mockResolvedValue(response),
  };
  return { client, calls };
}

describe("tenant users client", () => {
  it("should call GET /admin/users", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listTenantUsers(client);
    expect(calls[0]).toEqual({ path: "admin/users", method: "GET" });
  });

  it("should POST an invite body to /admin/users", async () => {
    const { client, calls } = fakeClient({ item: { username: "a@example.test", enabled: true } });
    await inviteTenantUser(client, {
      email: "a@example.test",
      role: "TenantViewer",
    });
    expect(calls[0]).toEqual({
      path: "admin/users",
      method: "POST",
      body: { email: "a@example.test", role: "TenantViewer" },
    });
  });

  it("should DELETE a URL-encoded username", async () => {
    const { client, calls } = fakeClient({});
    await deleteTenantUser(client, "a+b@example.test");
    expect(calls[0]).toEqual({
      path: "admin/users/a%2Bb%40example.test",
      method: "DELETE",
    });
  });

  it("should PATCH a URL-encoded username role", async () => {
    const { client, calls } = fakeClient({ item: { username: "a@example.test", enabled: true } });
    await changeTenantUserRole(client, "a+b@example.test", "TenantOperator");
    expect(calls[0]).toEqual({
      path: "admin/users/a%2Bb%40example.test",
      method: "PATCH",
      body: { role: "TenantOperator" },
    });
  });
});
