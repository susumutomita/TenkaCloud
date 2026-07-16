import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapacityOverview, CapacityTableSummary } from "../../../src/api/capacity-client";
import type { ApiClient } from "../../../src/api/client";

/**
 * Issue #2680: CapacityScaleModal — Slice 1 の SSM runbook を `POST /admin/capacity` 経由で
 * 起動する modal。startCapacityScale を mock し、table Select / ceiling 検証 / 送信成功
 * (onAccepted) / 送信失敗 (modal 内 error) / cancel を検証。
 */
const mocks = vi.hoisted(() => ({
  startCapacityScale: vi.fn(),
}));

vi.mock("../../../src/api/capacity-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/capacity-client")>();
  return { ...actual, startCapacityScale: mocks.startCapacityScale };
});

const { CapacityScaleModal, isCapacityUnitsInvalid } = await import(
  "../../../src/pages/event-detail/CapacityScaleModal"
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
  generatedAt: "2026-07-16T12:00:00.000Z",
  tables: [table({}), table({ role: "events", tableName: "Events-x", provisionedRead: 1 })],
};

function renderModal(
  over: {
    readonly overview?: CapacityOverview;
    readonly onClose?: () => void;
    readonly onAccepted?: (accepted: unknown) => void;
  } = {},
) {
  return render(
    <CapacityScaleModal
      apiClient={apiClient}
      overview={over.overview ?? overview}
      t={t}
      onClose={over.onClose ?? (() => {})}
      onAccepted={over.onAccepted ?? (() => {})}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CapacityScaleModal", () => {
  it("should preselect the first event-hot table and prefill its current provisioned values", () => {
    renderModal();

    // Select label = role + tableName、RCU/WCU input は現行プロビジョン値。
    expect(screen.getByText("capacity.role_deployments (Deployments-x)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    // scale-down 回数制限 + 非同期反映の warning が常時出る。
    expect(screen.getByTestId("capacity-scale-warning")).toBeInTheDocument();
    // ceiling は constraint text に echo される (RCU / WCU の 2 か所)。
    expect(screen.getAllByText('capacity.scale_constraint:{"ceiling":200}')).toHaveLength(2);
  });

  it("should submit the selected table and capacities and report the accepted execution", async () => {
    mocks.startCapacityScale.mockResolvedValue({
      executionId: "exec-123",
      tableName: "Deployments-x",
      role: "deployments",
      readCapacityUnits: 25,
      writeCapacityUnits: 10,
      status: "accepted",
    });
    const onAccepted = vi.fn();
    renderModal({ onAccepted });

    const [rcuInput, wcuInput] = screen.getAllByRole("spinbutton");
    await userEvent.clear(rcuInput as HTMLElement);
    await userEvent.type(rcuInput as HTMLElement, "25");
    await userEvent.clear(wcuInput as HTMLElement);
    await userEvent.type(wcuInput as HTMLElement, "10");
    await userEvent.click(screen.getByTestId("capacity-scale-submit"));

    await waitFor(() =>
      expect(mocks.startCapacityScale).toHaveBeenCalledWith(apiClient, {
        tableName: "Deployments-x",
        readCapacityUnits: 25,
        writeCapacityUnits: 10,
      }),
    );
    await waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ executionId: "exec-123" })),
    );
  });

  it("should switch the target table via the Select", async () => {
    mocks.startCapacityScale.mockResolvedValue({
      executionId: "exec-456",
      tableName: "Events-x",
      role: "events",
      readCapacityUnits: 5,
      writeCapacityUnits: 2,
      status: "accepted",
    });
    renderModal({ onAccepted: vi.fn() });

    await userEvent.click(screen.getByText("capacity.role_deployments (Deployments-x)"));
    await userEvent.click(screen.getByText("capacity.role_events (Events-x)"));
    await userEvent.click(screen.getByTestId("capacity-scale-submit"));

    await waitFor(() =>
      expect(mocks.startCapacityScale).toHaveBeenCalledWith(
        apiClient,
        expect.objectContaining({ tableName: "Events-x" }),
      ),
    );
  });

  it("should disable submit and show the ceiling error for an over-ceiling capacity", async () => {
    renderModal();

    const [rcuInput] = screen.getAllByRole("spinbutton");
    await userEvent.clear(rcuInput as HTMLElement);
    await userEvent.type(rcuInput as HTMLElement, "201");

    expect(screen.getAllByText('capacity.scale_invalid:{"ceiling":200}').length).toBeGreaterThan(0);
    expect(screen.getByTestId("capacity-scale-submit")).toBeDisabled();
    await userEvent.click(screen.getByTestId("capacity-scale-submit"));
    expect(mocks.startCapacityScale).not.toHaveBeenCalled();
  });

  it("should keep the modal open and show the error when the runbook start fails", async () => {
    mocks.startCapacityScale.mockRejectedValue(new Error("ssm boom"));
    const onAccepted = vi.fn();
    renderModal({ onAccepted });

    await userEvent.click(screen.getByTestId("capacity-scale-submit"));

    await waitFor(() => expect(screen.getByTestId("capacity-scale-error")).toBeInTheDocument());
    expect(screen.getByText(/ssm boom/)).toBeInTheDocument();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("should close via the cancel button", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    await userEvent.click(screen.getByTestId("capacity-scale-cancel"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.startCapacityScale).not.toHaveBeenCalled();
  });

  it("should disable submit when the overview has no tables (empty allowlist)", () => {
    renderModal({ overview: { ...overview, tables: [] } });

    expect(screen.getByTestId("capacity-scale-submit")).toBeDisabled();
    // 初期値は placeholder の 1/1 (現行値が引けないため)。
    expect(screen.getAllByDisplayValue("1")).toHaveLength(2);
  });
});

describe("isCapacityUnitsInvalid", () => {
  it.each([
    ["1", false],
    ["200", false],
    ["0", true],
    ["201", true],
    ["2.5", true],
    ["abc", true],
    ["", true],
  ])("should judge %s as invalid=%s against the 200 ceiling", (raw, expected) => {
    expect(isCapacityUnitsInvalid(raw, 200)).toBe(expected);
  });
});
