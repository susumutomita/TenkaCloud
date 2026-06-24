import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../src/api/events-client";
import type { AppConfig } from "../../src/config";

/**
 * EventDetailPage の orchestration (= 配線) を対象にした wiring テスト。
 *
 * 既存の EventDetail.*.test.tsx は API 境界を mock した integration テストで、 child を
 * 実物で描画するため inline callback (header actions / danger-zone の各 prop arrow) が
 * 発火せず func coverage が 39% に留まっていた。 本テストは child (EventHeaderActions /
 * EventDangerZone / 7 tab) と Cloudscape Tabs を stub し、 各 callback を 1 click で叩いて
 * EventDetailPage 側の arrow → operations.* / navigate の配線を pin する。
 *
 * - 不正 / 欠落 eventId → /events への Navigate
 * - loading (detail=null,error=null) / error-only (detail=null,error あり) の分岐
 * - error-only header の各 action callback
 * - loaded header + danger-zone + bulk-result dismiss + tab 切替 (既知 / 未知 id) + manual refresh
 *
 * useEventDetail / useEventOperations / useT / react-router は mock、 validateEndsAtInput /
 * EVENT_ID_RE / computeEventWizardState / EVENT_TAB_IDS / readTabFromHash は実物。
 */
const h = vi.hoisted(() => ({
  useParams: vi.fn(),
  navigate: vi.fn(),
  useEventDetail: vi.fn(),
  useEventOperations: vi.fn(),
}));

vi.mock("react-router", () => ({
  useParams: () => h.useParams(),
  useNavigate: () => h.navigate,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(replace)} />
  ),
}));
vi.mock("../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/client")>();
  return { ...actual, useApiClient: () => ({}) };
});
vi.mock("../../src/hooks/useEventDetail", () => ({ useEventDetail: h.useEventDetail }));
vi.mock("../../src/hooks/useEventOperations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/useEventOperations")>();
  return { ...actual, useEventOperations: h.useEventOperations };
});
vi.mock("../../src/i18n", () => ({ useT: () => (k: string) => k }));

// EventHeaderActions stub: 各 action callback を 1 button で叩けるようにする。
vi.mock("../../src/components/event-detail/EventHeaderActions", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  EventHeaderActions: (p: any) => (
    <div data-testid="header-actions">
      <button type="button" data-testid="hdr-back" onClick={p.onBack}>
        back
      </button>
      <button type="button" data-testid="hdr-bulk-deploy" onClick={() => p.onBulkDeploy({})}>
        bulk
      </button>
      <button type="button" data-testid="hdr-end" onClick={p.onEnd}>
        end
      </button>
      <button type="button" data-testid="hdr-lock" onClick={p.onLockScoring}>
        lock
      </button>
      <button type="button" data-testid="hdr-unlock" onClick={p.onUnlockScoring}>
        unlock
      </button>
    </div>
  ),
}));

// EventDangerZone stub: #2020 で props は単一の grouped controller になったので、 各 operation
// model の action callback (`controller.<op>.<action>`) を 1 button ずつ叩けるようにする。
// `dz-<op>-<action>` の testid で、 page → controller builder → operations.* の配線を pin する。
const DZ_ACTIONS = [
  "endEvent.dismiss",
  "endEvent.execute",
  "forceArchive.dismiss",
  "forceArchive.execute",
  "teardown.dismiss",
  "teardown.execute",
  "schedule.dismiss",
  "schedule.submit",
  "endsAt.dismiss",
  "endsAt.submit",
  "teardownSchedule.dismiss",
  "teardownSchedule.submit",
  "deploySchedule.dismiss",
  "deploySchedule.submit",
  "notification.dismissModal",
  "notification.dismissSuccess",
  "notification.onSuccess",
] as const;
vi.mock("../../src/components/event-detail/EventDangerZone", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  EventDangerZone: (p: any) => {
    // 旧実装が個別 input state を配線していたのと違い、 page は controller 1 つだけを渡す。
    // 個別の input setter / date-time prop が surface に漏れていないことをここで確認する。
    const leakedInputProps = [
      "scheduleDate",
      "setScheduleDate",
      "endsAtDate",
      "setEndsAtDate",
      "teardownDate",
      "setTeardownDate",
      "deployDate",
      "setDeployDate",
    ].filter((k) => k in p);
    return (
      <div
        data-testid="danger-zone"
        data-leaked-input-props={leakedInputProps.join(",")}
        data-ctx-event-id={p.controller.eventContext.eventId}
      >
        {DZ_ACTIONS.map((path) => {
          const [op, action] = path.split(".") as [string, string];
          return (
            <button
              key={path}
              type="button"
              data-testid={`dz-${path}`}
              onClick={() => p.controller[op][action]()}
            >
              {path}
            </button>
          );
        })}
      </div>
    );
  },
}));

