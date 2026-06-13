import { act, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
} from "../api/portal-client";
import { I18nProvider } from "../i18n";
import {
  buildAutoDeleteNotice,
  classifyCodeBuildLog,
  describeProblemKind,
  formatTerminalTime,
  getCompleteFlagScoring,
  getCompleteMultiFlagScoring,
  isStaleProblem,
  isUptimeScoring,
  mergeLiveDeployLog,
  ProblemPanel,
  selectDisplayedDeployLog,
  shouldShowAutoRefreshNote,
} from "./ProblemPanel";
import {
  formatProblemPanelActionError,
  shouldRefreshAfterFlagSubmit,
} from "./ProblemPanel.helpers";

const apiMocks = vi.hoisted(() => ({
  getDeployLogs: vi.fn(),
}));

vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, getDeployLogs: apiMocks.getDeployLogs };
});
// FlagSubmissionPanel は #1480 で別途 100% 済。 ここでは ProblemPanel の flag 分岐だけ pin。
vi.mock("./ProblemPanelFlagSubmission", () => ({
  FlagSubmissionPanel: () => <div data-testid="flag-panel" />,
}));
// MultiFlagSubmissionPanel は別 test (#1796) で網羅。 ここでは ProblemPanel の分岐だけ pin。
vi.mock("./MultiFlagSubmissionPanel", () => ({
  MultiFlagSubmissionPanel: () => <div data-testid="multi-flag-panel" />,
}));

