import { act, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
} from "../api/portal-client";
import type { CloudMode } from "../config";
import { AppConfigProvider } from "../config-context";
import { I18nProvider } from "../i18n";
import { ProblemPanel } from "./ProblemPanel";
import {
  buildAutoDeleteNotice,
  codespacesLoopbackUrl,
  describeProblemKind,
  formatProblemPanelActionError,
  getCompleteFlagScoring,
  getCompleteMultiFlagScoring,
  hasProblemStatement,
  isHttpUrlOutput,
  isStaleProblem,
  isUptimeScoring,
  resolveProblemTitle,
  shouldRefreshAfterFlagSubmit,
  splitStackOutputs,
} from "./ProblemPanel.helpers";

// FlagSubmissionPanel は #1480 で別途 100% 済。 ここでは ProblemPanel の flag 分岐だけ pin。
vi.mock("./ProblemPanelFlagSubmission", () => ({
  FlagSubmissionPanel: () => <div data-testid="flag-panel" />,
}));
// MultiFlagSubmissionPanel は別 test (#1796) で網羅。 ここでは ProblemPanel の分岐だけ pin。
vi.mock("./MultiFlagSubmissionPanel", () => ({
  MultiFlagSubmissionPanel: () => <div data-testid="multi-flag-panel" />,
}));
vi.mock("./ContainerWorkbenchPanel", () => ({
  ContainerWorkbenchPanel: () => <div data-testid="container-workbench-panel" />,
}));

function withI18n(node: React.ReactNode, cloudMode: CloudMode = "real") {
  return (
    <AppConfigProvider
      config={{
        apiBaseUrl: "https://api.example.com",
        eventTitle: "Test event",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        cloudMode,
      }}
    >
      <I18nProvider>{node}</I18nProvider>
    </AppConfigProvider>
  );
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
  vi.unstubAllGlobals();
});

