import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  createCompetitorAccount,
  deleteCompetitorAccount,
  listCompetitorAccounts,
  rotateExternalId,
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
  it("GET /admin/competitor-accounts を呼ぶべき", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listCompetitorAccounts(client);
    expect(calls[0]?.path).toBe("admin/competitor-accounts");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("createCompetitorAccount", () => {
  it("POST /admin/competitor-accounts に body を送り externalId を含む response を返すべき", async () => {
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
  it("POST /admin/competitor-accounts/{awsAccountId}/verify を呼ぶべき (URL encode)", async () => {
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
  it("DELETE /admin/competitor-accounts/{awsAccountId} を呼ぶべき", async () => {
    const { client, calls } = fakeClient({});
    await deleteCompetitorAccount(client, "222222222222");
    expect(calls[0]?.path).toBe("admin/competitor-accounts/222222222222");
    expect(calls[0]?.method).toBe("DELETE");
  });
});

describe("rotateExternalId", () => {
  it("POST /admin/competitor-accounts/{awsAccountId}/rotate-external-id を呼び新 externalId を返すべき", async () => {
    const { client, calls } = fakeClient({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: true,
      verifiedAt: "2026-05-11T00:00:00.000Z",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-12T00:00:00.000Z",
      rotatedAt: "2026-05-12T00:00:00.000Z",
      externalId: "rotated-new-value",
      tenkaCloudAccountId: "111111111111",
    });
    const res = await rotateExternalId(client, "222222222222");
    expect(calls[0]?.path).toBe("admin/competitor-accounts/222222222222/rotate-external-id");
    expect(calls[0]?.method).toBe("POST");
    expect(res.externalId).toBe("rotated-new-value");
    expect(res.rotatedAt).toBe("2026-05-12T00:00:00.000Z");
    expect(res.tenkaCloudAccountId).toBe("111111111111");
  });
});