// tab component は stub (本テストは orchestrator 対象)。 EVENT_TAB_IDS / readTabFromHash は実物。
vi.mock("../../src/pages/event-detail/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pages/event-detail/tabs")>();
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  const OverviewTab = (p: any) => (
    <button type="button" data-testid="tab-manual-refresh" onClick={p.manualRefresh}>
      refresh
    </button>
  );
  const stub = (id: string) => () => <div data-testid={`tabstub-${id}`} />;
  return {
    ...actual,
    OverviewTab,
    ScheduleTab: stub("schedule"),
    ProblemsTab: stub("problems"),
    TeamsTab: stub("teams"),
    ScoreboardTab: stub("scoreboard"),
    NotificationsTab: stub("notifications"),
    OperationsTab: stub("operations"),
  };
});

// Cloudscape Tabs stub: onChange を既知 / 未知 id で叩け、 active content を描画する。
vi.mock("@cloudscape-design/components/tabs", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  default: (p: any) => (
    <div data-testid="tabs">
      {p.tabs.map((tab: { id: string; label: string; content: unknown }) => (
        <button
          key={tab.id}
          type="button"
          data-testid={`tabbtn-${tab.id}`}
          onClick={() => p.onChange({ detail: { activeTabId: tab.id } })}
        >
          {tab.label}
        </button>
      ))}
      <button
        type="button"
        data-testid="tabbtn-unknown"
        onClick={() => p.onChange({ detail: { activeTabId: "___nope" } })}
      >
        unknown
      </button>
      <div data-testid="tab-active">
        {p.tabs.find((tab: { id: string }) => tab.id === p.activeTabId)?.content}
      </div>
    </div>
  ),
}));

const { EventDetailPage } = await import("../../src/pages/EventDetail");

const VALID_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const config = { tenantName: "Acme" } as AppConfig;

const loadedDetail: EventDetail = {
  eventId: VALID_ID,
  name: "My Event",
  status: "READY",
  startsAt: "2026-06-01T00:00:00Z",
  endsAt: "2026-06-02T00:00:00Z",
  teams: [{ teamId: "t1" }],
  problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
  deploymentsByProblem: {
    p1: [
      { jobId: "J1", teamId: "t1", status: "COMPLETE" },
      { jobId: "J2", teamId: "t1", status: "FAILED" },
      { jobId: "J3", teamId: "t1", status: "PENDING" },
    ],
  },
} as unknown as EventDetail;

