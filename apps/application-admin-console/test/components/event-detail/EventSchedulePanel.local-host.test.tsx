import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../src/api/client";
import type { EventDetail } from "../../../src/api/events-client";
import { EventSchedulePanel } from "../../../src/components/event-detail/EventSchedulePanel";
import { computeEventWizardState } from "../../../src/lib/event-wizard";

/** Issue #3226: the local host's deploy / teardown controls match what the host accepts. */
type Props = Parameters<typeof EventSchedulePanel>[0];
function props(detail: Partial<EventDetail>, totalDeployCount = 2): Props {
  const base: EventDetail = {
    eventId: "01J00000000000000000000000",
    name: "Local",
    status: "READY",
    teamCount: 1,
    problemCount: 1,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    expiresAt: 0,
    teams: [{ teamId: "A", internalSlug: "a" }],
    problems: [{ problemId: "p", defaultRegion: "local" }],
    deploymentsByProblem: {},
  };
  return {
    apiClient: null,
    bulkInFlight: null,
    canMutateTenant: true,
    completeCount: 0,
    deployScheduleInFlight: false,
    detail: { ...base, ...detail },
    endsAtInFlight: false,
    freezeMinutesInFlight: false,
    freezeMinutesInput: "",
    localHost: true,
    onBulkDeploy: vi.fn(),
    onConfirmTeardown: vi.fn(),
    onEndNowSchedule: vi.fn(),
    onOpenDeployModal: vi.fn(),
    onOpenEndsAtModal: vi.fn(),
    onOpenScheduleModal: vi.fn(),
    onOpenTeardownModal: vi.fn(),
    onSaveFreezeMinutes: vi.fn(),
    onStartNow: vi.fn(),
    onUpdateFreezeMinutes: vi.fn(),
    scheduleInFlight: null,
    teardownInFlight: false,
    totalDeployCount,
    t: (key: string) => key,
    wizard: null,
  };
}

function teardownButton(detail: Partial<EventDetail>) {
  const view = render(
    <EventSchedulePanel
      {...props(detail)}
      apiClient={createApiClient("http://127.0.0.1:5174/api", "a.e30.c")}
    />,
  );
  const button = screen.getByRole("button", { name: "event_detail.teardown_at_now" });
  const disabled =
    button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true";
  view.unmount();
  return disabled;
}

describe("EventSchedulePanel on the local host", () => {
  it("prepares every environment of an undeployed event with a plain deploy", () => {
    const panel = props({ status: "DRAFT" }, 0);
    render(
      <EventSchedulePanel
        {...panel}
        apiClient={createApiClient("http://127.0.0.1:5174/api", "a.e30.c")}
        wizard={computeEventWizardState({ status: "DRAFT" }, Date.now())}
      />,
    );
    expect(screen.getByText("local_host.deploy_hint")).toBeInTheDocument();
    screen.getByRole("button", { name: "event_detail.deploy_at_now" }).click();
    // No force-redeploy or team/problem subset: the host prepares what is not running.
    expect(panel.onBulkDeploy).toHaveBeenCalledWith();
  });

  it("explains that a stopped environment keeps a deploying event from becoming ready", () => {
    render(
      <EventSchedulePanel
        {...props({
          status: "DEPLOYING",
          deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status: "STOPPED" }] },
        })}
      />,
    );
    expect(screen.getByText("local_host.deploy_stopped_hint")).toBeInTheDocument();
  });

  it("offers teardown while environments are owned", () => {
    expect(
      teardownButton({
        status: "READY",
        deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status: "COMPLETE" }] },
      }),
    ).toBe(false);
  });

  it("disables teardown for an archived or fully removed event, as the host refuses both", () => {
    expect(
      teardownButton({
        status: "ARCHIVED",
        deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status: "DELETED" }] },
      }),
    ).toBe(true);
    expect(
      teardownButton({
        status: "TEARDOWN",
        deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status: "DELETED" }] },
      }),
    ).toBe(true);
    expect(
      teardownButton({
        status: "TEARDOWN",
        deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status: "FAILED" }] },
      }),
    ).toBe(false);
  });
});
