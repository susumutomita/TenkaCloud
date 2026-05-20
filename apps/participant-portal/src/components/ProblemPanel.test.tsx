import { render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import { I18nProvider } from "../i18n";
import { ProblemPanel } from "./ProblemPanel";

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
});
