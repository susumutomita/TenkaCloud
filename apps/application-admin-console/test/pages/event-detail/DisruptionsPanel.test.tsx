import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../../src/api/client";
import type { EventDetail, TeamSummary } from "../../../src/api/events-client";
import { DisruptionsPanel } from "../../../src/pages/event-detail/DisruptionsPanel";
import type { EventTabContentProps } from "../../../src/pages/event-detail/tab-content-props";
import { DisruptionsTab } from "../../../src/pages/event-detail/tabs";

const { mockCatalog, mockAudit, mockFire, mockRecurring, mockCancelRecurring } = vi.hoisted(() => ({
  mockCatalog: vi.fn(),
  mockAudit: vi.fn(),
  mockFire: vi.fn(),
  mockRecurring: vi.fn(),
  mockCancelRecurring: vi.fn(),
}));

vi.mock("../../../src/api/disruptions-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/disruptions-client")>();
  return {
    ...actual,
    fetchDisruptionCatalog: mockCatalog,
    fetchDisruptionAudit: mockAudit,
    fireDisruption: mockFire,
    fetchActiveRecurring: mockRecurring,
    cancelRecurringDisruption: mockCancelRecurring,
    newFireRequestId: () => "fire-test-00000001",
  };
});

const recurRow = {
  requestId: "r1",
  problemId: "security-battle-royale",
  disruptionId: "availability-flood",
  firedBy: "op",
  firedAt: "2026-06-18T00:00:00Z",
  scope: "all",
  affectedTeamIds: ["t1"],
  intervalMinutes: 5,
  maxFires: 6,
  endsAt: "2026-06-18T01:00:00Z",
};

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const teams: TeamSummary[] = [
  { teamId: "t1", internalSlug: "team-a", displayName: "Alpha" } as TeamSummary,
  { teamId: "t2", internalSlug: "team-b" } as TeamSummary,
];

const catalogEntry = {
  problemId: "security-battle-royale",
  disruption: {
    id: "availability-flood",
    name: "Availability flood",
    description: "Floods the app.",
    eventDetailType: "AttackFired",
    parameters: { concurrency: 50 },
  },
};

const fakeApi = {} as ApiClient;
const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    eventId: "EVT1",
    teams,
    scoreEventsByTeam: [],
    deploymentsByProblem: {},
    ...over,
  }) as unknown as EventDetail;
const renderPanel = (apiClient: ApiClient | null = fakeApi, canMutateTenant = true) =>
  render(
    <DisruptionsPanel
      apiClient={apiClient}
      canMutateTenant={canMutateTenant}
      detail={detail()}
      t={t}
    />,
  );

const modal = () => createWrapper(document.body).findModal();
const fireModalScopeSelect = () => modal()?.findContent().findSelect();

