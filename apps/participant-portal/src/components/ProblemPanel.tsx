import Alert from "@cloudscape-design/components/alert";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useNowMs } from "@tenkacloud/web-kit";
import type { DeploymentStatus, ParticipantProblemView } from "../api/portal-client";
import { useT } from "../i18n";
import { describeAgo } from "../lib/format";
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";
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
  "multi-flag": "problem_panel.kind_multi_flag",
  uptime: "problem_panel.kind_uptime",
  "uptime-flat": "problem_panel.kind_uptime",
  "uptime-multi": "problem_panel.kind_uptime",
  "phased-polling": "problem_panel.kind_phased",
  "attack-detection": "problem_panel.kind_attack",
};

type FlagScoringInfo = NonNullable<ParticipantProblemView["scoring"]>;

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

const COUNTDOWN_REFRESH_MS = 30_000;
const AUTO_DELETE_SOON_THRESHOLD_MS = 15 * 60 * 1000;

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

export function describeProblemKind(
  t: ProblemPanelT,
  scoring: ParticipantProblemView["scoring"],
): string {
  if (!scoring) return t("problem_panel.kind_unknown");
  return t(SCORING_KIND_KEY[scoring.kind] ?? "problem_panel.kind_unknown");
}

export function isUptimeScoring(scoring: ParticipantProblemView["scoring"]): boolean {
  // flag / multi-flag は Challenge (= 提出型)。 それ以外 (uptime 系 / phased / attack) は Battle 軸の
  // 「古い lastScoredAt = stale」 UX を適用する (= polling 採点だから停滞が意味を持つ)。
  return scoring ? scoring.kind !== "flag" && scoring.kind !== "multi-flag" : false;
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

/**
 * Issue #1796: deploy COMPLETE かつ multi-flag kind のときだけ MultiFlagSubmissionPanel を出す
 * (= 単一 flag kind の getCompleteFlagScoring と同方針。 deploy 未完だと flagOutputKey の値が無く
 * 提出しても no_outputs になるため)。
 */
export function getCompleteMultiFlagScoring(
  problem: ParticipantProblemView,
): FlagScoringInfo | undefined {
  const scoring = problem.scoring;
  if (problem.status !== "COMPLETE" || scoring?.kind !== "multi-flag") return undefined;
  return scoring;
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
  const kindLabel = describeProblemKind(t, problem.scoring);
  const autoDeleteNotice = buildAutoDeleteNotice(t, problem.expiresAt, now);
  // #688: phased-polling / uptime-flat / uptime-multi / attack-detection も Battle 軸
  // (= uptime と同じ "古い lastScoredAt = stale" UX を適用)。 flag だけ非 Battle。
  const isStale = isStaleProblem(problem, now);
  const flagScoring = getCompleteFlagScoring(problem);
  const multiFlagScoring = getCompleteMultiFlagScoring(problem);

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
        {multiFlagScoring && (
          <MultiFlagSubmissionPanel
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problem.problemId}
            flags={multiFlagScoring.flags ?? []}
            onScored={onScored}
          />
        )}
      </SpaceBetween>
    </Container>
  );
}
