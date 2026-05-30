import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  type DeployRequestBody,
  deleteDeployment,
  getDeployment,
  getStackProgress,
  listAllDeployments,
  listDeployments,
  parseStackOutputs,
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
  it("should POST body to /problems/:problemId/deploy", async () => {
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

  it("should URL-encode problemId even with special characters", async () => {
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
  it("should call DELETE /deployments/:jobId", async () => {
    const { client, calls } = fakeClient(undefined);
    await deleteDeployment(client, "01H");
    expect(calls[0]).toEqual({ path: "/deployments/01H", method: "DELETE" });
  });

  it("should URL-encode jobId even with special characters", async () => {
    const { client, calls } = fakeClient(undefined);
    await deleteDeployment(client, "a/b");
    expect(calls[0]?.path).toBe("/deployments/a%2Fb");
  });
});

describe("getDeployment", () => {
  it("should call GET /deployments/:jobId", async () => {
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

describe("parseStackOutputs", () => {
  it("should extract only string values from map-form stackOutputs", () => {
    expect(
      parseStackOutputs(
        JSON.stringify({
          FrontendUrl: "https://app.example.com",
          Port: 443,
          Empty: null,
        }),
      ),
    ).toEqual({ FrontendUrl: "https://app.example.com" });
  });

  it("should extract OutputKey/OutputValue from CloudFormation Output array form", () => {
    expect(
      parseStackOutputs(
        JSON.stringify([
          "not-an-object", // 非 object entry → skip (isObjectLike false)
          null,
          { OutputKey: "FrontendUrl", OutputValue: "https://app.example.com" },
          { OutputKey: "IgnoredNumber", OutputValue: 123 },
          { OutputKey: 456, OutputValue: "ignored" },
        ]),
      ),
    ).toEqual({ FrontendUrl: "https://app.example.com" });
  });

  it("should return empty map for broken JSON or non-object", () => {
    expect(parseStackOutputs(undefined)).toEqual({});
    expect(parseStackOutputs("{bad json")).toEqual({});
    expect(parseStackOutputs(JSON.stringify("not-object"))).toEqual({});
  });
});

describe("listDeployments", () => {
  it("should call GET /problems/:problemId/deployments (no params)", async () => {
    const { client, calls } = fakeClient({ items: [], nextCursor: undefined });
    await listDeployments(client, "p");
    expect(calls[0]?.path).toBe("/problems/p/deployments");
  });

  it("should put limit / cursor onto the query string", async () => {
    const { client, calls } = fakeClient({ items: [], nextCursor: undefined });
    await listDeployments(client, "p", { limit: 10, cursor: "abc" });
    expect(calls[0]?.path).toBe("/problems/p/deployments?limit=10&cursor=abc");
  });
});

describe("listAllDeployments", () => {
  it("should call GET /deployments tenant-wide (no problemId scope)", async () => {
    const { client, calls } = fakeClient({ items: [], nextCursor: undefined });
    await listAllDeployments(client, { limit: 50 });
    expect(calls[0]?.path).toBe("/deployments?limit=50");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("TERMINAL_STATUSES", () => {
  it("should contain terminal statuses (poll stop condition)", () => {
    expect(TERMINAL_STATUSES.has("COMPLETE")).toBe(true);
    expect(TERMINAL_STATUSES.has("FAILED")).toBe(true);
    expect(TERMINAL_STATUSES.has("DELETED")).toBe(true);
    expect(TERMINAL_STATUSES.has("EXPIRED")).toBe(true);
    expect(TERMINAL_STATUSES.has("AUTO_DELETED")).toBe(true);
  });

  it("should NOT contain PENDING / IN_PROGRESS / DELETING", () => {
    expect(TERMINAL_STATUSES.has("PENDING")).toBe(false);
    expect(TERMINAL_STATUSES.has("IN_PROGRESS")).toBe(false);
    expect(TERMINAL_STATUSES.has("DELETING")).toBe(false);
  });
});

describe("getStackProgress", () => {
  it("should call GET /deployments/:jobId/stack-progress", async () => {
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

  it("should URL-encode jobId even with special characters", async () => {
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
  it("should map CREATE_COMPLETE to success", () => {
    expect(statusToIndicator("CREATE_COMPLETE")).toBe("success");
    expect(statusToIndicator("UPDATE_COMPLETE")).toBe("success");
  });

  it("should map CREATE_FAILED to error", () => {
    expect(statusToIndicator("CREATE_FAILED")).toBe("error");
    expect(statusToIndicator("UPDATE_FAILED")).toBe("error");
  });

  it("should map ROLLBACK statuses to warning", () => {
    expect(statusToIndicator("ROLLBACK_IN_PROGRESS")).toBe("warning");
    expect(statusToIndicator("UPDATE_ROLLBACK_COMPLETE")).toBe("warning");
  });

  it("should map DELETE_COMPLETE to stopped", () => {
    expect(statusToIndicator("DELETE_COMPLETE")).toBe("stopped");
  });

  it("should map CREATE_IN_PROGRESS to in-progress", () => {
    expect(statusToIndicator("CREATE_IN_PROGRESS")).toBe("in-progress");
  });

  it("should fall back to in-progress for unknown status", () => {
    expect(statusToIndicator("SOMETHING_NEW_FROM_FUTURE_CFN")).toBe("in-progress");
  });
});
