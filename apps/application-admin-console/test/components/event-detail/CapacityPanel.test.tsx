import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapacityOverview, CapacityTableSummary } from "../../../src/api/capacity-client";
import { type ApiClient, ApiError } from "../../../src/api/client";
import type { CapacityRowModel } from "../../../src/lib/capacity-status";

/**
 * Issue #2410 Slice 2: CapacityPanel — 消費/プロビジョン/throttle の監視 panel。
 * getCapacityOverview を mock し、成功 / 一時エラー / terminal (403・503・demo 501) /
 * runbook hint の対象テーブル選択 / 手動更新 / apiClient 不在 を検証。
 * Issue #2680: 「キャパシティを変更」action (modal 起動 → 受理 flash) も startCapacityScale
 * mock で検証する。
 */
const mocks = vi.hoisted(() => ({
  getCapacityOverview: vi.fn(),
  startCapacityScale: vi.fn(),
}));

vi.mock("../../../src/api/capacity-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/capacity-client")>();
  return {
    ...actual,
    getCapacityOverview: mocks.getCapacityOverview,
    startCapacityScale: mocks.startCapacityScale,
  };
});

const { CapacityPanel, pickExampleTable } = await import(
  "../../../src/pages/event-detail/CapacityPanel"
);

const t = (k: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${k}:${JSON.stringify(params)}` : k;

const apiClient = {} as unknown as ApiClient;

function table(over: Partial<CapacityTableSummary>): CapacityTableSummary {
  return {
    role: "deployments",
    tableName: "Deployments-x",
    provisionedRead: 5,
    provisionedWrite: 2,
    gsis: [],
    consumedReadPerSecAvg: 0.1,
    consumedWritePerSecAvg: 0.05,
    consumedReadPerSecPeak: 1,
    consumedWritePerSecPeak: 0.2,
    readThrottleEvents: 0,
    writeThrottleEvents: 0,
    ...over,
  };
}

const overview: CapacityOverview = {
  applicable: true,
  windowMinutes: 30,
  ceiling: 200,
  runbookDocumentName: "stack-event-capacity",
  generatedAt: "2026-07-07T12:00:00.000Z",
  tables: [
    // deployments: 余裕あり → ok / events: throttle 4 件 → throttling / teams: peak 90% → hot
    table({}),
    table({
      role: "events",
      tableName: "Events-x",
      provisionedRead: 1,
      provisionedWrite: 1,
      readThrottleEvents: 4,
      consumedReadPerSecAvg: 0.9,
      consumedReadPerSecPeak: 1,
    }),
    table({
      role: "teams",
      tableName: "Teams-x",
      provisionedRead: 1,
      provisionedWrite: 1,
      consumedReadPerSecPeak: 0.9,
      consumedWritePerSecPeak: 0.1,
    }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CapacityPanel", () => {
  it("should stay hidden while capability is unresolved and when DynamoDB capacity is not applicable", async () => {
    mocks.getCapacityOverview.mockResolvedValue({
      applicable: false,
      reason: "dynamodb_not_in_use",
      windowMinutes: 30,
      ceiling: 200,
      runbookDocumentName: null,
      generatedAt: "2026-07-07T12:00:00.000Z",
      tables: [],
    });

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    expect(screen.queryByTestId("capacity-panel")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("capacity-panel")).not.toBeInTheDocument();
  });

  it("should render one row per event-hot table with health indicators after a successful load", async () => {
    mocks.getCapacityOverview.mockResolvedValue(overview);

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByText("Deployments-x")).toBeInTheDocument());
    expect(screen.getByText("capacity.health_ok")).toBeInTheDocument();
    expect(screen.getByText("capacity.health_throttling")).toBeInTheDocument();
    expect(screen.getByText("capacity.health_hot")).toBeInTheDocument();
    expect(screen.getByText("5 / 2")).toBeInTheDocument();
    expect(screen.getByText("0.1 → 1")).toBeInTheDocument();
    // throttle 件数 4 が error indicator で出る
    expect(screen.getByText("4")).toBeInTheDocument();
    // window/ceiling が header description に echo される
    expect(
      screen.getByText('capacity.description:{"windowMinutes":30,"ceiling":200}'),
    ).toBeInTheDocument();
  });

  it("should point the runbook command hint at the throttling table (worst first)", async () => {
    mocks.getCapacityOverview.mockResolvedValue(overview);

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByTestId("capacity-runbook-hint")).toBeInTheDocument());
    expect(screen.getByText(/--document-name stack-event-capacity/)).toBeInTheDocument();
    // throttling している Events-x が例示対象 (先頭の Deployments-x ではない)
    expect(screen.getByText(/TableName=Events-x/)).toBeInTheDocument();
    expect(screen.getByText("capacity.runbook_doc_pointer")).toBeInTheDocument();
  });

  it("should fall back to a TableName placeholder in the hint when no tables are returned", async () => {
    mocks.getCapacityOverview.mockResolvedValue({ ...overview, tables: [] });

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByTestId("capacity-runbook-hint")).toBeInTheDocument());
    expect(screen.getByText(/TableName=<TableName>/)).toBeInTheDocument();
    expect(screen.getByText("capacity.empty")).toBeInTheDocument();
  });

  it("should hide the runbook hint and the scale action when the stack has no runbook wired", async () => {
    mocks.getCapacityOverview.mockResolvedValue({ ...overview, runbookDocumentName: null });

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByText("Deployments-x")).toBeInTheDocument());
    expect(screen.queryByTestId("capacity-runbook-hint")).not.toBeInTheDocument();
    // Issue #2680: runbook 未配線 stack は read-only のまま (変更 action を出さない)。
    expect(screen.queryByTestId("capacity-scale-open")).not.toBeInTheDocument();
  });

  it("should surface a transient load error and recover on manual refresh", async () => {
    mocks.getCapacityOverview
      .mockRejectedValueOnce(new Error("api 500"))
      .mockResolvedValueOnce(overview);

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByTestId("capacity-error")).toBeInTheDocument());
    expect(screen.getByText("capacity.load_failed")).toBeInTheDocument();
    expect(screen.queryByText("api 500")).not.toBeInTheDocument();
    // Issue #2680: overview 未取得 (エラー中) は変更 action を出さない。
    expect(screen.queryByTestId("capacity-scale-open")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("capacity-refresh"));

    await waitFor(() => expect(screen.getByText("Deployments-x")).toBeInTheDocument());
    expect(screen.queryByTestId("capacity-error")).not.toBeInTheDocument();
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(2);
  });

  it.each([
    [StatusCodes.FORBIDDEN, "capacity.forbidden"],
    [StatusCodes.SERVICE_UNAVAILABLE, "capacity.unconfigured"],
    [StatusCodes.NOT_IMPLEMENTED, "capacity.demo_unsupported"],
  ] as const)("should render a calm info alert (not a red error) for terminal status %s", async (status, messageKey) => {
    mocks.getCapacityOverview.mockRejectedValue(new ApiError(status, "nope"));

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByTestId("capacity-terminal")).toBeInTheDocument());
    expect(screen.getByText(messageKey)).toBeInTheDocument();
    // terminal 状態では table / 赤エラーを出さない
    expect(screen.queryByTestId("capacity-error")).not.toBeInTheDocument();
    expect(screen.queryByText("capacity.loading")).not.toBeInTheDocument();
  });

  it("should recover from a terminal state via the manual refresh button", async () => {
    mocks.getCapacityOverview
      .mockRejectedValueOnce(new ApiError(StatusCodes.SERVICE_UNAVAILABLE, "unwired"))
      .mockResolvedValue(overview);

    render(<CapacityPanel apiClient={apiClient} t={t} />);
    await waitFor(() => expect(screen.getByTestId("capacity-terminal")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("capacity-refresh"));

    await waitFor(() => expect(screen.getByText("Deployments-x")).toBeInTheDocument());
    expect(screen.queryByTestId("capacity-terminal")).not.toBeInTheDocument();
  });

  it("should stay hidden and never fetch when the api client is absent", async () => {
    render(<CapacityPanel apiClient={null} t={t} />);

    expect(screen.queryByTestId("capacity-panel")).not.toBeInTheDocument();
    expect(mocks.getCapacityOverview).not.toHaveBeenCalled();
  });
});

describe("CapacityPanel — capacity change action (#2680)", () => {
  it("should submit a change through the modal, close it and show a dismissible accepted flash", async () => {
    mocks.getCapacityOverview.mockResolvedValue(overview);
    mocks.startCapacityScale.mockResolvedValue({
      executionId: "exec-123",
      tableName: "Deployments-x",
      role: "deployments",
      readCapacityUnits: 5,
      writeCapacityUnits: 2,
      status: "accepted",
    });

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByTestId("capacity-scale-open")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("capacity-scale-open"));
    // modal は先頭テーブルの現行値 (5/2) を prefill 済みなのでそのまま送信できる。
    await userEvent.click(screen.getByTestId("capacity-scale-submit"));

    await waitFor(() => expect(screen.getByTestId("capacity-scale-accepted")).toBeInTheDocument());
    expect(
      screen.getByText('capacity.scale_accepted:{"executionId":"exec-123"}'),
    ).toBeInTheDocument();
    expect(mocks.startCapacityScale).toHaveBeenCalledWith(apiClient, {
      tableName: "Deployments-x",
      readCapacityUnits: 5,
      writeCapacityUnits: 2,
    });
    // 受理後は modal を閉じる。
    expect(screen.queryByTestId("capacity-scale-submit")).not.toBeInTheDocument();

    // flash は dismissible。
    createWrapper(document.body)
      .findAlert('[data-testid="capacity-scale-accepted"]')
      ?.findDismissButton()
      ?.click();
    await waitFor(() =>
      expect(screen.queryByTestId("capacity-scale-accepted")).not.toBeInTheDocument(),
    );
  });

  it("should close the scale modal via cancel without starting the runbook", async () => {
    mocks.getCapacityOverview.mockResolvedValue(overview);

    render(<CapacityPanel apiClient={apiClient} t={t} />);

    await waitFor(() => expect(screen.getByTestId("capacity-scale-open")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("capacity-scale-open"));
    await userEvent.click(screen.getByTestId("capacity-scale-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("capacity-scale-submit")).not.toBeInTheDocument(),
    );
    expect(mocks.startCapacityScale).not.toHaveBeenCalled();
    expect(screen.queryByTestId("capacity-scale-accepted")).not.toBeInTheDocument();
  });
});

describe("pickExampleTable", () => {
  const row = (over: Partial<CapacityRowModel>): CapacityRowModel => ({
    role: "deployments",
    tableName: "Deployments-x",
    health: "ok",
    provisionedLabel: "1 / 1",
    consumedReadLabel: "0 → 0",
    consumedWriteLabel: "0 → 0",
    throttleEvents: 0,
    ...over,
  });

  it("should prefer a throttling table over a hot one", () => {
    const rows = [
      row({}),
      row({ tableName: "Hot-x", health: "hot" }),
      row({ tableName: "Throttling-x", health: "throttling" }),
    ];
    expect(pickExampleTable(rows)).toBe("Throttling-x");
  });

  it("should prefer a hot table when nothing throttles", () => {
    const rows = [row({}), row({ tableName: "Hot-x", health: "hot" })];
    expect(pickExampleTable(rows)).toBe("Hot-x");
  });

  it("should fall back to the first table when everything is ok", () => {
    expect(pickExampleTable([row({}), row({ tableName: "B-x" })])).toBe("Deployments-x");
  });

  it("should return null for an empty row set", () => {
    expect(pickExampleTable([])).toBeNull();
  });
});
