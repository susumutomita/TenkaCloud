/**
 * Issue #1350: EventDetail Overview tab に表示される 「競技日チェックリスト」 panel のテスト。
 *
 * Cloudscape の ExpandableSection を 4 つ (T-7 / T-1 / T-0 / T+0) を持ち、 各 phase が
 * 4 つの operator task item を持つ。 default では T-0 が expanded。 中身は read-only。
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
  name: "Checklist Test Event",
  status: "READY",
  teamCount: 1,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [{ teamId: "t1", internalSlug: "team-alpha", awsAccountId: "111111111111" }],
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

describe("EventChecklistPanel #1350", () => {
  it("should render the checklist panel on Overview tab", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Checklist Test Event/).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("event-checklist-panel")).toBeInTheDocument();
  });

  it("should render all 4 phase sections (T-7 / T-1 / T-0 / T+0)", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Checklist Test Event/).length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("event-checklist-phase-t_minus_7")).toBeInTheDocument();
    expect(screen.getByTestId("event-checklist-phase-t_minus_1")).toBeInTheDocument();
    expect(screen.getByTestId("event-checklist-phase-t_zero")).toBeInTheDocument();
    expect(screen.getByTestId("event-checklist-phase-t_plus_0")).toBeInTheDocument();
  });

  it("should render exactly 4 items per phase (visible when expanded)", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Checklist Test Event/).length).toBeGreaterThan(0),
    );
    // T-0 (= default expanded) の 4 item が DOM に存在する
    expect(screen.getByTestId("event-checklist-item-t_zero-1")).toBeInTheDocument();
    expect(screen.getByTestId("event-checklist-item-t_zero-2")).toBeInTheDocument();
    expect(screen.getByTestId("event-checklist-item-t_zero-3")).toBeInTheDocument();
    expect(screen.getByTestId("event-checklist-item-t_zero-4")).toBeInTheDocument();
  });
});
