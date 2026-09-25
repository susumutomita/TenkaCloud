import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../src/api/client";
import type { EventDetail } from "../../../src/api/events-client";
import {
  allowedLocalOperations,
  LocalEnvironmentsPanel,
} from "../../../src/components/event-detail/LocalEnvironmentsPanel";

const mocks = vi.hoisted(() => ({ operateLocalEnvironment: vi.fn() }));
vi.mock("../../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/events-client")>();
  return { ...actual, operateLocalEnvironment: mocks.operateLocalEnvironment };
});

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

function detail(status: EventDetail["status"] = "READY"): EventDetail {
  return {
    eventId: "01J00000000000000000000000",
    name: "Local",
    status,
    teamCount: 2,
    problemCount: 1,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    expiresAt: 0,
    teams: [
      { teamId: "A", internalSlug: "team-a" },
      { teamId: "B", internalSlug: "team-b" },
    ],
    problems: [{ problemId: "sqli-demo", defaultRegion: "local" }],
    deploymentsByProblem: {
      "sqli-demo": [
        { jobId: "JOB-A", teamId: "A", status: "COMPLETE", gatewayPort: 5200 },
        {
          jobId: "JOB-B",
          teamId: "B",
          status: "FAILED",
          error: "Docker daemon is unavailable.",
        },
      ],
    },
  };
}

afterEach(() => vi.clearAllMocks());

const apiClient = createApiClient("http://127.0.0.1:5174/api", "a.e30.c");

describe("allowedLocalOperations", () => {
  it("mirrors the host's rules for each environment state", () => {
    expect(allowedLocalOperations("READY", { status: "COMPLETE" })).toEqual({
      stop: true,
      restart: true,
      teardown: true,
    });
    expect(allowedLocalOperations("READY", { status: "STOPPED" })).toEqual({
      stop: false,
      restart: true,
      teardown: true,
    });
    expect(allowedLocalOperations("ENDED", { status: "COMPLETE" })).toEqual({
      stop: true,
      restart: false,
      teardown: true,
    });
    expect(allowedLocalOperations("READY", { status: "DELETED" }).teardown).toBe(false);
    expect(allowedLocalOperations("ARCHIVED", { status: "FAILED" }).teardown).toBe(false);
    for (const blocked of [
      { status: "IN_PROGRESS" as const },
      { status: "COMPLETE" as const, operation: "stop" as const },
    ])
      expect(allowedLocalOperations("READY", blocked)).toEqual({
        stop: false,
        restart: false,
        teardown: false,
      });
  });
});