// useEventOperations の返り値 fixture (全 handler / setter は spy、 state は default)。
const makeOperations = () => ({
  bulkInFlight: null,
  bulkResult: null as { enqueued: number; skipped: number } | null,
  confirmEnd: false,
  confirmForceArchive: false,
  confirmTeardown: false,
  deployDate: "",
  deployScheduleInFlight: false,
  deployScheduleModalOpen: false,
  deployTime: "",
  endInFlight: false,
  endsAtDate: "",
  endsAtInFlight: false,
  endsAtModalOpen: false,
  endsAtTime: "",
  forceArchiveInFlight: false,
  freezeMinutesInFlight: false,
  freezeMinutesInput: "",
  handleBulkDeploy: vi.fn(),
  handleBulkTeardown: vi.fn(),
  handleEndEvent: vi.fn(),
  handleEndNowSchedule: vi.fn(),
  handleForceArchive: vi.fn(),
  handleLockScoring: vi.fn(),
  handleSaveFreezeMinutes: vi.fn(),
  handleScheduleDeploy: vi.fn(),
  handleScheduleEnd: vi.fn(),
  handleScheduleTeardown: vi.fn(),
  handleScheduledStart: vi.fn(),
  handleStartNow: vi.fn(),
  handleUnlockScoring: vi.fn(),
  notifyJustSent: false,
  notifyModalOpen: false,
  scheduleDate: "",
  scheduleInFlight: null,
  scheduleModalOpen: false,
  scheduleTime: "",
  scoringLockInFlight: null,
  setBulkResult: vi.fn(),
  setConfirmEnd: vi.fn(),
  setConfirmForceArchive: vi.fn(),
  setConfirmTeardown: vi.fn(),
  setDeployDate: vi.fn(),
  setDeployScheduleModalOpen: vi.fn(),
  setDeployTime: vi.fn(),
  setEndsAtDate: vi.fn(),
  setEndsAtModalOpen: vi.fn(),
  setEndsAtTime: vi.fn(),
  setFreezeMinutesInput: vi.fn(),
  setNotifyJustSent: vi.fn(),
  setNotifyModalOpen: vi.fn(),
  setScheduleDate: vi.fn(),
  setScheduleModalOpen: vi.fn(),
  setScheduleTime: vi.fn(),
  setTeardownDate: vi.fn(),
  setTeardownModalOpen: vi.fn(),
  setTeardownTime: vi.fn(),
  teardownDate: "",
  teardownInFlight: false,
  teardownModalOpen: false,
  teardownTime: "",
});
type Ops = ReturnType<typeof makeOperations>;
let ops: Ops;

const detailHook = (over: Partial<ReturnType<typeof baseDetailHook>> = {}) => ({
  ...baseDetailHook(),
  ...over,
});
const baseDetailHook = () => ({
  detail: null as EventDetail | null,
  error: null as string | null,
  manualRefresh: vi.fn(),
  manualRefreshInFlight: false,
  refresh: vi.fn(),
  setError: vi.fn(),
});

