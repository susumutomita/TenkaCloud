/**
 * Issue #1350: Bulk teardown は 「DELETE」 と入力させない限り confirm button が disabled。
 *
 * undo 不可な destructive 操作なので、 誤クリックでの bulkTeardownEvent 発火を防ぐ。
 * 同時に blast radius (= 何 team × 何 problem の削除か) を Alert で明示する。
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useApiClient: vi.fn(),
  getEvent: vi.fn(),
  bulkTeardownEvent: vi.fn(),
}));

vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: mocks.useApiClient };
});

vi.mock("../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/events-client")>();
  return {
    ...actual,
    getEvent: mocks.getEvent,
    bulkTeardownEvent: mocks.bulkTeardownEvent,
  };
});

import { ApiError } from "../../src/api/client";
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
  name: "Bulk Confirm Test Event",
  status: "ENDED",
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

function renderPage(pageConfig = config) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
        <Routes>
          <Route path="/events/:eventId" element={<EventDetailPage config={pageConfig} />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useApiClient.mockReturnValue({});
  mocks.bulkTeardownEvent.mockResolvedValue({
    eventId: EVENT_ID,
    enqueued: 2,
    skipped: 0,
  });
  window.localStorage.setItem("tenkacloud.application-admin.locale", "ja");
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
  }
});

afterEach(() => vi.restoreAllMocks());

describe("EventDetail existing-event self-test consent", () => {
  it("confirms and deploys an existing event through the real HTTP client without recreating it", async () => {
    const { createCoreApiClient } = await import("@tenkacloud/web-kit");
    const detail: EventDetail = { ...baseDetail, status: "DRAFT", expiresAt: 4_102_444_800 };
    mocks.getEvent.mockResolvedValue(detail);
    window.localStorage.setItem("tenkacloud.application-admin.locale", "en");
    const requests: { body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(input)).pathname).toBe(`/api/events/${EVENT_ID}/deploy`);
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ body, headers: new Headers(init?.headers) });
        return body.hostingAccountSelfTest
          ? Response.json({ eventId: EVENT_ID, enqueued: 2, skipped: 0, failed: 0 })
          : Response.json(
              { error: "unsupported_hosting_account", awsAccountId: "111111111111" },
              { status: 422 },
            );
      }),
    );
    try {
      mocks.useApiClient.mockReturnValue(
        createCoreApiClient("https://synthetic.invalid/api", "synthetic-id-token"),
      );
      renderPage();
      fireEvent.click(await screen.findByRole("tab", { name: "Schedule" }));
      fireEvent.click(await screen.findByRole("button", { name: "Deploy now" }));
      expect(
        await screen.findByRole("button", { name: "Accept risk and deploy" }),
      ).toBeInTheDocument();
      expect(requests).toHaveLength(1);
      fireEvent.click(
        within(screen.getByTestId("self-test-prompt")).getByRole("button", { name: "Cancel" }),
      );
      expect(
        screen.queryByRole("button", { name: "Accept risk and deploy" }),
      ).not.toBeInTheDocument();
      expect(requests).toHaveLength(1);
      expect(mocks.getEvent).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Deploy now" }));
      fireEvent.click(await screen.findByRole("button", { name: "Accept risk and deploy" }));
      await waitFor(() => expect(mocks.getEvent).toHaveBeenCalledTimes(2));
      expect(requests).toHaveLength(3);
      expect(requests[2]?.body).toEqual({
        hostingAccountSelfTest: {
          awsAccountId: "111111111111",
          riskVersion: "hosting-account-self-test-v1",
        },
      });
      expect(requests[2]?.headers.get("authorization")).toBe("Bearer synthetic-id-token");
      expect(requests[2]?.headers.get("Idempotency-Key")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Accept risk and deploy" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("EventDetail bulk teardown confirm dialog #1350", () => {
  it("should show the blast radius alert with team / problem counts", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Bulk Confirm Test Event/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    // teardown は「スケジュール」tab の「即座に撤去」から開く (header / 高度操作 から撤去済み)。
    await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
    await user.click(await screen.findByRole("button", { name: "即座に撤去" }));
    // blast radius (= 2 team × 1 problem) の文字列を含む
    await waitFor(() => {
      expect(screen.getByText(/影響範囲/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 team × 1/)).toBeInTheDocument();
  });

  it("should keep the confirm button disabled until DELETE is typed", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Bulk Confirm Test Event/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    // teardown は「スケジュール」tab の「即座に撤去」から開く (header / 高度操作 から撤去済み)。
    await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
    await user.click(await screen.findByRole("button", { name: "即座に撤去" }));
    const confirm = await screen.findByTestId("modal-teardown-confirm");
    expect(confirm).toBeDisabled();
    // Cloudscape Input は data-testid を wrapper に付ける。 実 <input> は placeholder で探す。
    // fireEvent.change で一発書き換え (= userEvent.type は character ごとに re-render するので
    // 並列 vitest 下では timeout に乗りやすい)。
    const input = await screen.findByPlaceholderText("DELETE");
    fireEvent.change(input, { target: { value: "delete-wrong" } });
    // wrong text → still disabled
    expect(confirm).toBeDisabled();
  });

  it("should enable the confirm button once DELETE is typed", async () => {
    mocks.getEvent.mockResolvedValueOnce(baseDetail);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/Bulk Confirm Test Event/).length).toBeGreaterThan(0),
    );
    const user = userEvent.setup();
    // teardown は「スケジュール」tab の「即座に撤去」から開く (header / 高度操作 から撤去済み)。
    await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
    await user.click(await screen.findByRole("button", { name: "即座に撤去" }));
    const input = await screen.findByPlaceholderText("DELETE");
    fireEvent.change(input, { target: { value: "DELETE" } });
    const confirm = screen.getByTestId("modal-teardown-confirm");
    await waitFor(() => expect(confirm).not.toBeDisabled());
  });

  it.each(["pending", undefined] as const)(
    "retries archived cleanup with purge state %s through typed confirmation and disables it after completion",
    async (purgeState) => {
      const pending: EventDetail = {
        ...baseDetail,
        status: "ARCHIVED",
        nativeRuns: [
          {
            runId: "run-1",
            problemId: "ac26-crypto-battle",
            status: "CLOSED",
            revision: 3,
            purgeState,
          },
        ],
      };
      const complete: EventDetail = {
        ...pending,
        nativeRuns: pending.nativeRuns?.map((run) => ({ ...run, purgeState: "complete" })),
      };
      const delJson = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, '{"error":"coordination_purge_conflict"}'))
        .mockResolvedValueOnce({ eventId: EVENT_ID, enqueued: 0, skipped: 0, failed: 0 });
      mocks.useApiClient.mockReturnValue({ delJson });
      const actual = await vi.importActual<typeof import("../../src/api/events-client")>(
        "../../src/api/events-client",
      );
      mocks.bulkTeardownEvent.mockImplementation(actual.bulkTeardownEvent);
      mocks.getEvent.mockResolvedValueOnce(pending).mockResolvedValue(complete);
      renderPage({ ...config, mode: "cloud-host" });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
      const cleanup = await screen.findByRole("button", { name: "即座に撤去" });
      expect(cleanup).toBeEnabled();
      await user.click(cleanup);
      expect(screen.getByTestId("modal-teardown-confirm")).toBeDisabled();
      fireEvent.change(await screen.findByPlaceholderText("DELETE"), {
        target: { value: "DELETE" },
      });
      await user.click(screen.getByTestId("modal-teardown-confirm"));
      expect(delJson).toHaveBeenCalledExactlyOnceWith(`events/${EVENT_ID}`);
      expect(
        await screen.findByText('API 409: {"error":"coordination_purge_conflict"}'),
      ).toBeInTheDocument();
      expect(mocks.getEvent).toHaveBeenCalledOnce();
      expect(cleanup).toBeEnabled();
      await user.click(cleanup);
      fireEvent.change(await screen.findByPlaceholderText("DELETE"), {
        target: { value: "DELETE" },
      });
      await user.click(screen.getByTestId("modal-teardown-confirm"));
      await waitFor(() => expect(mocks.getEvent).toHaveBeenCalledTimes(2));
      expect(delJson).toHaveBeenNthCalledWith(2, `events/${EVENT_ID}`);
      await waitFor(() => expect(cleanup).toBeDisabled());
      expect(
        screen.queryByText('API 409: {"error":"coordination_purge_conflict"}'),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["pending", undefined] as const)(
    "keeps archived cleanup with purge state %s disabled for read-only organizers",
    async (purgeState) => {
      mocks.getEvent.mockResolvedValue({
        ...baseDetail,
        status: "ARCHIVED",
        nativeRuns: [
          {
            runId: "run-1",
            problemId: "ac26-crypto-battle",
            status: "CLOSED",
            revision: 3,
            purgeState,
          },
        ],
      });
      mocks.useApiClient.mockReturnValue({
        tenantAccess: { canMutateTenant: false },
        cloudOrganizerRole: "Viewer",
      });
      renderPage({ ...config, mode: "cloud-host" });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: /Schedule|スケジュール/ }));
      expect(await screen.findByRole("button", { name: "即座に撤去" })).toBeDisabled();
      expect(mocks.bulkTeardownEvent).not.toHaveBeenCalled();
    },
  );
});
