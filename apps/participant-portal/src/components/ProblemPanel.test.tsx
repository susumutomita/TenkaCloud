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
import {
  buildAutoDeleteNotice,
  describeProblemKind,
  getCompleteFlagScoring,
  getCompleteMultiFlagScoring,
  hasProblemStatement,
  isHttpUrlOutput,
  isStaleProblem,
  isUptimeScoring,
  ProblemPanel,
  resolveProblemTitle,
  splitStackOutputs,
} from "./ProblemPanel";
import {
  formatProblemPanelActionError,
  shouldRefreshAfterFlagSubmit,
} from "./ProblemPanel.helpers";

// FlagSubmissionPanel は #1480 で別途 100% 済。 ここでは ProblemPanel の flag 分岐だけ pin。
vi.mock("./ProblemPanelFlagSubmission", () => ({
  FlagSubmissionPanel: () => <div data-testid="flag-panel" />,
}));
// MultiFlagSubmissionPanel は別 test (#1796) で網羅。 ここでは ProblemPanel の分岐だけ pin。
vi.mock("./MultiFlagSubmissionPanel", () => ({
  MultiFlagSubmissionPanel: () => <div data-testid="multi-flag-panel" />,
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

  it("should detect a problem statement only when description or instructions is non-empty", () => {
    const p = (over: Partial<ParticipantProblemView>) => ({ ...baseProblem, ...over });
    expect(hasProblemStatement(p({}))).toBe(false);
    expect(hasProblemStatement(p({ description: "", instructions: "" }))).toBe(false);
    expect(hasProblemStatement(p({ description: "  " }))).toBe(false);
    expect(hasProblemStatement(p({ description: "Solve it" }))).toBe(true);
    expect(hasProblemStatement(p({ instructions: "Do A then B" }))).toBe(true);
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

  it("should render the name as the panel title when present (#1975)", () => {
    renderPanel({ name: "Reachability Check", problemId: "net-evo-01" });
    expect(screen.getByText("Reachability Check")).toBeInTheDocument();
    expect(screen.queryByText("net-evo-01")).not.toBeInTheDocument();
  });

  it("should render the problem statement heading + description + instructions (#1975)", () => {
    renderPanel({
      name: "Reachability Check",
      description: "Make the endpoint reachable.",
      instructions: "Step 1\nStep 2",
    });
    expect(screen.getByText(/^Problem$|^問題内容$/)).toBeInTheDocument();
    expect(screen.getByText("Make the endpoint reachable.")).toBeInTheDocument();
    // 改行を尊重したテキスト (pre-wrap) として instructions が出る。
    expect(screen.getByText(/Step 1/)).toBeInTheDocument();
  });

  it("should render only the description when instructions is absent (#1975)", () => {
    renderPanel({ description: "Only a description here." });
    expect(screen.getByText(/^Problem$|^問題内容$/)).toBeInTheDocument();
    expect(screen.getByText("Only a description here.")).toBeInTheDocument();
  });

  it("should render only the instructions when description is absent (#1975)", () => {
    renderPanel({ instructions: "Only instructions here." });
    expect(screen.getByText(/^Problem$|^問題内容$/)).toBeInTheDocument();
    expect(screen.getByText("Only instructions here.")).toBeInTheDocument();
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
    expect(screen.getByText("Bypass the login (EN).")).toBeInTheDocument();
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