beforeEach(() => {
  ops = makeOperations();
  h.useParams.mockReturnValue({ eventId: VALID_ID });
  h.useEventOperations.mockReturnValue(ops);
  h.useEventDetail.mockReturnValue(detailHook({ detail: loadedDetail }));
  window.location.hash = "";
});
afterEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("EventDetailPage wiring", () => {
  it("should redirect to /events for an invalid event id", () => {
    h.useParams.mockReturnValue({ eventId: "not-a-ulid" });
    render(<EventDetailPage config={config} />);
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/events");
  });

  it("should redirect when the event id is missing", () => {
    h.useParams.mockReturnValue({});
    render(<EventDetailPage config={config} />);
    expect(screen.getByTestId("navigate")).toHaveAttribute("data-to", "/events");
  });

  it("should show the loading state when there is neither detail nor error", () => {
    h.useEventDetail.mockReturnValue(detailHook({ detail: null, error: null }));
    render(<EventDetailPage config={config} />);
    expect(screen.getByText("event_detail.loading_spinner")).toBeInTheDocument();
  });

  it("should render the error-only branch and wire its header actions", () => {
    h.useEventDetail.mockReturnValue(detailHook({ detail: null, error: "load boom" }));
    render(<EventDetailPage config={config} />);
    expect(screen.getByText("load boom")).toBeInTheDocument();
    expect(screen.getByText("event_detail.loading_title")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("hdr-back"));
    expect(h.navigate).toHaveBeenCalledWith("/events");
    fireEvent.click(screen.getByTestId("hdr-bulk-deploy"));
    expect(ops.handleBulkDeploy).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("hdr-end"));
    expect(ops.setConfirmEnd).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("hdr-lock"));
    expect(ops.handleLockScoring).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("hdr-unlock"));
    expect(ops.handleUnlockScoring).toHaveBeenCalled();
  });

  it("should render loaded and wire header / danger-zone / bulk-result / tabs", () => {
    ops.bulkResult = { enqueued: 3, skipped: 1 };
    h.useEventDetail.mockReturnValue(
      detailHook({ detail: loadedDetail, error: "operation failed" }),
    );
    render(<EventDetailPage config={config} />);

    // header に detail.name、 error alert、 bulk-result alert が出る。
    expect(screen.getByText("My Event")).toBeInTheDocument();
    expect(screen.getByText("operation failed")).toBeInTheDocument();
    expect(screen.getByText("event_detail.bulk_result_body")).toBeInTheDocument();

    // header actions の各配線。
    fireEvent.click(screen.getByTestId("hdr-back"));
    expect(h.navigate).toHaveBeenCalledWith("/events");
    fireEvent.click(screen.getByTestId("hdr-end"));
    expect(ops.setConfirmEnd).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("hdr-lock"));
    expect(ops.handleLockScoring).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("hdr-unlock"));
    expect(ops.handleUnlockScoring).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("hdr-bulk-deploy"));
    expect(ops.handleBulkDeploy).toHaveBeenCalled();

    // bulk-result alert の dismiss → setBulkResult(null)。
    fireEvent.click(document.querySelector('button[class*="dismiss-button"]') as HTMLButtonElement);
    expect(ops.setBulkResult).toHaveBeenCalledWith(null);

    // #2020: page は controller 1 つだけを渡す。 個別 input prop が surface に漏れていない。
    expect(screen.getByTestId("danger-zone")).toHaveAttribute("data-leaked-input-props", "");
    expect(screen.getByTestId("danger-zone")).toHaveAttribute("data-ctx-event-id", VALID_ID);

    // danger-zone の各 operation model action → operations.* / setter の配線。
    fireEvent.click(screen.getByTestId("dz-teardown.execute"));
    expect(ops.handleBulkTeardown).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dz-endEvent.dismiss"));
    expect(ops.setConfirmEnd).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-endsAt.dismiss"));
    expect(ops.setEndsAtModalOpen).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-forceArchive.dismiss"));
    expect(ops.setConfirmForceArchive).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-notification.dismissModal"));
    expect(ops.setNotifyModalOpen).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-notification.dismissSuccess"));
    expect(ops.setNotifyJustSent).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-schedule.dismiss"));
    expect(ops.setScheduleModalOpen).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-teardown.dismiss"));
    expect(ops.setConfirmTeardown).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-endEvent.execute"));
    expect(ops.handleEndEvent).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dz-forceArchive.execute"));
    expect(ops.handleForceArchive).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dz-endsAt.submit"));
    expect(ops.handleScheduleEnd).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dz-teardownSchedule.submit"));
    expect(ops.handleScheduleTeardown).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dz-teardownSchedule.dismiss"));
    expect(ops.setTeardownModalOpen).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-deploySchedule.submit"));
    expect(ops.handleScheduleDeploy).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dz-deploySchedule.dismiss"));
    expect(ops.setDeployScheduleModalOpen).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByTestId("dz-schedule.submit"));
    expect(ops.handleScheduledStart).toHaveBeenCalled();
    // notification.onSuccess は modal を閉じて just-sent を立てる (2 setter)。
    fireEvent.click(screen.getByTestId("dz-notification.onSuccess"));
    expect(ops.setNotifyModalOpen).toHaveBeenCalledWith(false);
    expect(ops.setNotifyJustSent).toHaveBeenCalledWith(true);

    // 既定 active tab = overview の content (manual refresh) → manualRefresh 配線。
    fireEvent.click(screen.getByTestId("tab-manual-refresh"));

    // tab 切替: 既知 id (schedule → overview) と 未知 id (無反映)。
    fireEvent.click(screen.getByTestId("tabbtn-schedule"));
    expect(screen.getByTestId("tabstub-schedule")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tabbtn-overview"));
    expect(screen.getByTestId("tab-manual-refresh")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tabbtn-unknown")); // 未知 id は無視 (active 維持)。
    expect(screen.getByTestId("tab-manual-refresh")).toBeInTheDocument();
  });

  it("should compute the ends-at error text for an invalid ends-at input", () => {
    // date+time が parse 不能 → validateEndsAtInput が errorKey を返し、 t(errorKey) 経路を通る。
    ops.endsAtDate = "garbage";
    ops.endsAtTime = "nope";
    h.useEventDetail.mockReturnValue(detailHook({ detail: loadedDetail }));
    render(<EventDetailPage config={config} />);
    expect(screen.getByTestId("danger-zone")).toBeInTheDocument();
  });

  it("should follow the URL hash on hashchange", () => {
    render(<EventDetailPage config={config} />);
    expect(screen.getByTestId("tab-manual-refresh")).toBeInTheDocument(); // 初期 = overview
    window.location.hash = "#tab=teams";
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(screen.getByTestId("tabstub-teams")).toBeInTheDocument();
  });
});
