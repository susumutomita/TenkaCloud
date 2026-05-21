import { render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
} from "../api/portal-client";
import { I18nProvider } from "../i18n";
import { ProblemPanel } from "./ProblemPanel";
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

function withI18n(node: React.ReactNode) {
  return <I18nProvider>{node}</I18nProvider>;
}

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

  it("deployLog の terminal 行を表示すべき", () => {
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

    expect(screen.getByLabelText(/Deployment terminal|デプロイ terminal/)).toBeInTheDocument();
    expect(screen.getByText("Deployment job was queued.")).toBeInTheDocument();
    expect(screen.getByText("CloudFormation stack creation is in progress.")).toBeInTheDocument();
  });

  it("非 terminal status では CodeBuild live log を取得して terminal に表示すべき", async () => {
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

  it("expiresAt から自動削除までの残り時間を表示すべき", () => {
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

  it("AUTO_DELETED status を停止済みとして表示すべき", () => {
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

  it("ok / already_scored のとき score refresh 対象にすべき", () => {
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

  it("scoring gate error をユーザー向け文言に整形すべき", () => {
    expect(
      formatProblemPanelActionError(
        t,
        new PortalScoringGateError("scoring_locked"),
        "problem_panel.validation_error",
      ),
    ).toBe("problem_panel.scoring_gate_paused");
  });

  it("validation error を指定 key の errorCode 付き文言に整形すべき", () => {
    expect(
      formatProblemPanelActionError(
        t,
        new PortalValidationError("invalid_flag"),
        "problem_panel.submit_error_prefix",
      ),
    ).toBe("problem_panel.submit_error_prefix:invalid_flag");
  });

  it("Error 以外も string 化すべき", () => {
    expect(formatProblemPanelActionError(t, "boom", "problem_panel.validation_error")).toBe("boom");
  });
});
