import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { ProblemPanel } from "./ProblemPanel";

/**
 * [#2392 Phase 2] local-play on-demand container lifecycle の ProblemPanel 分岐を pin する。
 *
 * - lifecycle.status = "stopped" / "error" → play surface (access URL / flag panel) を隠して
 *   Start control に差し替える
 * - "starting" → loading indicator のみ
 * - "running" → 既存 play surface + Stop button
 * - lifecycle 不在 (= AWS mode) → 従来挙動そのまま (start/stop 露出なし)
 *
 * startProblem / stopProblem だけ mock し、 i18n / helpers は実物 (locale=en 固定)。
 */

const apiMocks = vi.hoisted(() => ({
  issueProblemConsoleHandoff: vi.fn(),
  resetProblem: vi.fn(),
  startProblem: vi.fn(),
  stopProblem: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return {
    ...actual,
    issueProblemConsoleHandoff: apiMocks.issueProblemConsoleHandoff,
    resetProblem: apiMocks.resetProblem,
    startProblem: apiMocks.startProblem,
    stopProblem: apiMocks.stopProblem,
  };
});

// FlagSubmissionPanel / MultiFlagSubmissionPanel は個別 test で 100% 済。 ここでは
// 「play surface が出る / 差し替わる」 の分岐だけ testid で pin する。
vi.mock("./ProblemPanelFlagSubmission", () => ({
  FlagSubmissionPanel: () => <div data-testid="flag-panel" />,
}));
vi.mock("./MultiFlagSubmissionPanel", () => ({
  MultiFlagSubmissionPanel: () => <div data-testid="multi-flag-panel" />,
}));

function withProviders(node: React.ReactNode) {
  return (
    <AppConfigProvider
      config={{
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Test event",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        cloudMode: "local",
      }}
    >
      <I18nProvider>{node}</I18nProvider>
    </AppConfigProvider>
  );
}

// Local backend shape (#2392): deploy status is always COMPLETE; the container
// state travels in `lifecycle`. A running problem exposes its challenge URL.
const baseProblem: ParticipantProblemView = {
  jobId: "JOB1",
  problemId: "hello-world",
  region: "local",
  awsAccountId: "local",
  status: "COMPLETE",
  stackOutputs: { ChallengeUrl: "https://challenge.example.com" },
  expiresAt: 9_999_999_999,
  score: 0,
  scoring: { kind: "flag", flagSubmitted: false, points: 100 },
  deployLog: { cursor: "", entries: [] },
};

function renderPanel(over: Partial<ParticipantProblemView>, onScored = async () => undefined) {
  return render(
    withProviders(
      <ProblemPanel
        problem={{ ...baseProblem, ...over }}
        apiBaseUrl="https://api.example.com"
        sessionToken="team-key"
        onScored={onScored}
      />,
    ),
  );
}

beforeEach(() => {
  // locale を en に固定して文言 assertion を deterministic にする。
  window.localStorage.setItem("tenkacloud.portal.locale", "en");
  apiMocks.startProblem.mockReset();
  apiMocks.stopProblem.mockReset();
  apiMocks.resetProblem.mockReset();
  apiMocks.issueProblemConsoleHandoff.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ProblemPanel on-demand lifecycle (#2392 Phase 2)", () => {
  it("should replace the play surface with a Start control when the container is stopped", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.startProblem.mockResolvedValue({ status: "running" });
    renderPanel({ lifecycle: { status: "stopped" } }, onScored);

    // Play surface is replaced: no flag panel, no access-URL link, even if outputs leaked.
    expect(screen.queryByTestId("flag-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /challenge\.example\.com/ })).not.toBeInTheDocument();
    // Header status reflects the local runtime, not the deploy job.
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText(/Start it to bring up the challenge endpoints/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(apiMocks.startProblem).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      "hello-world",
    );
    await waitFor(() => expect(onScored).toHaveBeenCalled());
  });

  it("should show a loading indicator without start/stop controls while starting", () => {
    renderPanel({ lifecycle: { status: "starting" } });

    expect(screen.getAllByText("Starting…").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("flag-panel")).not.toBeInTheDocument();
  });

  it("should refresh a starting runtime until its next lifecycle state arrives", async () => {
    vi.useFakeTimers();
    const onScored = vi.fn().mockResolvedValue(undefined);
    renderPanel({ lifecycle: { status: "starting" } }, onScored);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(onScored).toHaveBeenCalledTimes(3);
  });

  it("should surface the error state with a message and a retry Start button", () => {
    renderPanel({ lifecycle: { status: "error" } });

    expect(
      screen.getByText("The problem runtime hit an error. Start it again to retry."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.queryByTestId("flag-panel")).not.toBeInTheDocument();
  });

  it("should show the async start failure reason (lifecycle.lastError) in the error alert", () => {
    // 非同期 start (202) の失敗理由は polling の lifecycle.lastError でだけ届く —
    // 表示されないと学習者は「何もできない」まま原因に辿り着けない。
    renderPanel({
      lifecycle: { status: "error", lastError: "compose build failed: no space left on device" },
    });

    expect(screen.getByText("compose build failed: no space left on device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("should retry retained cleanup from the error state before exposing Start", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.stopProblem
      .mockRejectedValueOnce(new Error("cleanup still failed"))
      .mockResolvedValueOnce({ status: "stopped" });
    renderPanel({ lifecycle: { status: "error", cleanupRequired: true } }, onScored);

    expect(
      screen.getByText(
        "This runtime still owns local resources. Clean it up before starting again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry cleanup" });
    await user.click(retry);
    expect(await screen.findByText("cleanup still failed")).toBeInTheDocument();
    expect(onScored).not.toHaveBeenCalled();

    await user.click(retry);
    await waitFor(() => expect(onScored).toHaveBeenCalledTimes(1));
    expect(apiMocks.stopProblem).toHaveBeenCalledTimes(2);
  });

  it("should keep the play surface and offer a Stop button when running", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.stopProblem.mockResolvedValue({ status: "stopped" });
    renderPanel({ lifecycle: { status: "running" } }, onScored);

    // Current behavior unchanged: flag panel + access URL stay visible.
    expect(screen.getByTestId("flag-panel")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://challenge.example.com" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Simulator Console" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(apiMocks.stopProblem).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      "hello-world",
    );
    await waitFor(() => expect(onScored).toHaveBeenCalled());
  });

  it("should offer Reset and an authenticated console handoff only for a running simulated cloud", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.resetProblem.mockResolvedValue({ status: "running" });
    apiMocks.issueProblemConsoleHandoff.mockResolvedValue(
      "https://api.example.com/portal/me/problems/hello-world/console?ticket=opaque-one-time",
    );
    const replace = vi.fn();
    const close = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      close,
      location: { replace },
      opener: window,
    } as unknown as Window);
    renderPanel(
      {
        lifecycle: { status: "running", runtimeKind: "simulated-cloud" },
        stackOutputs: {
          ChallengeUrl: "https://challenge.example.com",
          SimulatorConsoleUrl: "http://127.0.0.1:4173/world#token=must-not-reach-ui",
          SimulatorAzureCredential: "azure-must-not-reach-ui",
          SimulatorGcpCredential: "gcp-must-not-reach-ui",
          SimulatorSakuraCredential: "sakura-must-not-reach-ui",
          "aws-hello.SimulatorConsoleUrl":
            "http://127.0.0.1:4173/world#token=namespaced-must-not-reach-ui",
          "azure-app.SimulatorAzureCredential": "namespaced-azure-must-not-reach-ui",
        },
      },
      onScored,
    );

    await user.click(screen.getByRole("button", { name: "Open Simulator Console" }));
    expect(apiMocks.issueProblemConsoleHandoff).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      "hello-world",
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "https://api.example.com/portal/me/problems/hello-world/console?ticket=opaque-one-time",
      ),
    );
    expect(close).not.toHaveBeenCalled();
    for (const secret of [
      "must-not-reach-ui",
      "azure-must-not-reach-ui",
      "gcp-must-not-reach-ui",
      "sakura-must-not-reach-ui",
      "namespaced-must-not-reach-ui",
      "namespaced-azure-must-not-reach-ui",
    ]) {
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.innerHTML).not.toContain(secret);
    }

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(apiMocks.resetProblem).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      "hello-world",
    );
    await waitFor(() => expect(onScored).toHaveBeenCalled());
  });

  it("should close a blank popup and surface an authenticated console handoff failure", async () => {
    const user = userEvent.setup();
    apiMocks.issueProblemConsoleHandoff.mockRejectedValue(new Error("handoff failed"));
    const close = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      close,
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window);
    renderPanel({ lifecycle: { status: "running", runtimeKind: "simulated-cloud" } });

    await user.click(screen.getByRole("button", { name: "Open Simulator Console" }));

    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(screen.getByText("handoff failed")).toBeInTheDocument();
  });

  it("should fail loudly when the simulator console popup is blocked", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    renderPanel({ lifecycle: { status: "running", runtimeKind: "simulated-cloud" } });

    await user.click(screen.getByRole("button", { name: "Open Simulator Console" }));

    expect(await screen.findByText("Simulator console popup was blocked")).toBeInTheDocument();
    expect(apiMocks.issueProblemConsoleHandoff).not.toHaveBeenCalled();
  });

  it("should fail loudly when a simulated-cloud reset fails", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.resetProblem.mockRejectedValue(new Error("world deletion failed"));
    renderPanel({ lifecycle: { status: "running", runtimeKind: "simulated-cloud" } }, onScored);

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(await screen.findByText("Simulator operation failed")).toBeInTheDocument();
    expect(screen.getByText("world deletion failed")).toBeInTheDocument();
    expect(onScored).not.toHaveBeenCalled();
  });

  it("should leave problems without a lifecycle field unchanged (AWS mode)", () => {
    renderPanel({ lifecycle: undefined });

    expect(screen.getByTestId("flag-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("should render the multi-flag play surface when running (multi-flag kind)", () => {
    renderPanel({
      lifecycle: { status: "running" },
      scoring: { kind: "multi-flag", points: 500, flags: [] },
    });

    expect(screen.getByTestId("multi-flag-panel")).toBeInTheDocument();
  });

  it("should fail loudly when the local runtime start fails and not refresh", async () => {
    const user = userEvent.setup();
    const onScored = vi.fn().mockResolvedValue(undefined);
    apiMocks.startProblem.mockRejectedValue(new Error("docker: container exited (125)"));
    renderPanel({ lifecycle: { status: "stopped" } }, onScored);

    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Local runtime operation failed")).toBeInTheDocument();
    expect(screen.getByText("docker: container exited (125)")).toBeInTheDocument();
    expect(onScored).not.toHaveBeenCalled();
    // Start stays available for a retry after the failure.
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
});
