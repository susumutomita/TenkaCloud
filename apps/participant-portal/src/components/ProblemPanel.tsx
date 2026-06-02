import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useNowMs } from "@tenkacloud/web-kit";
import { useEffect, useState } from "react";
import {
  type DeployLogsResponse,
  type DeploymentLogEntry,
  type DeploymentLogView,
  type DeploymentStatus,
  getDeployLogs,
  type ParticipantProblemView,
  TERMINAL_STATUSES,
} from "../api/portal-client";
import { useT } from "../i18n";
import { describeAgo } from "../lib/format";
import type { ProblemPanelT } from "./ProblemPanel.helpers";
import { FlagSubmissionPanel } from "./ProblemPanelFlagSubmission";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
  EXPIRED: "warning",
  AUTO_DELETED: "stopped",
};

const SCORING_KIND_KEY: Record<string, string> = {
  flag: "problem_panel.kind_flag",
  uptime: "problem_panel.kind_uptime",
  "uptime-flat": "problem_panel.kind_uptime",
  "uptime-multi": "problem_panel.kind_uptime",
  "phased-polling": "problem_panel.kind_phased",
  "attack-detection": "problem_panel.kind_attack",
};

type FlagScoringInfo = NonNullable<ParticipantProblemView["scoring"]>;

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒は 12 req/min/user で過多)。
const POLL_INTERVAL_MS = 30_000;
const LIVE_DEPLOY_LOG_POLL_INTERVAL_MS = 5_000;
const COUNTDOWN_REFRESH_MS = 30_000;
const AUTO_DELETE_SOON_THRESHOLD_MS = 15 * 60 * 1000;

const DEPLOY_LOG_LEVEL_COLOR: Record<DeploymentLogEntry["level"], string> = {
  info: "#9bd3ff",
  success: "#9dffb0",
  warning: "#ffd27d",
  error: "#ff9b9b",
};

export function describeRemainingUntilAutoDelete(t: ProblemPanelT, diffMs: number): string {
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  return t("problem_panel.auto_delete_remaining_minutes", { minutes: totalMinutes });
}

export function buildAutoDeleteNotice(
  t: ProblemPanelT,
  expiresAt: number,
  nowMs: number,
): { readonly type: "warning"; readonly body: string } | undefined {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return undefined;
  const expiresAtMs = expiresAt * 1000;
  const expiresAtLabel = new Date(expiresAtMs).toLocaleString();
  const diffMs = expiresAtMs - nowMs;
  if (diffMs <= 0) {
    return {
      type: "warning",
      body: t("problem_panel.auto_delete_expired_body", { expiresAt: expiresAtLabel }),
    };
  }
  if (diffMs <= AUTO_DELETE_SOON_THRESHOLD_MS) {
    const remaining = describeRemainingUntilAutoDelete(t, diffMs);
    return {
      type: "warning",
      body: t("problem_panel.auto_delete_soon_body", { remaining, expiresAt: expiresAtLabel }),
    };
  }
  return undefined;
}