function withI18n(node: React.ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

const echoT = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const baseProblem: ParticipantProblemView = {
  jobId: "JOB1",
  problemId: "hello-world",
  region: "ap-northeast-1",
  awsAccountId: "999999999999",
  status: "IN_PROGRESS",
  stackOutputs: {},
  expiresAt: 9_999_999_999,
  score: 0,
  deployLog: {
    cursor: "2026-05-04T15:02:00.000Z",
    entries: [
      {
        id: "queued",
        timestamp: "2026-05-04T15:00:00.000Z",
        source: "deployment",
        level: "info",
        message: "Deployment job was queued.",
      },
      {
        id: "cfn",
        timestamp: "2026-05-04T15:02:00.000Z",
        source: "deployment",
        level: "info",
        message: "CloudFormation stack creation is in progress.",
      },
    ],
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ProblemPanel deploy terminal", () => {
  beforeEach(() => {
    apiMocks.getDeployLogs.mockReset();
    apiMocks.getDeployLogs.mockRejectedValue(new Error("not configured"));
  });

  it("should display deployLog terminal entries", () => {
    render(
      withI18n(
        <ProblemPanel
          problem={baseProblem}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );

    expect(screen.getByText(/Deployment terminal|デプロイ terminal/)).toBeInTheDocument();
    expect(screen.getByText("Deployment job was queued.")).toBeInTheDocument();
    expect(screen.getByText("CloudFormation stack creation is in progress.")).toBeInTheDocument();
  });

  it("should fetch CodeBuild live logs and display them in the terminal for non-terminal status", async () => {
    apiMocks.getDeployLogs.mockResolvedValueOnce({
      jobId: baseProblem.jobId,
      buildStatus: "IN_PROGRESS",
      complete: false,
      nextToken: "next",
      entries: [
        {
          id: "codebuild-1",
          timestamp: "2026-05-20T10:00:00.000Z",
          source: "codebuild",
          message: "CodeBuild install phase complete",
        },
      ],
    });

    render(
      withI18n(
        <ProblemPanel
          problem={baseProblem}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );

    expect(await screen.findByText("CodeBuild install phase complete")).toBeInTheDocument();
    expect(apiMocks.getDeployLogs).toHaveBeenCalledWith(
      "https://api.example.com",
      "team-key",
      baseProblem.jobId,
      { nextToken: undefined, limit: 50 },
    );
  });

  it("should display the remaining time until auto-delete based on expiresAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    render(
      withI18n(
        <ProblemPanel
          problem={{
            ...baseProblem,
            expiresAt: Math.floor(new Date("2026-05-20T00:14:00.000Z").getTime() / 1000),
          }}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );

    expect(screen.getByText(/Auto-delete scheduled|自動削除予定/)).toBeInTheDocument();
    expect(screen.getByText(/14/)).toBeInTheDocument();
    expect(screen.getByText(/teardown/)).toBeInTheDocument();
  });

  it("should display AUTO_DELETED status as stopped", () => {
    render(
      withI18n(
        <ProblemPanel
          problem={{ ...baseProblem, status: "AUTO_DELETED" }}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );

    expect(screen.getByText(/Auto-deleted|自動削除済み/)).toBeInTheDocument();
  });
});

describe("ProblemPanel submit helpers", () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params?.errorCode ? `${key}:${params.errorCode}` : key;

  it("should mark ok / already_scored as score refresh targets", () => {
    expect(shouldRefreshAfterFlagSubmit({ kind: "ok", scoreDelta: 10, totalScore: 20 })).toBe(true);
    expect(shouldRefreshAfterFlagSubmit({ kind: "already_scored", totalScore: 20 })).toBe(true);
    expect(
      shouldRefreshAfterFlagSubmit({
        kind: "wrong",
        scoreDelta: 0,
        totalScore: 10,
        wrongCount: 1,
      }),
    ).toBe(false);
  });

  it("should format scoring gate errors into user-facing text", () => {
    expect(
      formatProblemPanelActionError(
        t,
        new PortalScoringGateError("scoring_locked"),
        "problem_panel.validation_error",
      ),
    ).toBe("problem_panel.scoring_gate_paused");
  });

  it("should format validation errors into text using the specified key with errorCode", () => {
    expect(
      formatProblemPanelActionError(
        t,
        new PortalValidationError("invalid_flag"),
        "problem_panel.submit_error_prefix",
      ),
    ).toBe("problem_panel.submit_error_prefix:invalid_flag");
  });

  it("should stringify non-Error values", () => {
    expect(formatProblemPanelActionError(t, "boom", "problem_panel.validation_error")).toBe("boom");
  });
});

describe("ProblemPanel pure helpers", () => {
  it("should classify CodeBuild log levels by keyword", () => {
    expect(classifyCodeBuildLog("an error occurred")).toBe("error");
    expect(classifyCodeBuildLog("build succeeded")).toBe("success");
    expect(classifyCodeBuildLog("a warning here")).toBe("warning");
    expect(classifyCodeBuildLog("informational line")).toBe("info");
  });

  it("should format terminal timestamps and fall back for invalid input", () => {
    expect(formatTerminalTime("not-a-date")).toBe("--:--:--");
    expect(formatTerminalTime("2026-05-20T10:30:45.000Z")).not.toBe("--:--:--");
  });

  it("should merge live deploy logs, dedup by id, classify, and cap at 200", () => {
    const merged = mergeLiveDeployLog(
      {
        cursor: "c0",
        entries: [{ id: "a", timestamp: "t", source: "codebuild", level: "info", message: "old" }],
      },
      {
        jobId: "j",
        buildStatus: "IN_PROGRESS",
        complete: false,
        nextToken: "c1",
        // "a" は既出 → skip、 "b" は新規 (error 分類)。
        entries: [
          { id: "a", timestamp: "t", source: "codebuild", message: "dup" },
          { id: "b", timestamp: "t", source: "codebuild", message: "fatal error" },
        ],
      },
    );
    expect(merged.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(merged.entries[1]?.level).toBe("error");
    expect(merged.cursor).toBe("c1");
    // nextToken 無し → prev.cursor に fall back。
    expect(
      mergeLiveDeployLog(
        { cursor: "keep", entries: [] },
        { jobId: "j", buildStatus: "IN_PROGRESS", complete: true, entries: [] },
      ).cursor,
    ).toBe("keep");
    // nextToken も prev も無し → "" に fall back。
    expect(
      mergeLiveDeployLog(null, {
        jobId: "j",
        buildStatus: "IN_PROGRESS",
        complete: true,
        entries: [],
      }).cursor,
    ).toBe("");
  });

  it("should build the auto-delete notice for expired / soon / far / invalid expiry", () => {
    const now = new Date("2026-05-20T00:00:00.000Z").getTime();
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    expect(buildAutoDeleteNotice(echoT, 0, now)).toBeUndefined();
    expect(buildAutoDeleteNotice(echoT, Number.NaN, now)).toBeUndefined();
    expect(buildAutoDeleteNotice(echoT, at("2026-05-19T23:00:00.000Z"), now)?.body).toContain(
      "problem_panel.auto_delete_expired_body",
    );
    expect(buildAutoDeleteNotice(echoT, at("2026-05-20T00:10:00.000Z"), now)?.body).toContain(
      "problem_panel.auto_delete_soon_body",
    );
    expect(buildAutoDeleteNotice(echoT, at("2026-05-20T05:00:00.000Z"), now)).toBeUndefined();
  });

  it("should describe each scoring kind", () => {
    expect(describeProblemKind(echoT, undefined)).toBe("problem_panel.kind_unknown");
    expect(describeProblemKind(echoT, { kind: "flag" })).toBe("problem_panel.kind_flag");
    expect(describeProblemKind(echoT, { kind: "multi-flag" })).toBe(
      "problem_panel.kind_multi_flag",
    );
    expect(describeProblemKind(echoT, { kind: "uptime-flat" })).toBe("problem_panel.kind_uptime");
    expect(describeProblemKind(echoT, { kind: "phased-polling" })).toBe(
      "problem_panel.kind_phased",
    );
    expect(describeProblemKind(echoT, { kind: "attack-detection" })).toBe(
      "problem_panel.kind_attack",
    );
    expect(describeProblemKind(echoT, { kind: "mystery" } as never)).toBe(
      "problem_panel.kind_unknown",
    );
  });

  it("should classify uptime vs flag scoring", () => {
    expect(isUptimeScoring(undefined)).toBe(false);
    expect(isUptimeScoring({ kind: "flag" })).toBe(false);
    // multi-flag も Challenge 軸 (= 提出型) なので uptime とは扱わない。
    expect(isUptimeScoring({ kind: "multi-flag" })).toBe(false);
    expect(isUptimeScoring({ kind: "uptime" })).toBe(true);
  });

  it("should flag stale uptime problems only", () => {
    const old = "2026-05-19T00:00:00.000Z";
    const now = new Date("2026-05-20T00:00:00.000Z").getTime();
    const p = (over: Partial<ParticipantProblemView>) => ({ ...baseProblem, ...over });
    expect(
      isStaleProblem(
        p({ status: "COMPLETE", scoring: { kind: "uptime" }, lastScoredAt: old }),
        now,
      ),
    ).toBe(true);
    expect(
      isStaleProblem(p({ status: "COMPLETE", scoring: { kind: "flag" }, lastScoredAt: old }), now),
    ).toBe(false);
    expect(
      isStaleProblem(
        p({ status: "IN_PROGRESS", scoring: { kind: "uptime" }, lastScoredAt: old }),
        now,
      ),
    ).toBe(false);
    expect(isStaleProblem(p({ status: "COMPLETE", scoring: { kind: "uptime" } }), now)).toBe(false); // no lastScoredAt
  });

  it("should resolve a complete flag scoring only when COMPLETE + flag", () => {
    const p = (over: Partial<ParticipantProblemView>) => ({ ...baseProblem, ...over });
    expect(
      getCompleteFlagScoring(p({ status: "COMPLETE", scoring: { kind: "flag" } })),
    ).toBeDefined();
    expect(
      getCompleteFlagScoring(p({ status: "IN_PROGRESS", scoring: { kind: "flag" } })),
    ).toBeUndefined();
    expect(
      getCompleteFlagScoring(p({ status: "COMPLETE", scoring: { kind: "uptime" } })),
    ).toBeUndefined();
  });

  it("should resolve a complete multi-flag scoring only when COMPLETE + multi-flag", () => {
    const p = (over: Partial<ParticipantProblemView>) => ({ ...baseProblem, ...over });
    expect(
      getCompleteMultiFlagScoring(p({ status: "COMPLETE", scoring: { kind: "multi-flag" } })),
    ).toBeDefined();
    expect(
      getCompleteMultiFlagScoring(p({ status: "IN_PROGRESS", scoring: { kind: "multi-flag" } })),
    ).toBeUndefined();
    expect(
      getCompleteMultiFlagScoring(p({ status: "COMPLETE", scoring: { kind: "flag" } })),
    ).toBeUndefined();
  });

  it("should prefer live logs only when they have entries", () => {
    const deployLog = {
      cursor: "d",
      entries: [
        {
          id: "x",
          timestamp: "t",
          source: "deployment" as const,
          level: "info" as const,
          message: "m",
        },
      ],
    };
    const live = {
      cursor: "l",
      entries: [
        {
          id: "y",
          timestamp: "t",
          source: "codebuild" as const,
          level: "info" as const,
          message: "live",
        },
      ],
    };
    expect(selectDisplayedDeployLog(live, deployLog)).toBe(live);
    expect(selectDisplayedDeployLog(null, deployLog)).toBe(deployLog);
    expect(selectDisplayedDeployLog({ cursor: "l", entries: [] }, deployLog)).toBe(deployLog);
  });

  it("should show the auto-refresh note only for non-terminal statuses", () => {
    expect(shouldShowAutoRefreshNote("IN_PROGRESS")).toBe(true);
    expect(shouldShowAutoRefreshNote("COMPLETE")).toBe(false);
  });
});

describe("ProblemPanel render branches", () => {
  const renderPanel = (over: Partial<ParticipantProblemView>) =>
    render(
      withI18n(
        <ProblemPanel
          problem={{ ...baseProblem, ...over }}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );

  beforeEach(() => {
    apiMocks.getDeployLogs.mockReset();
    apiMocks.getDeployLogs.mockRejectedValue(new Error("not configured"));
  });

  it("should show the failure reason for FAILED deploys", () => {
    renderPanel({ status: "FAILED", failureReason: "stack rollback" });
    expect(screen.getByText("stack rollback")).toBeInTheDocument();
  });

  it("should show a stale warning for an uptime problem with an old lastScoredAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "uptime" },
      lastScoredAt: "2026-05-19T00:00:00.000Z",
    });
    expect(screen.getByText(/Stalled|停滞|scoring/i)).toBeInTheDocument();
  });

  it("should render the flag submission panel for a COMPLETE flag problem", () => {
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "flag", flagSubmitted: false, points: 100 },
    });
    expect(screen.getByTestId("flag-panel")).toBeInTheDocument();
  });

  it("should render the multi-flag submission panel for a COMPLETE multi-flag problem", () => {
    renderPanel({
      status: "COMPLETE",
      scoring: {
        kind: "multi-flag",
        points: 500,
        flags: [
          { id: "ep01", label: "Ep01", points: 300, solved: false },
          { id: "ep02", label: "Ep02", points: 200, solved: false },
        ],
      },
    });
    expect(screen.getByTestId("multi-flag-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("flag-panel")).not.toBeInTheDocument();
  });

  it("should render the multi-flag panel even when flags is omitted", () => {
    // scoring.flags 不在でも panel は出す (= `flags ?? []` の fallback 分岐を pin)。
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "multi-flag", points: 0 },
    });
    expect(screen.getByTestId("multi-flag-panel")).toBeInTheDocument();
  });

  it("should render stack outputs as a link for URLs and plain code otherwise", () => {
    renderPanel({
      status: "COMPLETE",
      stackOutputs: { SiteUrl: "https://app.example.com", RoleArn: "arn:aws:iam::1:role/x" },
    });
    const link = screen.getByRole("link", { name: "https://app.example.com" });
    expect(link).toHaveAttribute("href", "https://app.example.com");
    expect(screen.getByText("arn:aws:iam::1:role/x")).toBeInTheDocument();
  });

  it("should show the auto-refresh note while non-terminal and hide it when terminal", () => {
    const a = renderPanel({ status: "IN_PROGRESS" });
    expect(a.getByText(/auto_refresh_note|自動|Auto-refresh/i)).toBeInTheDocument();
    a.unmount();
    const b = renderPanel({ status: "COMPLETE", stackOutputs: {} });
    expect(b.queryByText(/Auto-refresh every/i)).not.toBeInTheDocument();
  });

  it("should pass ?? defaults to the flag panel when optional fields are absent", () => {
    renderPanel({ status: "COMPLETE", scoring: { kind: "flag" } });
    expect(screen.getByTestId("flag-panel")).toBeInTheDocument();
  });
});

