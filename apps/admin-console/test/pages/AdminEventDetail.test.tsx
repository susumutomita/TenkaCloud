import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTenantEventDetail: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("../../src/api/admin-drill-down", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/admin-drill-down")>();
  return {
    ...actual,
    fetchTenantEventDetail: mocks.fetchTenantEventDetail,
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

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const TENANT_ID = "t-acme";

const { AdminEventDetailPage } = await import("../../src/pages/AdminEventDetail");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/tenants/${TENANT_ID}/events/${EVENT_ID}`]}>
      <Routes>
        <Route
          path="/tenants/:tenantId/events/:eventId"
          element={<AdminEventDetailPage config={config} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    tokens: { idToken: "id-token", accessToken: "a", expiresAt: 0 },
    ready: true,
    login: () => undefined,
    logout: () => undefined,
    setTokens: () => undefined,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("AdminEventDetailPage (#598 Phase 1.B)", () => {
  it("マウント時に fetchTenantEventDetail を tenantId / eventId 指定で呼ぶべき", async () => {
    mocks.fetchTenantEventDetail.mockResolvedValueOnce({
      eventId: EVENT_ID,
      name: "Event Z",
      status: "READY",
      teamCount: 1,
      problemCount: 1,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T01:00:00.000Z",
      expiresAt: 0,
      problems: [],
      teams: [],
      deploymentsByProblem: {},
    });
    renderPage();
    await waitFor(() => expect(mocks.fetchTenantEventDetail).toHaveBeenCalled());
    const args = mocks.fetchTenantEventDetail.mock.calls[0];
    expect(args[2]).toBe(TENANT_ID);
    expect(args[3]).toBe(EVENT_ID);
  });

  it("teamLoginKey は UI に表示されず、`••••` blackout を表示すべき", async () => {
    mocks.fetchTenantEventDetail.mockResolvedValueOnce({
      eventId: EVENT_ID,
      name: "Event Z",
      status: "READY",
      teamCount: 1,
      problemCount: 0,
      createdAt: "x",
      updatedAt: "x",
      expiresAt: 0,
      problems: [],
      teams: [
        {
          teamId: "t1",
          internalSlug: "team-alpha",
          // backend が漏らしても UI は表示しないことを確認するため、敢えて undefined 以外で渡す。
          teamLoginKey: "SHOULD-NEVER-RENDER",
        },
      ],
      deploymentsByProblem: {},
    });
    const { container } = renderPage();
    await screen.findByText("Event Z");
    // 「ログインキー」列で `••••` blackout が出ているべき。
    expect(screen.getAllByText("••••").length).toBeGreaterThan(0);
    // teamLoginKey の値そのものは画面 DOM に乗っていないこと (security regression pin)。
    expect(container.textContent ?? "").not.toContain("SHOULD-NEVER-RENDER");
  });

  it("404 (not_found) を AdminInsightApiError で受けたら Alert を出すべき", async () => {
    const { AdminInsightApiError } = await import("../../src/api/admin-drill-down");
    mocks.fetchTenantEventDetail.mockRejectedValueOnce(new AdminInsightApiError(404, "not_found"));
    renderPage();
    expect(await screen.findByText(/Event が見つかりません/)).toBeInTheDocument();
  });
});