function useLiveDeployLog({
  apiBaseUrl,
  sessionToken,
  problem,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problem: ParticipantProblemView;
}): DeploymentLogView | null {
  const [liveDeployLog, setLiveDeployLog] = useState<DeploymentLogView | null>(null);

  // この polling は usePolling に寄せない: tick 間で `nextToken` を引き継ぐ paging と、
  // `response.complete` で自走停止する業務ロジックを持ち、 単純な timer 制御 (usePolling の責務) を超える。
  useEffect(() => {
    setLiveDeployLog(null);
    if (TERMINAL_STATUSES.has(problem.status)) return;

    let cancelled = false;
    let nextToken: string | undefined;
    const poll = async () => {
      try {
        const response = await getDeployLogs(apiBaseUrl, sessionToken, problem.jobId, {
          nextToken,
          limit: 50,
        });
        if (cancelled) return;
        nextToken = response.nextToken;
        setLiveDeployLog((prev) => mergeLiveDeployLog(prev, response));
        if (response.complete) cancelled = true;
      } catch {
        // Live logs are best-effort; keep the synthetic deployment log visible if polling fails.
      }
    };

    void poll();
    const interval = setInterval(() => {
      if (!cancelled) void poll();
    }, LIVE_DEPLOY_LOG_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiBaseUrl, sessionToken, problem.jobId, problem.status]);

  return liveDeployLog;
}

export function selectDisplayedDeployLog(
  liveDeployLog: DeploymentLogView | null,
  deployLog: DeploymentLogView,
): DeploymentLogView {
  return liveDeployLog && liveDeployLog.entries.length > 0 ? liveDeployLog : deployLog;
}

export function describeProblemKind(
  t: ProblemPanelT,
  scoring: ParticipantProblemView["scoring"],
): string {
  if (!scoring) return t("problem_panel.kind_unknown");
  return t(SCORING_KIND_KEY[scoring.kind] ?? "problem_panel.kind_unknown");
}

export function isUptimeScoring(scoring: ParticipantProblemView["scoring"]): boolean {
  return scoring ? scoring.kind !== "flag" : false;
}

export function isStaleProblem(problem: ParticipantProblemView, now: number): boolean {
  const lastScoredMs = problem.lastScoredAt ? new Date(problem.lastScoredAt).getTime() : Number.NaN;
  return (
    isUptimeScoring(problem.scoring) &&
    Number.isFinite(lastScoredMs) &&
    now - lastScoredMs > STALE_THRESHOLD_MS &&
    problem.status === "COMPLETE"
  );
}

export function getCompleteFlagScoring(
  problem: ParticipantProblemView,
): FlagScoringInfo | undefined {
  const scoring = problem.scoring;
  if (problem.status !== "COMPLETE" || scoring?.kind !== "flag") return undefined;
  return scoring;
}

export function shouldShowAutoRefreshNote(status: DeploymentStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

function ProblemPanelAlerts({
  problem,
  isStale,
  autoDeleteNotice,
  now,
  t,
}: {
  problem: ParticipantProblemView;
  isStale: boolean;
  autoDeleteNotice?: { readonly type: "warning"; readonly body: string };
  now: number;
  t: ProblemPanelT;
}) {
  return (
    <>
      {problem.status === "FAILED" && problem.failureReason && (
        <Alert type="error" header={t("problem_panel.failure_reason_header")}>
          {problem.failureReason}
        </Alert>
      )}
      {isStale && (
        <Alert type="warning" header={t("problem_panel.stale_header")}>
          {t("problem_panel.stale_body", { ago: describeAgo(problem.lastScoredAt, now) })}
        </Alert>
      )}
      {autoDeleteNotice && (
        <Alert type={autoDeleteNotice.type} header={t("problem_panel.auto_delete_header")}>
          {autoDeleteNotice.body}
        </Alert>
      )}
    </>
  );
}

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
  const t = useT();
  const now = useNowMs(COUNTDOWN_REFRESH_MS);
  const liveDeployLog = useLiveDeployLog({ apiBaseUrl, sessionToken, problem });
  const kindLabel = describeProblemKind(t, problem.scoring);
  const autoDeleteNotice = buildAutoDeleteNotice(t, problem.expiresAt, now);
  // #688: phased-polling / uptime-flat / uptime-multi / attack-detection も Battle 軸
  // (= uptime と同じ "古い lastScoredAt = stale" UX を適用)。 flag だけ非 Battle。
  const isStale = isStaleProblem(problem, now);
  const displayedDeployLog = selectDisplayedDeployLog(liveDeployLog, problem.deployLog);
  const flagScoring = getCompleteFlagScoring(problem);

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`${kindLabel} / ${problem.score} pt`}
          actions={
            <StatusIndicator type={STATUS_TYPE[problem.status]}>
              {t(`quests.status_label.${problem.status}`)}
            </StatusIndicator>
          }
        >
          {problem.problemId}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <ProblemPanelAlerts
          problem={problem}
          isStale={isStale}
          autoDeleteNotice={autoDeleteNotice}
          now={now}
          t={t}
        />
        {/* Audit #3: Job ID (= 内部 ULID) は競技者に見せない。 Region は AWS 多リージョン
            の場合のみ意味があるが、 1 リージョン運用の現状では noise。 残すのは現在の score + 最終加点 */}
        <KeyValuePairs
          items={[
            { label: t("problem_panel.current_score_label"), value: `${problem.score} pt` },
            {
              label: t("problem_panel.last_scored_label"),
              value: describeAgo(problem.lastScoredAt, now),
            },
          ]}
        />

        {displayedDeployLog?.entries.length > 0 && (
          <DeployTerminal
            entries={displayedDeployLog.entries}
            title={t("problem_panel.deploy_log_header")}
            defaultExpanded={!TERMINAL_STATUSES.has(problem.status)}
          />
        )}

        {Object.keys(problem.stackOutputs).length > 0 && (
          <Container header={<Header variant="h3">{t("problem_panel.outputs_header")}</Header>}>
            <KeyValuePairs
              items={Object.entries(problem.stackOutputs).map(([label, value]) => ({
                label,
                // #1094: URL (= http(s)://) のときだけ click 可能リンクにする。 ARN / SSM
                //   parameter name / NamePrefix 等の非 URL output を a href で wrap すると
                //   broken link になるので plain code 表示に倒す。 「ParameterConsoleUrl」
                //   のような deep link を問題 author が emit すれば click で AWS Console
                //   直接遷移 (ssm:DescribeParameters 不要、 ADR-021 と整合)。
                value: /^https?:\/\//i.test(value) ? (
                  <a href={value} target="_blank" rel="noreferrer noopener">
                    <code>{value}</code>
                  </a>
                ) : (
                  <code>{value}</code>
                ),
              }))}
            />
          </Container>
        )}
        {flagScoring && (
          <FlagSubmissionPanel
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problem.problemId}
            flagSubmitted={flagScoring.flagSubmitted ?? false}
            points={flagScoring.points ?? 0}
            hints={flagScoring.hints ?? []}
            onScored={onScored}
          />
        )}
        {shouldShowAutoRefreshNote(problem.status) && (
          <Box variant="small" color="text-status-info">
            {t("problem_panel.auto_refresh_note", { seconds: POLL_INTERVAL_MS / 1000 })}
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}

export function mergeLiveDeployLog(
  prev: DeploymentLogView | null,
  response: DeployLogsResponse,
): DeploymentLogView {
  const existing = prev?.entries ?? [];
  const seen = new Set(existing.map((entry) => entry.id));
  const next = response.entries
    .filter((entry) => !seen.has(entry.id))
    .map((entry): DeploymentLogEntry => ({ ...entry, level: classifyCodeBuildLog(entry.message) }));
  return {
    cursor: response.nextToken ?? prev?.cursor ?? "",
    entries: [...existing, ...next].slice(-200),
  };
}

export function classifyCodeBuildLog(message: string): DeploymentLogEntry["level"] {
  if (/\b(error|failed|failure|timed out|fault)\b/i.test(message)) return "error";
  if (/\b(succeeded|complete|completed)\b/i.test(message)) return "success";
  if (/\b(warn|warning)\b/i.test(message)) return "warning";
  return "info";
}

function DeployTerminal({
  entries,
  title,
  defaultExpanded,
}: {
  entries: readonly DeploymentLogEntry[];
  title: string;
  defaultExpanded: boolean;
}) {
  return (
    <ExpandableSection headerText={title} defaultExpanded={defaultExpanded}>
      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          borderRadius: 6,
          background: "#0f1419",
          color: "#d5dde5",
          padding: "12px 14px",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {entries.map((entry) => (
          <div key={entry.id} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ color: "#8796a5" }}>{formatTerminalTime(entry.timestamp)}</span>{" "}
            <span style={{ color: DEPLOY_LOG_LEVEL_COLOR[entry.level] }}>[{entry.level}]</span>{" "}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </ExpandableSection>
  );
}

export function formatTerminalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
