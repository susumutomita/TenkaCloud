import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../../src/api/client";
import type { TeamSummary } from "../../../src/api/events-client";
import { DisruptionsPanel } from "../../../src/pages/event-detail/DisruptionsPanel";
import type { EventTabContentProps } from "../../../src/pages/event-detail/tab-content-props";
import { DisruptionsTab } from "../../../src/pages/event-detail/tabs";

const { mockCatalog, mockAudit, mockFire } = vi.hoisted(() => ({
  mockCatalog: vi.fn(),
  mockAudit: vi.fn(),
  mockFire: vi.fn(),
}));

vi.mock("../../../src/api/disruptions-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/disruptions-client")>();
  return {
    ...actual,
    fetchDisruptionCatalog: mockCatalog,
    fetchDisruptionAudit: mockAudit,
    fireDisruption: mockFire,
    newFireRequestId: () => "fire-test-00000001",
  };
});

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
const renderPanel = (apiClient: ApiClient | null = fakeApi) =>
  render(<DisruptionsPanel apiClient={apiClient} eventId="EVT1" teams={teams} t={t} />);

const modal = () => createWrapper(document.body).findModal();
const fireModalScopeSelect = () => modal()?.findContent().findSelect();

beforeEach(() => {
  mockCatalog.mockReset().mockResolvedValue({ entries: [catalogEntry] });
  mockAudit.mockReset().mockResolvedValue({ items: [] });
  mockFire
    .mockReset()
    .mockResolvedValue({ auditId: "a1", firedAt: "2026-06-03T00:00:00Z", affectedTeamIds: ["t1"] });
});
afterEach(() => vi.clearAllMocks());

describe("DisruptionsPanel", () => {
  it("should load and list the catalog", async () => {
    renderPanel();
    expect(await screen.findByText("Availability flood")).toBeInTheDocument();
    expect(mockCatalog).toHaveBeenCalledWith(fakeApi, "EVT1");
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
      detail: { eventId: "EVT1", teams },
      t,
    } as unknown as EventTabContentProps;
    render(<DisruptionsTab {...props} />);
    expect(await screen.findByText("Availability flood")).toBeInTheDocument();
    expect(mockCatalog).toHaveBeenCalledWith(fakeApi, "EVT1");
  });

  it("should render audit rows when present", async () => {
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
      ],
    });
    renderPanel();
    expect(await screen.findByText("2026-06-03T00:00:00Z")).toBeInTheDocument();
  });
});
