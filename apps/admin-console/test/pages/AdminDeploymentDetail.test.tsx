import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTenantDeploymentDetail: vi.fn(),
  fetchTenantStackProgress: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("../../src/api/admin-drill-down", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/admin-drill-down")>();
  return {
    ...actual,
    fetchTenantDeploymentDetail: mocks.fetchTenantDeploymentDetail,
    fetchTenantStackProgress: mocks.fetchTenantStackProgress,
  };
});

vi.mock("../../src/auth/AuthProvider", () => ({
  useAuth: mocks.useAuth,
}));

import type { AppConfig } from "../../src/config";

const config: AppConfig = {
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

const JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B3";
const TENANT_ID = "t-acme";

const { AdminDeploymentDetailPage } = await import("../../src/pages/AdminDeploymentDetail");
const { I18nProvider } = await import("../../src/i18n");

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/tenants/${TENANT_ID}/deployments/${JOB_ID}`]}>
        <Routes>
          <Route
            path="/tenants/:tenantId/deployments/:jobId"
            element={<AdminDeploymentDetailPage config={config} />}
          />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Force JA locale for deterministic assertions on i18n strings.
  if (typeof window !== "undefined") {
    window.localStorage.setItem("tenkacloud.admin.locale", "ja");
  }
  mocks.useAuth.mockReturnValue({
    tokens: { idToken: "id-token", accessToken: "a", expiresAt: 0 },
    ready: true,
    login: () => undefined,
    logout: () => undefined,
    setTokens: () => undefined,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("AdminDeploymentDetailPage (#598 Phase 1.B)", () => {
  it("マウント時に fetchTenantDeploymentDetail を tenantId / jobId 指定で呼ぶべき", async () => {
    mocks.fetchTenantDeploymentDetail.mockResolvedValueOnce({
      jobId: JOB_ID,
      problemId: "p1",
      tenantId: TENANT_ID,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "team-alpha",
      namePrefix: "team-alpha-p1",
      status: "COMPLETE",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T01:00:00.000Z",
      expiresAt: 0,
    });
    mocks.fetchTenantStackProgress.mockResolvedValueOnce({
      jobId: JOB_ID,
      stackName: "team-alpha-p1",
      region: "ap-northeast-1",
      consoleUrl: "https://console.aws.amazon.com/cfn",
      events: [],
      resources: [],
    });
    renderPage();
    await waitFor(() => expect(mocks.fetchTenantDeploymentDetail).toHaveBeenCalled());
    const args = mocks.fetchTenantDeploymentDetail.mock.calls[0];
    expect(args[2]).toBe(TENANT_ID);
    expect(args[3]).toBe(JOB_ID);
  });

  it("teamLoginKey フィールドは画面 DOM に出てこないべき (security regression pin)", async () => {
    mocks.fetchTenantDeploymentDetail.mockResolvedValueOnce({
      jobId: JOB_ID,
      problemId: "p1",
      tenantId: TENANT_ID,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "team-alpha",
      namePrefix: "team-alpha-p1",
      status: "COMPLETE",
      createdAt: "x",
      updatedAt: "x",
      expiresAt: 0,
      // backend が誤って leak しても表示しないことを assert する。
      teamLoginKey: "SHOULD-NEVER-RENDER" as unknown as undefined,
    });
    mocks.fetchTenantStackProgress.mockResolvedValueOnce({
      jobId: JOB_ID,
      stackName: "team-alpha-p1",
      region: "ap-northeast-1",
      consoleUrl: "https://console.aws.amazon.com/cfn",
      events: [],
      resources: [],
    });
    const { container } = renderPage();
    await screen.findByText("team-alpha-p1");
    expect(container.textContent ?? "").not.toContain("SHOULD-NEVER-RENDER");
  });

  it("StackProgress section は console URL を出すべき", async () => {
    mocks.fetchTenantDeploymentDetail.mockResolvedValueOnce({
      jobId: JOB_ID,
      problemId: "p1",
      tenantId: TENANT_ID,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: "team-alpha",
      namePrefix: "team-alpha-p1",
      status: "COMPLETE",
      createdAt: "x",
      updatedAt: "x",
      expiresAt: 0,
    });
    mocks.fetchTenantStackProgress.mockResolvedValueOnce({
      jobId: JOB_ID,
      stackName: "team-alpha-p1",
      region: "ap-northeast-1",
      consoleUrl: "https://ap-northeast-1.console.aws.amazon.com/cloudformation/home",
      events: [],
      resources: [],
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/CFn console を開く/)).toBeInTheDocument();
    });
  });
});
