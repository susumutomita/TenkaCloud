import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
  bulkDeployEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return {
    ...actual,
    useApiClient: mocks.useApiClient,
  };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return {
    ...actual,
    getEvent: mocks.getEvent,
    bulkDeployEvent: mocks.bulkDeployEvent,
  };
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
};

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

const baseDetail: EventDetail = {
  eventId: EVENT_ID,
  name: "Test Event",
  status: "DEPLOYING",
  teamCount: 2,
  problemCount: 1,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
  expiresAt: 0,
  teams: [
    { teamId: "t1", internalSlug: "team-alpha" },
    { teamId: "t2", internalSlug: "team-beta" },
  ],
  problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {},
};

const { EventDetailPage } = await import("../../src/pages/EventDetail");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
      <Routes>
        <Route path="/events/:eventId" element={<EventDetailPage config={config} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  mocks.bulkDeployEvent.mockResolvedValue({
    eventId: EVENT_ID,
    enqueued: 0,
    skipped: 0,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetailPage #555 失敗分を再実行 button", () => {
  it("FAILED な deployment が 0 件のときは button を表示しないべき", async () => {
    mocks.getEvent.mockResolvedValueOnce({
      ...baseDetail,
      deploymentsByProblem: {
        "hello-world": [
          { jobId: "J1", teamId: "t1", status: "COMPLETE" },
          { jobId: "J2", teamId: "t2", status: "PENDING" },
        ],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/Test Event/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/失敗分を再実行/)).not.toBeInTheDocument();
  });

  it("FAILED な deployment があると 件数つきで button を表示するべき", async () => {
    mocks.getEvent.mockResolvedValueOnce({
      ...baseDetail,
      deploymentsByProblem: {
        "hello-world": [
          { jobId: "J1", teamId: "t1", status: "FAILED" },
          { jobId: "J2", teamId: "t2", status: "FAILED" },
        ],
      },
    });
    renderPage();
    expect(await screen.findByText(/失敗分を再実行 \(2 件\)/)).toBeInTheDocument();
  });

  it("button を押すと bulkDeployEvent を retryFailedOnly=true で呼ぶべき", async () => {
    mocks.getEvent.mockResolvedValue({
      ...baseDetail,
      deploymentsByProblem: {
        "hello-world": [{ jobId: "J1", teamId: "t1", status: "FAILED" }],
      },
    });
    renderPage();
    const button = await screen.findByText(/失敗分を再実行 \(1 件\)/);
    await userEvent.click(button);
    await waitFor(() => expect(mocks.bulkDeployEvent).toHaveBeenCalled());
    expect(mocks.bulkDeployEvent).toHaveBeenCalledWith(expect.anything(), EVENT_ID, {
      retryFailedOnly: true,
    });
  });

  it("ARCHIVED 状態の event では button を disable するべき", async () => {
    mocks.getEvent.mockResolvedValueOnce({
      ...baseDetail,
      status: "ARCHIVED",
      deploymentsByProblem: {
        "hello-world": [{ jobId: "J1", teamId: "t1", status: "FAILED" }],
      },
    });
    renderPage();
    const button = await screen.findByText(/失敗分を再実行 \(1 件\)/);
    // Cloudscape Button は内部で <button> をレンダリング。disabled は祖先ボタンの属性
    const buttonEl = button.closest("button");
    expect(buttonEl?.disabled).toBe(true);
  });
});