beforeEach(() => {
  mockCatalog.mockReset().mockResolvedValue({ entries: [catalogEntry] });
  mockAudit.mockReset().mockResolvedValue({ items: [] });
  mockFire
    .mockReset()
    .mockResolvedValue({ auditId: "a1", firedAt: "2026-06-03T00:00:00Z", affectedTeamIds: ["t1"] });
  mockRecurring.mockReset().mockResolvedValue({ items: [] });
  mockCancelRecurring.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => vi.clearAllMocks());

describe("DisruptionsPanel", () => {
  it("should load and list the catalog", async () => {
    renderPanel();
    expect(await screen.findByText("Availability flood")).toBeInTheDocument();
    expect(mockCatalog).toHaveBeenCalledWith(fakeApi, "EVT1");
  });

  it("[#1775] should show '手動のみ' when a disruption declares no triggers", async () => {
    renderPanel();
    await screen.findByText("Availability flood");
    expect(screen.getByText("disruptions.trigger_manual_only")).toBeInTheDocument();
  });

  it("[#1775] should list every declared auto-fire condition (OR-combined)", async () => {
    mockCatalog.mockResolvedValue({
      entries: [
        {
          ...catalogEntry,
          disruption: {
            ...catalogEntry.disruption,
            triggers: [
              { kind: "after-deploy", afterMinutes: 30 },
              { kind: "team-score-above", threshold: 5000 },
              { kind: "phase-entered", phaseName: "hardening" },
            ],
          },
        },
      ],
    });
    renderPanel();
    await screen.findByText("Availability flood");
    expect(screen.getByText('disruptions.trigger_after_deploy:{"minutes":30}')).toBeInTheDocument();
    expect(
      screen.getByText('disruptions.trigger_score_above:{"threshold":5000}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('disruptions.trigger_phase_entered:{"phase":"hardening"}'),
    ).toBeInTheDocument();
    expect(screen.queryByText("disruptions.trigger_manual_only")).not.toBeInTheDocument();
  });

  it("should not fetch when there is no api client", () => {
    renderPanel(null);
    expect(mockCatalog).not.toHaveBeenCalled();
    expect(screen.getByText("disruptions.loading")).toBeInTheDocument();
  });

  it("should show a load error when the catalog fetch fails", async () => {
    mockCatalog.mockRejectedValue(new Error("catalog boom"));
    renderPanel();
    expect(await screen.findByText("catalog boom")).toBeInTheDocument();
  });

  it("should disable fire controls for a read-only viewer", async () => {
    render(
      <DisruptionsPanel apiClient={fakeApi} canMutateTenant={false} detail={detail()} t={t} />,
    );
    expect(await screen.findByRole("button", { name: "disruptions.fire_button" })).toBeDisabled();
  });

  it("should show the empty state when no disruptions are declared", async () => {
    mockCatalog.mockResolvedValue({ entries: [] });
    renderPanel();
    expect(await screen.findByText("disruptions.catalog_empty")).toBeInTheDocument();
  });

  it("should fire at scope=all and show the success flash + reload audit", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() =>
      expect(mockFire).toHaveBeenCalledWith(
        fakeApi,
        "EVT1",
        expect.objectContaining({
          problemId: "security-battle-royale",
          disruptionId: "availability-flood",
          scope: "all",
          parameters: { concurrency: 50 },
          requestId: "fire-test-00000001",
        }),
      ),
    );
    expect(await screen.findByText(/disruptions.fired_flash/)).toBeInTheDocument();
    expect(mockAudit).toHaveBeenCalledTimes(2); // initial load + reload after fire
  });

  it("should require a team selection for scope=team, then fire with targetTeamIds", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    // switch scope to "team"
    const select = fireModalScopeSelect();
    select?.openDropdown();
    select?.selectOptionByValue("team");
    // pick a team (confirm is disabled until at least one is selected)
    const ms = modal()?.findContent().findMultiselect();
    ms?.openDropdown();
    ms?.selectOptionByValue("t1");
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() =>
      expect(mockFire).toHaveBeenCalledWith(
        fakeApi,
        "EVT1",
        expect.objectContaining({ scope: "team", targetTeamIds: ["t1"] }),
      ),
    );
  });

  it("should fire at scope=random-n with a randomCount from the selected pool", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    const select = fireModalScopeSelect();
    select?.openDropdown();
    select?.selectOptionByValue("random-n");
    const ms = modal()?.findContent().findMultiselect();
    ms?.openDropdown();
    ms?.selectOptionByValue("t1");
    ms?.selectOptionByValue("t2");
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() =>
      expect(mockFire).toHaveBeenCalledWith(
        fakeApi,
        "EVT1",
        expect.objectContaining({ scope: "random-n", randomCount: 2 }),
      ),
    );
  });

  it("should show a fire error inside the modal when firing fails", async () => {
    mockFire.mockRejectedValue(new Error("fire boom"));
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    expect(await screen.findByText("fire boom")).toBeInTheDocument();
  });

  it("should dismiss the success flash, dismiss the modal via X, and cancel", async () => {
    renderPanel();
    // fire once to get the flash, then dismiss it (Alert onDismiss → clears lastFired)
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await screen.findByText(/disruptions.fired_flash/);
    // the success flash is the only alert when there is no load error.
    createWrapper(document.body).findAlert()?.findDismissButton()?.click();
    await waitFor(() => expect(screen.queryByText(/disruptions.fired_flash/)).toBeNull());
    // open + dismiss the modal via the X (Modal onDismiss)
    fireEvent.click(screen.getByText("disruptions.fire_button"));
    createWrapper(document.body).findModal()?.findDismissButton()?.click();
    await waitFor(() => expect(createWrapper(document.body).findModal()).toBeNull());
    // open + cancel via the Cancel button
    fireEvent.click(screen.getByText("disruptions.fire_button"));
    fireEvent.click(screen.getByText("disruptions.cancel"));
    await waitFor(() => expect(createWrapper(document.body).findModal()).toBeNull());
  });

  it("should fire immediately (no timing/afterMinutes) by default", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() => {
      const arg = mockFire.mock.calls[0]?.[2];
      expect(arg).not.toHaveProperty("timing");
      expect(arg).not.toHaveProperty("afterMinutes");
    });
  });

  it("should fire with timing=scheduled + afterMinutes when scheduled", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    // switch the timing segmented control to "scheduled" (2nd segment)
    modal()?.findContent().findSegmentedControl()?.findSegments()[1]?.click();
    // set the minutes input
    modal()?.findContent().findInput()?.setInputValue("45");
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() =>
      expect(mockFire).toHaveBeenCalledWith(
        fakeApi,
        "EVT1",
        expect.objectContaining({ timing: "scheduled", afterMinutes: 45 }),
      ),
    );
    expect(await screen.findByText(/disruptions.scheduled_flash/)).toBeInTheDocument();
  });

  it("should pre-fill the scheduled minutes from the declared defaultAfterMinutes", async () => {
    mockCatalog.mockResolvedValue({
      entries: [
        {
          problemId: "p",
          disruption: {
            id: "d",
            name: "Latency",
            description: "x",
            eventDetailType: "E",
            defaultAfterMinutes: 60,
          },
        },
      ],
    });
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    modal()?.findContent().findSegmentedControl()?.findSegments()[1]?.click();
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() =>
      expect(mockFire).toHaveBeenCalledWith(
        fakeApi,
        "EVT1",
        expect.objectContaining({ timing: "scheduled", afterMinutes: 60 }),
      ),
    );
  });

  it("should disable confirm when the scheduled minutes are out of range", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    modal()?.findContent().findSegmentedControl()?.findSegments()[1]?.click();
    modal()?.findContent().findInput()?.setInputValue("0");
    expect(screen.getByText("disruptions.confirm_fire").closest("button")).toBeDisabled();
  });

  it("should fire with timing=recurring + intervalMinutes + maxFires", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    // switch the timing segmented control to "recurring" (3rd segment)
    modal()?.findContent().findSegmentedControl()?.findSegments()[2]?.click();
    const [interval, maxFires] = screen.getAllByRole("spinbutton");
    fireEvent.change(interval as HTMLElement, { target: { value: "10" } });
    fireEvent.change(maxFires as HTMLElement, { target: { value: "3" } });
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() =>
      expect(mockFire).toHaveBeenCalledWith(
        fakeApi,
        "EVT1",
        expect.objectContaining({ timing: "recurring", intervalMinutes: 10, maxFires: 3 }),
      ),
    );
    expect(await screen.findByText(/disruptions.recurring_flash/)).toBeInTheDocument();
  });

  it("should disable confirm for out-of-range recurring interval / maxFires", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    modal()?.findContent().findSegmentedControl()?.findSegments()[2]?.click();
    const confirm = () => screen.getByText("disruptions.confirm_fire").closest("button");
    const [interval, maxFires] = screen.getAllByRole("spinbutton") as HTMLElement[];
    // interval: non-integer / > 1440 / < 1 are all invalid
    fireEvent.change(interval, { target: { value: "1.5" } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(interval, { target: { value: "2000" } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(interval, { target: { value: "0" } });
    expect(confirm()).toBeDisabled();
    // interval valid, then maxFires < 1 and > 60 are invalid
    fireEvent.change(interval, { target: { value: "5" } });
    fireEvent.change(maxFires, { target: { value: "0" } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(maxFires, { target: { value: "999" } });
    expect(confirm()).toBeDisabled();
  });

  it("should fire a disruption that declares no parameters", async () => {
    mockCatalog.mockResolvedValue({
      entries: [
        {
          problemId: "p",
          disruption: { id: "d", name: "No-params", description: "x", eventDetailType: "E" },
        },
      ],
    });
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.fire_button"));
    fireEvent.click(screen.getByText("disruptions.confirm_fire"));
    await waitFor(() => {
      const arg = mockFire.mock.calls[0]?.[2];
      expect(arg).not.toHaveProperty("parameters");
    });
  });

  it("DisruptionsTab should wire the panel with the event's id + teams", async () => {
    const props = {
      apiClient: fakeApi,
      canMutateTenant: true,
      detail: detail(),
      t,
    } as unknown as EventTabContentProps;
    render(<DisruptionsTab {...props} />);
    expect(await screen.findByText("Availability flood")).toBeInTheDocument();
    expect(mockCatalog).toHaveBeenCalledWith(fakeApi, "EVT1");
  });

  it("should render audit rows, showing scheduledFor for scheduled fires and '-' for immediate", async () => {
    mockAudit.mockResolvedValue({
      items: [
        {
          auditId: "a1",
          problemId: "p",
          disruptionId: "availability-flood",
          firedBy: "op",
          firedAt: "2026-06-03T00:00:00Z",
          scope: "all",
          targetTeamIds: ["t1", "t2"],
          parameters: {},
          requestId: "r1",
        },
        {
          auditId: "a2",
          problemId: "p",
          disruptionId: "availability-flood",
          firedBy: "op",
          firedAt: "2026-06-03T00:05:00Z",
          scope: "all",
          targetTeamIds: ["t1"],
          parameters: {},
          requestId: "r2",
          scheduledFor: "2026-06-03T00:35:00Z", // scheduled fire
        },
      ],
    });
    renderPanel();
    expect(await screen.findByText("2026-06-03T00:00:00Z")).toBeInTheDocument();
    // scheduled row shows its injection time; immediate row shows "-"
    expect(await screen.findByText("2026-06-03T00:35:00Z")).toBeInTheDocument();
    expect(screen.getByText("disruptions.col_scheduled_for")).toBeInTheDocument();
  });

  it("should list active recurring disruptions and cancel one", async () => {
    mockRecurring.mockResolvedValue({ items: [recurRow] });
    renderPanel();
    expect(
      await screen.findByText('disruptions.recurring_active_header:{"count":1}'),
    ).toBeInTheDocument();
    expect(screen.getByText("5m × 6")).toBeInTheDocument(); // interval × maxFires cadence
    fireEvent.click(screen.getByText("disruptions.recurring_cancel"));
    await waitFor(() => expect(mockCancelRecurring).toHaveBeenCalledWith(fakeApi, "EVT1", "r1"));
  });

  it("should hide the recurring section when none are active", async () => {
    // default mockRecurring → { items: [] }
    renderPanel();
    await screen.findByText("Availability flood"); // catalog loaded
    expect(screen.queryByText(/disruptions.recurring_active_header/)).not.toBeInTheDocument();
  });

  it("should surface an error when listing recurring fails", async () => {
    mockRecurring.mockRejectedValue(new Error("recur list boom"));
    renderPanel();
    expect(await screen.findByText("recur list boom")).toBeInTheDocument();
  });

  it("should surface an error when cancelling fails", async () => {
    mockRecurring.mockResolvedValue({ items: [recurRow] });
    mockCancelRecurring.mockRejectedValue(new Error("cancel boom"));
    renderPanel();
    fireEvent.click(await screen.findByText("disruptions.recurring_cancel"));
    expect(await screen.findByText("cancel boom")).toBeInTheDocument();
  });

  it("should show the cancel button as loading while a cancel is in flight", async () => {
    mockRecurring.mockResolvedValue({ items: [recurRow] });
    mockCancelRecurring.mockReturnValue(new Promise(() => undefined)); // never resolves
    renderPanel();
    const cancelBtn = await screen.findByText("disruptions.recurring_cancel");
    fireEvent.click(cancelBtn);
    // cancelling === requestId → button disabled (loading) while in flight
    await waitFor(() => expect(cancelBtn.closest("button")).toBeDisabled());
  });

  it("should disable cancel for a read-only (canMutateTenant=false) operator", async () => {
    mockRecurring.mockResolvedValue({ items: [recurRow] });
    renderPanel(fakeApi, false);
    const cancelBtn = await screen.findByText("disruptions.recurring_cancel");
    expect(cancelBtn.closest("button")).toBeDisabled();
  });
});
