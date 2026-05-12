import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminInsightApiError,
  cfnStatusToIndicator,
  fetchTenantDeploymentDetail,
  fetchTenantEventDetail,
  fetchTenantEvents,
  fetchTenantStackProgress,
  parseStackOutputs,
} from "../src/api/admin-drill-down";
import type { AppConfig } from "../src/config";

const baseConfig: AppConfig = {
  cognitoDomain: "https://example.com",
  cognitoClientId: "client-id",
  redirectUri: "http://localhost/callback",
  apiBaseUrl: "https://control.example.com/",
  scope: "openid",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "https://insight.example.com",
};

describe("fetchTenantEvents (#598 Phase 1.B)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adminInsightApiUrl が空文字なら null を返し fetch を呼ばないべき", async () => {
    const res = await fetchTenantEvents(
      { ...baseConfig, adminInsightApiUrl: "" },
      "id-token",
      "t-1",
    );
    expect(res).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("正常系: tenant-scoped events URL を bearer 認証付きで叩くべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextCursor: undefined }), { status: 200 }),
    );
    const res = await fetchTenantEvents(baseConfig, "id-token", "t-acme", { limit: 25 });
    expect(res).toEqual({ items: [], nextCursor: undefined });
    const [calledUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toContain("/admin/insight/tenants/t-acme/events");
    expect(String(calledUrl)).toContain("limit=25");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer id-token",
    });
  });

  it("403 は AdminInsightApiError として throw すべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    await expect(fetchTenantEvents(baseConfig, "id-token", "t-1")).rejects.toBeInstanceOf(
      AdminInsightApiError,
    );
  });
});

describe("fetchTenantEventDetail (#598 Phase 1.B)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("404 は AdminInsightApiError (status=404) として throw すべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );
    try {
      await fetchTenantEventDetail(baseConfig, "id-token", "t-1", "01HZX0K3M3K9ZQHB3MRQHBA1B2");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminInsightApiError);
      expect((err as AdminInsightApiError).status).toBe(404);
    }
  });
});

describe("fetchTenantDeploymentDetail (#598 Phase 1.B)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常系: jobId が URL-encode されたパスで叩かれるべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ jobId: "01HZ" }), { status: 200 }),
    );
    await fetchTenantDeploymentDetail(baseConfig, "id-token", "t-1", "01HZ");
    const [calledUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toContain("/admin/insight/tenants/t-1/deployments/01HZ");
  });
});

describe("fetchTenantStackProgress (#598 Phase 1.B)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("409 (stack 未割当) は AdminInsightApiError (status=409) として throw すべき", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "stack_not_yet_created" }), { status: 409 }),
    );
    try {
      await fetchTenantStackProgress(baseConfig, "id-token", "t-1", "01HZ");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminInsightApiError);
      expect((err as AdminInsightApiError).status).toBe(409);
    }
  });
});

describe("cfnStatusToIndicator", () => {
  it("DELETE_COMPLETE は stopped", () => {
    expect(cfnStatusToIndicator("DELETE_COMPLETE")).toBe("stopped");
  });
  it("_FAILED suffix は error", () => {
    expect(cfnStatusToIndicator("CREATE_FAILED")).toBe("error");
  });
  it("ROLLBACK を含むなら warning", () => {
    expect(cfnStatusToIndicator("UPDATE_ROLLBACK_COMPLETE")).toBe("warning");
  });
  it("_COMPLETE suffix は success", () => {
    expect(cfnStatusToIndicator("CREATE_COMPLETE")).toBe("success");
  });
  it("未知 status は in-progress (fallback)", () => {
    expect(cfnStatusToIndicator("XYZ_UNKNOWN")).toBe("in-progress");
  });
});

describe("parseStackOutputs", () => {
  it("空 / undefined は空 record", () => {
    expect(parseStackOutputs(undefined)).toEqual({});
    expect(parseStackOutputs("")).toEqual({});
  });
  it("壊れた JSON は空 record (= ページを落とさない)", () => {
    expect(parseStackOutputs("{not json")).toEqual({});
  });
  it("Lambda 由来 {key: value} を読めるべき", () => {
    expect(parseStackOutputs(JSON.stringify({ ApiUrl: "https://x.com" }))).toEqual({
      ApiUrl: "https://x.com",
    });
  });
  it("Step Functions 由来 [{OutputKey,OutputValue}] を読めるべき", () => {
    expect(parseStackOutputs(JSON.stringify([{ OutputKey: "K1", OutputValue: "v1" }]))).toEqual({
      K1: "v1",
    });
  });
});
