import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  createCompetitorAccount,
  deleteCompetitorAccount,
  listCompetitorAccounts,
  verifyCompetitorAccount,
} from "../../src/api/competitor-accounts-client";

interface CapturedCall {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
}

function fakeClient(response: unknown): { client: ApiClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client: ApiClient = {
    get: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "GET" });
      return Promise.resolve(response);
    }),
    put: vi.fn().mockResolvedValue(response),
    post: vi.fn().mockImplementation((path: string, body: unknown) => {
      calls.push({ path, method: "POST", body });
      return Promise.resolve(response);
    }),
    patch: vi.fn().mockImplementation(() => Promise.resolve(response)),
    del: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "DELETE" });
      return Promise.resolve();
    }),
    delJson: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "DELETE" });
      return Promise.resolve(response);
    }),
  };
  return { client, calls };
}

describe("listCompetitorAccounts", () => {
  it("should call GET /admin/competitor-accounts", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listCompetitorAccounts(client);
    expect(calls[0]?.path).toBe("admin/competitor-accounts");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("createCompetitorAccount", () => {
  it("should POST body to /admin/competitor-accounts and return response with externalId", async () => {
    const { client, calls } = fakeClient({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: false,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
      externalId: "abc",
      tenkaCloudAccountId: "111111111111",
    });
    const res = await createCompetitorAccount(client, {
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
    });
    expect(calls[0]?.path).toBe("admin/competitor-accounts");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ awsAccountId: "222222222222" });
    expect(res.externalId).toBe("abc");
    expect(res.tenkaCloudAccountId).toBe("111111111111");
  });
});

describe("verifyCompetitorAccount", () => {
  it("should call POST /admin/competitor-accounts/{awsAccountId}/verify (URL encode)", async () => {
    const { client, calls } = fakeClient({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: true,
      verifiedAt: "2026-05-11T00:00:00.000Z",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    });
    const res = await verifyCompetitorAccount(client, "222222222222");
    expect(calls[0]?.path).toBe("admin/competitor-accounts/222222222222/verify");
    expect(calls[0]?.method).toBe("POST");
    expect(res.verified).toBe(true);
  });
});

describe("deleteCompetitorAccount", () => {
  it("should call DELETE /admin/competitor-accounts/{awsAccountId}", async () => {
    const { client, calls } = fakeClient({});
    await deleteCompetitorAccount(client, "222222222222");
    expect(calls[0]?.path).toBe("admin/competitor-accounts/222222222222");
    expect(calls[0]?.method).toBe("DELETE");
  });
});