describe("LocalEnvironmentsPanel", () => {
  it("lists each team's environment with its gateway port and failure reason", () => {
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant
        detail={detail()}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    const rowA = screen.getByText("team-a").closest("tr");
    if (!rowA) throw new Error("team-a row is missing");
    expect(within(rowA).getByText("5200")).toBeInTheDocument();
    expect(within(rowA).getByText("local_host.env_status_COMPLETE")).toBeInTheDocument();
    expect(screen.getByText("Docker daemon is unavailable.")).toBeInTheDocument();
  });

  it("operates exactly the chosen team's environment and refreshes", async () => {
    mocks.operateLocalEnvironment.mockResolvedValue({});
    const onRefresh = vi.fn();
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant
        detail={detail()}
        onRefresh={onRefresh}
        t={t}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'local_host.env_stop_aria|{"team":"team-a"}' }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(mocks.operateLocalEnvironment).toHaveBeenCalledWith(
      apiClient,
      "01J00000000000000000000000",
      "JOB-A",
      "stop",
    );
    // A failed environment cannot be stopped, only restarted or torn down.
    expect(
      screen.getByRole("button", { name: 'local_host.env_stop_aria|{"team":"team-b"}' }),
    ).toBeDisabled();
  });

  it("asks before tearing down and reports a refused operation", async () => {
    mocks.operateLocalEnvironment.mockRejectedValue(new Error("busy"));
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant
        detail={detail()}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'local_host.env_teardown_aria|{"team":"team-b"}' }),
    );
    expect(mocks.operateLocalEnvironment).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "local_host.env_teardown" }));
    await waitFor(() =>
      expect(
        screen.getByText('local_host.env_operation_failed|{"team":"team-b","reason":"busy"}'),
      ).toBeInTheDocument(),
    );
    expect(mocks.operateLocalEnvironment).toHaveBeenCalledWith(
      apiClient,
      "01J00000000000000000000000",
      "JOB-B",
      "teardown",
    );
  });

  it("lets the organizer back out of a teardown and dismiss a refusal", async () => {
    mocks.operateLocalEnvironment.mockRejectedValue(new Error("busy"));
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant
        detail={detail()}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'local_host.env_teardown_aria|{"team":"team-a"}' }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "event_detail.modal_cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.operateLocalEnvironment).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: 'local_host.env_stop_aria|{"team":"team-a"}' }),
    );
    await screen.findByText(/local_host.env_operation_failed/u);
    const dismiss = createWrapper(document.body).findAlert()?.findDismissButton();
    if (!dismiss) throw new Error("The refusal cannot be dismissed.");
    dismiss.click();
    await waitFor(() => expect(screen.queryByText(/local_host.env_operation_failed/u)).toBeNull());
  });

  it("restarts a failed environment", async () => {
    mocks.operateLocalEnvironment.mockResolvedValue({});
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant
        detail={detail()}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: 'local_host.env_restart_aria|{"team":"team-b"}' }),
    );
    await waitFor(() =>
      expect(mocks.operateLocalEnvironment).toHaveBeenCalledWith(
        apiClient,
        "01J00000000000000000000000",
        "JOB-B",
        "restart",
      ),
    );
  });

  it("still lists an environment whose team is not in the event's team list", () => {
    const orphan = detail();
    orphan.deploymentsByProblem = {
      "sqli-demo": [{ jobId: "JOB-X", teamId: "UNKNOWN-TEAM", status: "FAILED" }],
    };
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant
        detail={orphan}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    expect(screen.getByText("UNKNOWN-TEAM")).toBeInTheDocument();
  });

  it("shows operations in progress and disables everything without permission", () => {
    const busy = detail();
    busy.deploymentsByProblem = {
      "sqli-demo": [{ jobId: "JOB-A", teamId: "A", status: "COMPLETE", operation: "restart" }],
    };
    render(
      <LocalEnvironmentsPanel
        apiClient={apiClient}
        canMutateTenant={false}
        detail={busy}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    expect(screen.getByText("local_host.env_operation_restart")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /aria/u }))
      expect(button).toBeDisabled();
  });
});

describe("operateLocalEnvironment", () => {
  it("addresses exactly one environment of one event", async () => {
    const { operateLocalEnvironment } = await vi.importActual<
      typeof import("../../../src/api/events-client")
    >("../../../src/api/events-client");
    const post = vi.fn().mockResolvedValue({ operation: "stop" });
    const delJson = vi.fn().mockResolvedValue({ operation: "teardown" });
    const client = { ...apiClient, post, delJson };
    await operateLocalEnvironment(client, "EVENT/1", "JOB 1", "stop");
    await operateLocalEnvironment(client, "EVENT/1", "JOB 1", "restart");
    await operateLocalEnvironment(client, "EVENT/1", "JOB 1", "teardown");
    expect(post).toHaveBeenNthCalledWith(1, "events/EVENT%2F1/deployments/JOB%201/stop", {});
    expect(post).toHaveBeenNthCalledWith(2, "events/EVENT%2F1/deployments/JOB%201/restart", {});
    expect(delJson).toHaveBeenCalledWith("events/EVENT%2F1/deployments/JOB%201");
  });
});

describe("LOCAL_HOST_BUILD", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__TENKACLOUD_LOCAL_HOST_BUILD__");
    vi.resetModules();
  });
  it("is on only when the build replaces the constant with a literal true", async () => {
    vi.resetModules();
    expect((await import("../../../src/local-host-build")).LOCAL_HOST_BUILD).toBe(false);
    Reflect.set(globalThis, "__TENKACLOUD_LOCAL_HOST_BUILD__", "true");
    vi.resetModules();
    expect((await import("../../../src/local-host-build")).LOCAL_HOST_BUILD).toBe(false);
    Reflect.set(globalThis, "__TENKACLOUD_LOCAL_HOST_BUILD__", true);
    vi.resetModules();
    expect((await import("../../../src/local-host-build")).LOCAL_HOST_BUILD).toBe(true);
  });
});
