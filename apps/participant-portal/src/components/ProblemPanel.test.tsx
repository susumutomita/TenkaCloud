import { render, screen } from "@testing-library/react";
import type * as React from "react";
import { describe, expect, it } from "vitest";
import type { ParticipantProblemView } from "../api/portal-client";
import { I18nProvider } from "../i18n";
import { ProblemPanel } from "./ProblemPanel";

function withI18n(node: React.ReactNode) {
  window.localStorage.setItem("tenkacloud.portal.locale", "ja");
  return <I18nProvider>{node}</I18nProvider>;
}

const baseProblem: ParticipantProblemView = {
  jobId: "JOB1",
  problemId: "hello-world",
  region: "ap-northeast-1",
  awsAccountId: "999999999999",
  status: "IN_PROGRESS",
  stackOutputs: {},
  expiresAt: 1_700_000_000,
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

    expect(screen.getByLabelText("デプロイ terminal")).toBeInTheDocument();
    expect(screen.getByText("Deployment job was queued.")).toBeInTheDocument();
    expect(screen.getByText("CloudFormation stack creation is in progress.")).toBeInTheDocument();
  });
});
