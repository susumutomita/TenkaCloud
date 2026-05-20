import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  type DeployRequestBody,
  deleteDeployment,
  getDeployment,
  getStackProgress,
  listDeployments,
  startDeployment,
  statusToIndicator,
  TERMINAL_STATUSES,
} from "../../src/api/deploy-client";

interface CapturedCall {
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
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
    patch: vi.fn().mockImplementation((path: string, body: unknown) => {
      calls.push({ path, method: "PATCH", body });
      return Promise.resolve(response);
    }),
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

describe("startDeployment", () => {
  it("POST /problems/:problemId/deploy にボディを送るべき", async () => {
    const { client, calls } = fakeClient({
      jobId: "01H",
      status: "PENDING",
      namePrefix: "tc-x-y",
      teamLoginKey: "K",
      expiresAt: 0,
    });
    const body: DeployRequestBody = {
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      teamName: "Alpha",
    };
    const res = await startDeployment(client, "security-battle-royale", body);
    expect(res.jobId).toBe("01H");
    expect(calls[0]).toEqual({
      path: "/problems/security-battle-royale/deploy",
      method: "POST",
      body,
    });
  });

  it("problemId に特殊文字が来ても URL encode するべき", async () => {
    const { client, calls } = fakeClient({
      jobId: "01H",
      status: "PENDING",
      namePrefix: "x",
      teamLoginKey: "K",
      expiresAt: 0,
    });
    await startDeployment(client, "a/b", {
      region: "r",
      awsAccountId: "0".repeat(12),
      teamName: "t",
    });
    expect(calls[0]?.path).toBe("/problems/a%2Fb/deploy");
  });
});

describe("deleteDeployment", () => {
  it("DELETE /deployments/:jobId を呼ぶべき", async () => {
    const { client, calls } = fakeClient(undefined);
    await deleteDeployment(client, "01H");
    expect(calls[0]).toEqual({ path: "/deployments/01H", method: "DELETE" });
  });

  it("jobId に特殊文字が来ても URL encode するべき", async () => {
    const { client, calls } = fakeClient(undefined);
    await deleteDeployment(client, "a/b");
    expect(calls[0]?.path).toBe("/deployments/a%2Fb");
  });
});

describe("getDeployment", () => {
  it("GET /deployments/:jobId を呼ぶべき", async () => {
    const { client, calls } = fakeClient({
      jobId: "01H",
      problemId: "p",
      tenantId: "t",
      awsAccountId: "0".repeat(12),
      region: "ap-northeast-1",
      teamName: "T",
      namePrefix: "x",
      status: "IN_PROGRESS",
      createdAt: "2026-05-04T15:00:00Z",
      updatedAt: "2026-05-04T15:00:00Z",
      expiresAt: 0,
    });
    await getDeployment(client, "01H");
    expect(calls[0]).toEqual({ path: "/deployments/01H", method: "GET" });
  });
});

describe("listDeployments", () => {
  it("GET /problems/:problemId/deployments を呼ぶべき (params 無し)", async () => {
    const { client, calls } = fakeClient({ items: [], nextCursor: undefined });
    await listDeployments(client, "p");
    expect(calls[0]?.path).toBe("/problems/p/deployments");
  });

  it("limit / cursor を query string に乗せるべき", async () => {
    const { client, calls } = fakeClient({ items: [], nextCursor: undefined });
    await listDeployments(client, "p", { limit: 10, cursor: "abc" });
    expect(calls[0]?.path).toBe("/problems/p/deployments?limit=10&cursor=abc");
  });
});

describe("TERMINAL_STATUSES", () => {
  it("terminal status を含むべき (poll 停止条件)", () => {
    expect(TERMINAL_STATUSES.has("COMPLETE")).toBe(true);
    expect(TERMINAL_STATUSES.has("FAILED")).toBe(true);
    expect(TERMINAL_STATUSES.has("DELETED")).toBe(true);
    expect(TERMINAL_STATUSES.has("EXPIRED")).toBe(true);
    expect(TERMINAL_STATUSES.has("AUTO_DELETED")).toBe(true);
  });

  it("PENDING / IN_PROGRESS / DELETING は含まないべき", () => {
    expect(TERMINAL_STATUSES.has("PENDING")).toBe(false);
    expect(TERMINAL_STATUSES.has("IN_PROGRESS")).toBe(false);
    expect(TERMINAL_STATUSES.has("DELETING")).toBe(false);
  });
});

describe("getStackProgress", () => {
  it("GET /deployments/:jobId/stack-progress を呼ぶべき", async () => {
    const { client, calls } = fakeClient({
      jobId: "01H",
      stackName: "tc-x-y",
      region: "ap-northeast-1",
      consoleUrl: "https://example.com",
      events: [],
      resources: [],
    });
    await getStackProgress(client, "01H");
    expect(calls[0]).toEqual({ path: "/deployments/01H/stack-progress", method: "GET" });
  });

  it("jobId に特殊文字が来ても URL encode するべき", async () => {
    const { client, calls } = fakeClient({
      jobId: "a/b",
      stackName: "x",
      region: "r",
      consoleUrl: "u",
      events: [],
      resources: [],
    });
    await getStackProgress(client, "a/b");
    expect(calls[0]?.path).toBe("/deployments/a%2Fb/stack-progress");
  });
});

describe("statusToIndicator", () => {
  it("CREATE_COMPLETE は success にすべき", () => {
    expect(statusToIndicator("CREATE_COMPLETE")).toBe("success");
    expect(statusToIndicator("UPDATE_COMPLETE")).toBe("success");
  });

  it("CREATE_FAILED は error にすべき", () => {
    expect(statusToIndicator("CREATE_FAILED")).toBe("error");
    expect(statusToIndicator("UPDATE_FAILED")).toBe("error");
  });

  it("ROLLBACK 系は warning にすべき", () => {
    expect(statusToIndicator("ROLLBACK_IN_PROGRESS")).toBe("warning");
    expect(statusToIndicator("UPDATE_ROLLBACK_COMPLETE")).toBe("warning");
  });

  it("DELETE_COMPLETE は stopped にすべき", () => {
    expect(statusToIndicator("DELETE_COMPLETE")).toBe("stopped");
  });

  it("CREATE_IN_PROGRESS は in-progress にすべき", () => {
    expect(statusToIndicator("CREATE_IN_PROGRESS")).toBe("in-progress");
  });

  it("未知 status は in-progress にフォールバックすべき", () => {
    expect(statusToIndicator("SOMETHING_NEW_FROM_FUTURE_CFN")).toBe("in-progress");
  });
});