describe("ProblemPanel live-log + countdown polling", () => {
  const renderPanel = (over: Partial<ParticipantProblemView>) =>
    render(
      withI18n(
        <ProblemPanel
          problem={{ ...baseProblem, ...over }}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );
  const logResponse = (over: Record<string, unknown>) => ({
    jobId: "JOB1",
    buildStatus: "IN_PROGRESS",
    complete: false,
    nextToken: "n",
    entries: [
      { id: "c1", timestamp: "2026-05-20T10:00:00.000Z", source: "codebuild", message: "phase" },
    ],
    ...over,
  });

  afterEach(() => {
    vi.useRealTimers();
    apiMocks.getDeployLogs.mockReset();
  });

  it("should stop polling once the deploy-log response is complete", async () => {
    apiMocks.getDeployLogs.mockResolvedValue(logResponse({ complete: true }));
    renderPanel({ status: "IN_PROGRESS" });
    expect(await screen.findByText("phase")).toBeInTheDocument();
  });

  it("should keep polling on the interval while still incomplete", async () => {
    vi.useFakeTimers();
    apiMocks.getDeployLogs.mockResolvedValue(logResponse({ complete: false }));
    renderPanel({ status: "IN_PROGRESS" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000); // interval fires a second poll
    });
    expect(apiMocks.getDeployLogs.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("should not re-poll on the interval once the first response completes", async () => {
    vi.useFakeTimers();
    apiMocks.getDeployLogs.mockResolvedValue(logResponse({ complete: true }));
    renderPanel({ status: "IN_PROGRESS" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // mount poll → complete → cancelled
    });
    const callsAfterComplete = apiMocks.getDeployLogs.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000); // interval sees cancelled → skip (if (!cancelled) false)
    });
    expect(apiMocks.getDeployLogs.mock.calls.length).toBe(callsAfterComplete);
  });

  it("should re-evaluate the countdown on the refresh interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
    renderPanel({ status: "COMPLETE", stackOutputs: {} }); // terminal → no deploy poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000); // useNowMs tick
    });
    expect(screen.getByText("hello-world")).toBeInTheDocument(); // still rendered, no crash
  });

  it("should ignore a deploy-log response that resolves after unmount", async () => {
    let resolveLogs: (v: unknown) => void = () => undefined;
    apiMocks.getDeployLogs.mockReturnValue(
      new Promise((r) => {
        resolveLogs = r;
      }),
    );
    const { unmount } = renderPanel({ status: "IN_PROGRESS" });
    expect(apiMocks.getDeployLogs).toHaveBeenCalled();
    unmount(); // cleanup sets cancelled = true
    await act(async () => {
      resolveLogs(logResponse({ complete: false }));
      await Promise.resolve();
    });
    // poll's post-await `if (cancelled) return` swallows the late response (no throw).
  });
});
