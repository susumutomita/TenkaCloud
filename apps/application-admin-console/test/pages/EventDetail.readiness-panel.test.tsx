/**
 * Issue #1350: EventDetail Overview tab に表示される Event Readiness Panel のテスト。
 *
 * 4 つの check (start_at / deploy / teams / notifications) が status / deployments に応じて
 * 適切に ✓ / pending を出すこと、 全 ✓ で 「準備完了」 大 badge が出ることを保証する。
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return { ...actual, getEvent: mocks.getEvent };
});

import type { EventDetail } from "../../src/api/events-client";
import { computeReadinessChecks } from "../../src/components/event-detail/EventReadinessPanel";
import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email profile",
  tenantId: "tenant-test",
  tenantName: "Test Tenant",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

const baseDetail: EventDetail = {
  eventId: EVENT_ID,
  name: "Readiness Test Event",
  status: "DRAFT",
  teamCount: 2,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [
    { teamId: "t1", internalSlug: "team-alpha", awsAccountId: "111111111111" },
    { teamId: "t2", internalSlug: "team-beta", awsAccountId: "222222222222" },
  ],
  problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {},
};

const { EventDetailPage } = await import("../../src/pages/EventDetail");
const { I18nProvider } = await import("../../src/i18n");

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
        <Routes>
          <Route path="/events/:eventId" element={<EventDetailPage config={config} />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});

afterEach(() => vi.restoreAllMocks());

describe("computeReadinessChecks pure function", () => {
  it("should report all 4 checks as not ok for a brand new DRAFT event with no team accounts", () => {
    const checks = computeReadinessChecks({
      detail: {
        ...baseDetail,
        status: "DRAFT",
        startsAt: undefined,
        teams: [
          // legacy event: no awsAccountId on team → teams check fails
          { teamId: "t1", internalSlug: "team-alpha" },
        ],
      },
      completeCount: 0,
      totalDeployCount: 0,
    });
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => !c.ok)).toBe(true);
  });

  it("should report deploy as ok when complete equals total and total>0", () => {
    const checks = computeReadinessChecks({
      detail: { ...baseDetail, status: "READY" },
      completeCount: 2,
      totalDeployCount: 2,
    });
    const deployCheck = checks.find((c) => c.key === "deploy");
    expect(deployCheck?.ok).toBe(true);
  });

  it("should report deploy as NOT ok when some deployments are still pending", () => {
    const checks = computeReadinessChecks({
      detail: { ...baseDetail, status: "DEPLOYING" },
      completeCount: 1,
      totalDeployCount: 2,
    });
    const deployCheck = checks.find((c) => c.key === "deploy");
    expect(deployCheck?.ok).toBe(false);
  });

  it("should report teams as NOT ok if any team is missing awsAccountId", () => {
    const checks = computeReadinessChecks({
      detail: {
        ...baseDetail,
        teams: [
          { teamId: "t1", internalSlug: "team-alpha", awsAccountId: "111111111111" },
          { teamId: "t2", internalSlug: "team-beta" }, // no account
        ],
      },
      completeCount: 0,
      totalDeployCount: 0,
    });
    const teamsCheck = checks.find((c) => c.key === "teams");
    expect(teamsCheck?.ok).toBe(false);
  });

  it("should report notifications as ok for READY status", () => {
    const checks = computeReadinessChecks({
      detail: { ...baseDetail, status: "READY" },
      completeCount: 2,
      totalDeployCount: 2,
    });
    const n = checks.find((c) => c.key === "notifications");
    expect(n?.ok).toBe(true);
  });

  it("should mark notifications check severity as warning (= prominently shown)", () => {
    const checks = computeReadinessChecks({
      detail: { ...baseDetail, status: "DRAFT" },
      completeCount: 0,
      totalDeployCount: 0,
    });
    const n = checks.find((c) => c.key === "notifications");
    expect(n?.severity).toBe("warning");
  });
});

describe("EventReadinessPanel render in Overview tab", () => {
  it("should render the readiness panel on Overview tab", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Readiness Test Event/).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("event-readiness-panel")).toBeInTheDocument();
  });

  it("should show the all-ready badge when every check passes", async () => {
    mocks.getEvent.mockResolvedValueOnce({
      ...baseDetail,
      status: "READY",
      startsAt: "2026-06-01T10:00:00.000Z",
      deploymentsByProblem: {
        "hello-world": [
          { jobId: "J1", teamId: "t1", status: "COMPLETE" },
          { jobId: "J2", teamId: "t2", status: "COMPLETE" },
        ],
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Readiness Test Event/).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("event-readiness-ready-badge")).toBeInTheDocument();
  });

  it("should show pending badge when at least one check is not ready", async () => {
    mocks.getEvent.mockResolvedValueOnce({
      ...baseDetail,
      status: "DRAFT",
      startsAt: undefined,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Readiness Test Event/).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("event-readiness-pending-badge")).toBeInTheDocument();
  });

  it("should mark starts_at as TODO when startsAt is undefined", async () => {
    mocks.getEvent.mockResolvedValueOnce({
      ...baseDetail,
      status: "READY",
      startsAt: undefined,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Readiness Test Event/).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("event-readiness-item-starts_at-todo")).toBeInTheDocument();
  });
});