describe("ProblemPanel deploy log privacy", () => {
  it("should hide deploy job log entries while keeping deployment status visible", () => {
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

    expect(screen.getByText(/Starting|起動中/)).toBeInTheDocument();
    // 各問題の region を明示する (= 「Event region」 1 つだと多リージョン時に混乱する運用 FB)。
    expect(screen.getByText("ap-northeast-1")).toBeInTheDocument();
    expect(screen.queryByText(/Deployment terminal|デプロイ terminal/)).not.toBeInTheDocument();
    expect(screen.queryByText("Deployment job was queued.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("CloudFormation stack creation is in progress."),
    ).not.toBeInTheDocument();
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
  it("should identify HTTP(S) output URLs only", () => {
    expect(isHttpUrlOutput("https://app.example.com")).toBe(true);
    expect(isHttpUrlOutput("http://app.example.com")).toBe(true);
    expect(isHttpUrlOutput("arn:aws:iam::1:role/x")).toBe(false);
    expect(isHttpUrlOutput("/tc/problem/config")).toBe(false);
  });

  it("should split stack outputs into access URLs and detail entries", () => {
    expect(
      splitStackOutputs({
        SiteUrl: "https://app.example.com",
        RoleArn: "arn:aws:iam::1:role/x",
        NamePrefix: "tc-x402-paywall-team-1",
      }),
    ).toEqual({
      accessUrlEntries: [["SiteUrl", "https://app.example.com"]],
      detailEntries: [
        ["RoleArn", "arn:aws:iam::1:role/x"],
        ["NamePrefix", "tc-x402-paywall-team-1"],
      ],
    });
    expect(splitStackOutputs({ NamePrefix: "tc-no-url" })).toEqual({
      accessUrlEntries: [],
      detailEntries: [["NamePrefix", "tc-no-url"]],
    });
  });

  it("should recover the loopback form from the same Codespaces forwarded domain", () => {
    expect(
      codespacesLoopbackUrl(
        "https://demo-18080.app.github.dev/api/profile/1",
        "demo-5175.app.github.dev",
      ),
    ).toBe("http://localhost:18080/api/profile/1");
  });

  it("should preserve the forwarded path and query in the terminal hint", () => {
    expect(
      codespacesLoopbackUrl("https://demo-18080.app.github.dev/", "demo-5175.app.github.dev"),
    ).toBe("http://localhost:18080/");
    expect(
      codespacesLoopbackUrl(
        "https://demo-18080.app.github.dev/search?q=1",
        "demo-5175.app.github.dev",
      ),
    ).toBe("http://localhost:18080/search?q=1");
  });

  it("should reject attacker domains, other codespaces, and malformed ports", () => {
    const portal = "demo-5175.app.github.dev";
    expect(codespacesLoopbackUrl("https://demo-18080.evil.example/x", portal)).toBeUndefined();
    expect(codespacesLoopbackUrl("https://other-18080.app.github.dev/x", portal)).toBeUndefined();
    expect(codespacesLoopbackUrl("http://demo-18080.app.github.dev/x", portal)).toBeUndefined();
    expect(
      codespacesLoopbackUrl("https://operator@demo-18080.app.github.dev/x", portal),
    ).toBeUndefined();
    expect(
      codespacesLoopbackUrl("https://demo-18080.app.github.dev:8443/x", portal),
    ).toBeUndefined();
    expect(codespacesLoopbackUrl("not a url", portal)).toBeUndefined();
    expect(codespacesLoopbackUrl("https://demo-0.app.github.dev/x", portal)).toBeUndefined();
    expect(codespacesLoopbackUrl("https://demo-nope.app.github.dev/x", portal)).toBeUndefined();
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

  it("should use name as the title when present and fall back to problemId otherwise", () => {
    const p = (over: Partial<ParticipantProblemView>) => ({ ...baseProblem, ...over });
    expect(resolveProblemTitle(p({ name: "Hello World" }))).toBe("Hello World");
    // problemId fallback: undefined name and blank/whitespace name.
    expect(resolveProblemTitle(p({ name: undefined }))).toBe("hello-world");
    expect(resolveProblemTitle(p({ name: "   " }))).toBe("hello-world");
  });

  it("should detect a problem statement only when description is non-empty (#2473: instructions alone does not count)", () => {
    const p = (over: Partial<ParticipantProblemView>) => ({ ...baseProblem, ...over });
    expect(hasProblemStatement(p({}))).toBe(false);
    expect(hasProblemStatement(p({ description: "", instructions: "" }))).toBe(false);
    expect(hasProblemStatement(p({ description: "  " }))).toBe(false);
    expect(hasProblemStatement(p({ description: "Solve it" }))).toBe(true);
    // #2473: instructions moved to ProblemInfoSection — instructions alone no longer
    // triggers the problem-statement section (avoids an empty-looking container).
    expect(hasProblemStatement(p({ instructions: "Do A then B" }))).toBe(false);
  });
});

describe("ProblemPanel render branches", () => {
  const renderPanel = (over: Partial<ParticipantProblemView>, cloudMode: CloudMode = "real") =>
    render(
      withI18n(
        <ProblemPanel
          problem={{ ...baseProblem, ...over }}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
        cloudMode,
      ),
    );

  it("should show the failure reason for FAILED deploys", () => {
    renderPanel({ status: "FAILED", failureReason: "stack rollback" });
    expect(screen.getByText("stack rollback")).toBeInTheDocument();
  });

  it("should show the terminal loopback hint for a Codespaces challenge-proxy access URL", () => {
    vi.stubGlobal("location", new URL("https://demo-5175.app.github.dev/"));
    renderPanel({
      stackOutputs: {
        Web: "https://demo-18080.app.github.dev/api/profile/1",
      },
    });
    expect(screen.getByText("http://localhost:18080/api/profile/1")).toBeInTheDocument();
    expect(screen.getByText(/browser-only|ブラウザ専用/)).toBeInTheDocument();
  });

  it("should not show the terminal hint for a plain access URL (local / AWS mode)", () => {
    renderPanel({ stackOutputs: { Web: "http://127.0.0.1:18080/api/profile/1" } });
    expect(screen.queryByText(/browser-only|ブラウザ専用/)).not.toBeInTheDocument();
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

  it("should render the Portal container editor for a running local Docker problem", () => {
    renderPanel(
      {
        status: "COMPLETE",
        lifecycle: { status: "running", runtimeKind: "docker" },
        scoring: {
          kind: "multi-flag",
          points: 60,
          flags: [
            {
              id: "implement",
              label: "Implement",
              points: 60,
              solved: false,
              input: "multiline",
            },
          ],
        },
      },
      "local",
    );
    expect(screen.getByTestId("container-workbench-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("multi-flag-panel")).not.toBeInTheDocument();
  });

  it("should tolerate legacy local multi-flag metadata without a flags list", () => {
    renderPanel(
      {
        status: "COMPLETE",
        lifecycle: { status: "running", runtimeKind: "docker" },
        scoring: { kind: "multi-flag", points: 0 },
      },
      "local",
    );
    expect(screen.getByTestId("container-workbench-panel")).toBeInTheDocument();
  });

  it("should keep the intro tutorial focused by hiding its long statement and deployment facts", () => {
    renderPanel({
      problemId: "what-is-tenkacloud",
      status: "COMPLETE",
      description: "Battle Lite SaaS Always-On Docker Codespaces DynamoDB Turso",
      scoring: {
        kind: "multi-flag",
        points: 100,
        flags: [{ id: "first-flag", label: "Step 4", points: 100, solved: false }],
      },
    });
    expect(screen.getByTestId("multi-flag-panel")).toBeInTheDocument();
    expect(screen.queryByText(/Battle Lite SaaS/)).not.toBeInTheDocument();
    expect(screen.queryByText("ap-northeast-1")).not.toBeInTheDocument();
  });

  it("should expose a same-origin practice endpoint for the intro tutorial", () => {
    renderPanel({
      problemId: "what-is-tenkacloud",
      status: "COMPLETE",
      scoring: {
        kind: "multi-flag",
        points: 200,
        flags: [
          { id: "open-endpoint", label: "Step 5", points: 100, solved: false },
          { id: "first-flag", label: "Step 6", points: 100, solved: false },
        ],
      },
    });

    const link = screen.getByRole("link", { name: /onboarding-practice\.html/ });
    expect(link).toHaveAttribute("href", expect.stringMatching(/\/onboarding-practice\.html$/));
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("should render the multi-flag panel even when flags is omitted", () => {
    // scoring.flags 不在でも panel は出す (= `flags ?? []` の fallback 分岐を pin)。
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "multi-flag", points: 0 },
    });
    expect(screen.getByTestId("multi-flag-panel")).toBeInTheDocument();
  });

  it("renders a released writeup and omits the section when the API withholds it", () => {
    const { unmount } = renderPanel({ writeup: "原因と根本対策" }, "local");
    expect(screen.getByText("原因と根本対策")).toBeInTheDocument();
    expect(screen.getByText(/Explanation and remediation|解説と対策/)).toBeInTheDocument();
    // Local mode shows the pointer to the tenka-drill skill (no AI runs in the portal).
    expect(screen.getByText(/\/tenka-drill hello-world/)).toBeInTheDocument();
    unmount();

    renderPanel({ writeup: undefined }, "local");
    expect(screen.queryByText(/Explanation and remediation|解説と対策/)).not.toBeInTheDocument();
    // The pointer only lives inside the writeup panel, so it is gone too.
    expect(screen.queryByText(/tenka-drill/)).not.toBeInTheDocument();
  });

  it("renders the writeup's markdown heading as a real heading, not literal `## ` text (#2473)", () => {
    renderPanel({ writeup: "## 何が起きていたか\n\n原因の説明。" }, "local");
    expect(screen.getByRole("heading", { name: "何が起きていたか" })).toBeInTheDocument();
    expect(screen.queryByText(/^##\s/)).not.toBeInTheDocument();
  });

  it("hides the tenka-drill pointer on the cloud side (writeup shows, pointer does not)", () => {
    // Cloud releases writeups post-event; an AWS competitor has no local repo/skill.
    renderPanel({ writeup: "原因と根本対策" }, "real");
    expect(screen.getByText("原因と根本対策")).toBeInTheDocument();
    expect(screen.queryByText(/tenka-drill/)).not.toBeInTheDocument();
  });

  it("should render URL outputs in the access panel and move internal outputs to details", () => {
    renderPanel({
      status: "COMPLETE",
      stackOutputs: {
        SiteUrl: "https://app.example.com",
        RoleArn: "arn:aws:iam::1:role/x",
        NamePrefix: "tc-x402-paywall-team-1",
      },
    });
    const link = screen.getByRole("link", { name: "https://app.example.com" });
    expect(link).toHaveAttribute("href", "https://app.example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Deployment outputs/ }));
    expect(screen.getByText("arn:aws:iam::1:role/x")).toBeInTheDocument();
    expect(screen.getByText("tc-x402-paywall-team-1")).toBeInTheDocument();
  });

  it("should fall back to details only when stack outputs have no URLs", () => {
    renderPanel({
      status: "COMPLETE",
      stackOutputs: {
        NamePrefix: "tc-no-url",
        EndpointParameterName: "/tc-no-url/endpoint",
      },
    });

    expect(screen.queryByText(/Access URLs|アクセス先 URL/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deployment outputs/ }));
    expect(screen.getByText("tc-no-url")).toBeInTheDocument();
    expect(screen.getByText("/tc-no-url/endpoint")).toBeInTheDocument();
  });

  it("should not render the old auto-refresh note while non-terminal", () => {
    renderPanel({ status: "IN_PROGRESS" });
    expect(screen.queryByText(/auto_refresh_note|自動更新|Auto-refresh/i)).not.toBeInTheDocument();
  });

  it("should pass ?? defaults to the flag panel when optional fields are absent", () => {
    renderPanel({ status: "COMPLETE", scoring: { kind: "flag" } });
    expect(screen.getByTestId("flag-panel")).toBeInTheDocument();
  });

  it("should surface the aggregate service health for an uptime problem (#1917)", () => {
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "uptime" },
      applicationStatus: { overall: "down", healthyCount: 0, totalCount: 3 },
    });
    expect(screen.getByText(/Service health|サービス状態/)).toBeInTheDocument();
    // 集約 health のみ (per-endpoint URL/名前は出さない); 「停止 (0/3)」 で減点理由が読める。
    expect(screen.getByText(/Down|停止/)).toBeInTheDocument();
    expect(screen.getByText(/0\/3/)).toBeInTheDocument();
  });

  it("should omit the service health row when no applicationStatus is present", () => {
    renderPanel({ status: "COMPLETE", scoring: { kind: "flag" } });
    expect(screen.queryByText(/Service health|サービス状態/)).not.toBeInTheDocument();
  });

  it("should surface why a green app scores less via the attack-probe panel (#2422)", () => {
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "uptime-multi", pointsAllOk: 100 },
      applicationStatus: { overall: "healthy", healthyCount: 2, totalCount: 2 },
      attackProbeStatus: {
        checkedAt: "2026-07-07T00:00:00.000Z",
        probes: [
          {
            outcome: "landed",
            penalty: 60,
            label: "Auth bypass",
            symptom: "still accepts a login",
          },
          { outcome: "blocked", penalty: 30 },
        ],
      },
    });
    // Green (healthy 2/2) but the section explains the deduction: a probe is still landing.
    expect(screen.getByText(/Attack probe results|攻撃 probe の結果/)).toBeInTheDocument();
    expect(screen.getByText(/Auth bypass/)).toBeInTheDocument();
    expect(screen.getByText(/still accepts a login/)).toBeInTheDocument();
    // summary indicates 1 of 2 probes still landing.
    expect(screen.getByText(/1 of 2|2 件中 1 件/)).toBeInTheDocument();
    // the blocked probe falls back to an index-numbered name (no author label).
    expect(screen.getByText(/Attack probe 2|攻撃 probe 2/)).toBeInTheDocument();
  });

  it("should show an all-clear attack-probe summary when nothing lands (#2422)", () => {
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "uptime-multi", pointsAllOk: 100 },
      attackProbeStatus: {
        probes: [
          { outcome: "blocked", penalty: 30, label: "SQLi probe" },
          { outcome: "skipped", penalty: 10 },
        ],
      },
    });
    expect(screen.getByText(/All 2 probes blocked|2 件すべて防御/)).toBeInTheDocument();
    expect(screen.getByText(/SQLi probe/)).toBeInTheDocument();
  });

  it("should omit the attack-probe panel when the snapshot is absent or empty (#2422)", () => {
    const { unmount } = renderPanel({ status: "COMPLETE", scoring: { kind: "uptime-multi" } });
    expect(screen.queryByText(/Attack probe results|攻撃 probe の結果/)).not.toBeInTheDocument();
    unmount();
    renderPanel({
      status: "COMPLETE",
      scoring: { kind: "uptime-multi" },
      attackProbeStatus: { probes: [] },
    });
    expect(screen.queryByText(/Attack probe results|攻撃 probe の結果/)).not.toBeInTheDocument();
  });

  it("should render the name as the panel title when present (#1975)", () => {
    renderPanel({ name: "Reachability Check", problemId: "net-evo-01" });
    expect(screen.getByText("Reachability Check")).toBeInTheDocument();
    expect(screen.queryByText("net-evo-01")).not.toBeInTheDocument();
  });

  it("should render the description as markdown, with headings as real headings (#2473)", () => {
    renderPanel({
      name: "Reachability Check",
      description: "## Overview\n\nMake the endpoint reachable.",
      instructions: "Step 1\nStep 2",
    });
    expect(screen.getByText(/^Problem$|^問題内容$/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Make the endpoint reachable.")).toBeInTheDocument();
    // 生 `## ` はどこにも出ない (Markdown が効いている)。
    expect(screen.queryByText(/^##\s/)).not.toBeInTheDocument();
  });

  it("should not render the instructions body in the problem-statement section (#2473: dedup)", () => {
    // instructions は ProblemInfoSection (ProblemDetail.tsx) 側に一本化された。 ここで
    // description と一緒に渡しても、 instructions 本文は問題内容セクションに出ない
    // (= 重複解消の回帰ガード)。
    renderPanel({
      description: "Make the endpoint reachable.",
      instructions: "Only-in-instructions unique marker text",
    });
    expect(screen.getByText("Make the endpoint reachable.")).toBeInTheDocument();
    expect(screen.queryByText(/Only-in-instructions unique marker text/)).not.toBeInTheDocument();
  });

  it("should render only the description when instructions is absent (#1975 / #2473)", () => {
    renderPanel({ description: "Only a description here." });
    expect(screen.getByText(/^Problem$|^問題内容$/)).toBeInTheDocument();
    expect(screen.getByText("Only a description here.")).toBeInTheDocument();
  });

  it("should omit the problem statement section when only instructions is present (#2473)", () => {
    // #2473: hasProblemStatement は description のみで判定するので、 instructions だけの
    // 問題では section 自体が描画されない (instructions は ProblemInfoSection に出る)。
    renderPanel({ instructions: "Only instructions here." });
    expect(screen.queryByText(/^Problem$|^問題内容$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Only instructions here.")).not.toBeInTheDocument();
  });

  it("should omit the problem statement section entirely in AWS mode (no statement)", () => {
    // AWS mode: name / description / instructions 未配信 → section も heading も出ない (= 既存挙動)。
    renderPanel({ status: "COMPLETE", scoring: { kind: "flag" } });
    expect(screen.queryByText(/^Problem$|^問題内容$/)).not.toBeInTheDocument();
    // title は problemId に fall back。
    expect(screen.getByText("hello-world")).toBeInTheDocument();
  });
});

describe("ProblemPanel countdown polling", () => {
  const renderPanel = (over: Partial<ParticipantProblemView>, cloudMode: CloudMode = "real") =>
    render(
      withI18n(
        <ProblemPanel
          problem={{ ...baseProblem, ...over }}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
        cloudMode,
      ),
    );

  afterEach(() => {
    vi.useRealTimers();
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
});

describe("ProblemPanel i18n (#2054)", () => {
  afterEach(() => {
    window.localStorage.removeItem("tenkacloud.portal.locale");
  });

  const localized: ParticipantProblemView = {
    ...baseProblem,
    status: "COMPLETE",
    name: "SQL インジェクション",
    description: "脆弱なログイン (JA)。",
    instructions: "ログインを突破 (JA)。",
    i18n: {
      en: {
        name: "SQL Injection — Login Bypass",
        description: "A deliberately vulnerable login (EN).",
        instructions: "Bypass the login (EN).",
      },
    },
  };

  it("should render the English problem statement when the locale is en", () => {
    window.localStorage.setItem("tenkacloud.portal.locale", "en");
    render(
      withI18n(
        <ProblemPanel
          problem={localized}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );
    expect(screen.getByText("SQL Injection — Login Bypass")).toBeInTheDocument();
    expect(screen.getByText("A deliberately vulnerable login (EN).")).toBeInTheDocument();
    // #2473: instructions は ProblemPanel から落ちた (ProblemInfoSection に一本化)。
    // 描画されないことを回帰ガードする — 重複表示バグの再発防止。
    expect(screen.queryByText(/Bypass the login/)).not.toBeInTheDocument();
    expect(screen.queryByText("脆弱なログイン (JA)。")).not.toBeInTheDocument();
  });

  it("should render the Japanese (canonical) statement when the locale is ja", () => {
    window.localStorage.setItem("tenkacloud.portal.locale", "ja");
    render(
      withI18n(
        <ProblemPanel
          problem={localized}
          apiBaseUrl="https://api.example.com"
          sessionToken="team-key"
          onScored={async () => undefined}
        />,
      ),
    );
    expect(screen.getByText("SQL インジェクション")).toBeInTheDocument();
    expect(screen.getByText("脆弱なログイン (JA)。")).toBeInTheDocument();
    expect(screen.queryByText("SQL Injection — Login Bypass")).not.toBeInTheDocument();
  });
});
