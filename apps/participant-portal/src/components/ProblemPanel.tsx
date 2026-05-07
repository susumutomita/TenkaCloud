import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useState } from "react";
import {
  type DeploymentStatus,
  type ParticipantProblemView,
  PortalValidationError,
  type SubmitFlagOutcome,
  submitFlag,
  TERMINAL_STATUSES,
} from "../api/portal-client";
import { describeAgo } from "../lib/format";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

const SCORING_KIND_LABEL = {
  flag: "Challenge (flag 提出)",
  uptime: "Battle (uptime 加点)",
} as const;

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

const POLL_INTERVAL_MS = 5_000;

/**
 * 1 problem 単位の詳細パネル。Home (= 全 problem を縦並べ) と ProblemDetail
 * (= 1 problem 専用ページ) の両方から使う共通 component。
 */
export function ProblemPanel({
  problem,
  apiBaseUrl,
  sessionToken,
  onScored,
}: {
  problem: ParticipantProblemView;
  apiBaseUrl: string;
  sessionToken: string;
  onScored: () => Promise<void>;
}) {
  const kindLabel = problem.scoring ? SCORING_KIND_LABEL[problem.scoring.kind] : "(未設定)";
  const now = Date.now();
  const lastScoredMs = problem.lastScoredAt ? new Date(problem.lastScoredAt).getTime() : Number.NaN;
  const isUptime = problem.scoring?.kind === "uptime";
  const isStale =
    isUptime &&
    Number.isFinite(lastScoredMs) &&
    now - lastScoredMs > STALE_THRESHOLD_MS &&
    problem.status === "COMPLETE";

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`${kindLabel} / ${problem.score} pt`}
          actions={
            <StatusIndicator type={STATUS_TYPE[problem.status]}>{problem.status}</StatusIndicator>
          }
        >
          {problem.problemId}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {problem.status === "FAILED" && problem.failureReason && (
          <Alert type="error" header="失敗理由">
            {problem.failureReason}
          </Alert>
        )}
        {isStale && (
          <Alert type="warning" header="スコアが伸びていません">
            直近の採点から {describeAgo(problem.lastScoredAt, now)} 経過。サービスのどこかが
            期待通り応答していない可能性があります。
          </Alert>
        )}
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "Region", value: problem.region },
              { label: "Job ID", value: <code>{problem.jobId}</code> },
            ]}
          />
          <KeyValuePairs
            items={[
              { label: "現在の score", value: `${problem.score} pt` },
              { label: "最終加点", value: describeAgo(problem.lastScoredAt, now) },
            ]}
          />
        </ColumnLayout>
        {Object.keys(problem.stackOutputs).length > 0 && (
          <Container header={<Header variant="h3">アクセス先 URL</Header>}>
            <KeyValuePairs
              items={Object.entries(problem.stackOutputs).map(([label, value]) => ({
                label,
                value: (
                  <a href={value} target="_blank" rel="noreferrer noopener">
                    <code>{value}</code>
                  </a>
                ),
              }))}
            />
          </Container>
        )}
        {problem.scoring?.kind === "flag" && problem.status === "COMPLETE" && (
          <FlagSubmissionPanel
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problem.problemId}
            flagSubmitted={problem.scoring.flagSubmitted ?? false}
            points={problem.scoring.points ?? 0}
            hints={problem.scoring.hints ?? []}
            onScored={onScored}
          />
        )}
        {!TERMINAL_STATUSES.has(problem.status) && (
          <Box variant="small" color="text-status-info">
            {POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}

function FlagSubmissionPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
  flagSubmitted,
  points,
  hints,
  onScored,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flagSubmitted: boolean;
  points: number;
  hints: readonly string[];
  onScored: () => Promise<void>;
}) {
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (flagSubmitted) {
    return (
      <Alert type="success" header="提出済み">
        この problem は既に正解を提出済みです (+{points} pt)。
      </Alert>
    );
  }

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!flag.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setOutcome(null);
    try {
      const result = await submitFlag(apiBaseUrl, sessionToken, problemId, flag);
      setOutcome(result);
      if (result.kind === "ok" || result.kind === "already_scored") {
        await onScored();
      }
    } catch (err) {
      if (err instanceof PortalValidationError) {
        setSubmitError(`バリデーションエラー: ${err.errorCode}`);
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SpaceBetween size="s">
      {hints.length > 0 && (
        <Alert type="info" header="ヒント">
          <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Alert>
      )}
      <form onSubmit={handleSubmit}>
        <Form
          actions={
            <Button variant="primary" loading={submitting} formAction="submit">
              Flag 提出 (+{points} pt)
            </Button>
          }
        >
          <FormField label="Flag (Stack Output 値)">
            <Input
              value={flag}
              onChange={(e) => setFlag(e.detail.value)}
              placeholder="例: Hello from tc-hello-world-..."
              disabled={submitting}
            />
          </FormField>
        </Form>
      </form>
      {outcome?.kind === "ok" && (
        <Alert type="success" header={`正解 (+${outcome.scoreDelta} pt)`}>
          合計スコア: {outcome.totalScore} pt
        </Alert>
      )}
      {outcome?.kind === "wrong" && (
        <Alert type="warning" header="不正解">
          値を確認して再度提出してください。
        </Alert>
      )}
      {outcome?.kind === "already_scored" && (
        <Alert type="info" header="提出済み">
          既に正解済みです (合計 {outcome.totalScore} pt)。
        </Alert>
      )}
      {submitError && (
        <Alert type="error" header="提出に失敗しました">
          {submitError}
        </Alert>
      )}
    </SpaceBetween>
  );
}
