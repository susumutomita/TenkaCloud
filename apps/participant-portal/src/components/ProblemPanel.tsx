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
import type { DeploymentStatus, ParticipantProblemView } from "../api/portal-client";
import { useLang, useT } from "../i18n";
import { describeAgo } from "../lib/format";
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";
import {
  describeApplicationStatus,
  localizeProblem,
  type ProblemPanelT,
} from "./ProblemPanel.helpers";
import { FlagSubmissionPanel } from "./ProblemPanelFlagSubmission";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  // Issue #2019: held for operator approval — show as pending (in-flight).
  APPROVAL_PENDING: "pending",
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
type StackOutputEntry = [label: string, value: string];

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

const COUNTDOWN_REFRESH_MS = 30_000;
const AUTO_DELETE_SOON_THRESHOLD_MS = 15 * 60 * 1000;
const HTTP_URL_OUTPUT_RE = /^https?:\/\//i;

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

export function isHttpUrlOutput(value: string): boolean {
  return HTTP_URL_OUTPUT_RE.test(value);
}

export function splitStackOutputs(stackOutputs: ParticipantProblemView["stackOutputs"]): {
  readonly accessUrlEntries: StackOutputEntry[];
  readonly detailEntries: StackOutputEntry[];
} {
  const entries = Object.entries(stackOutputs);
  const accessUrlEntries = entries.filter(([, value]) => isHttpUrlOutput(value));
  const nonUrlEntries = entries.filter(([, value]) => !isHttpUrlOutput(value));
  return {
    accessUrlEntries,
    detailEntries: accessUrlEntries.length > 0 ? nonUrlEntries : entries,
  };
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

/**
 * #1975: パネル title は人間可読な name を優先し、 不在時 (= AWS mode で問題文未配信) は
 * problemId に fall back する。
 */
export function resolveProblemTitle(problem: ParticipantProblemView): string {
  return problem.name?.trim() ? problem.name : problem.problemId;
}

/** description / instructions のいずれかが非空なら問題文セクションを描画する。 */
export function hasProblemStatement(problem: ParticipantProblemView): boolean {
  return Boolean(problem.description?.trim() || problem.instructions?.trim());
}

/**
 * #1975: 問題文 (description + instructions) を読みやすい preformatted text で描画する。
 *
 * instructions は markdown 風のプレーンテキストになりうるが、 改行を尊重しつつ
 * innerHTML / dangerouslySetInnerHTML は使わない (= XSS 面を作らない)。 不在の field は出さない
 * ので、 AWS mode (問題文未配信) では section 全体が描画されず、 既存挙動のまま。
 */
function ProblemStatement({ problem, t }: { problem: ParticipantProblemView; t: ProblemPanelT }) {
  if (!hasProblemStatement(problem)) return null;
  return (
    <Container header={<Header variant="h3">{t("problem_panel.statement_heading")}</Header>}>
      <SpaceBetween size="xs">
        {problem.description?.trim() && (
          <Box variant="p">
            <pre style={PROBLEM_TEXT_STYLE}>{problem.description}</pre>
          </Box>
        )}
        {problem.instructions?.trim() && (
          <Box variant="p">
            <pre style={PROBLEM_TEXT_STYLE}>{problem.instructions}</pre>
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}

/** Writeup is absent from the API until its spoiler-release policy is satisfied. */
function ProblemWriteup({ problem, t }: { problem: ParticipantProblemView; t: ProblemPanelT }) {
  if (!problem.writeup?.trim()) return null;
  return (
    <Container header={<Header variant="h3">{t("problem_panel.writeup_heading")}</Header>}>
      <Box variant="p">
        <pre style={PROBLEM_TEXT_STYLE}>{problem.writeup}</pre>
      </Box>
    </Container>
  );
}

/** 改行尊重 + フォントは本文継承 (= autoLink / innerHTML を避けた安全なプレーンテキスト)。 */
const PROBLEM_TEXT_STYLE = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  fontSize: "inherit",
} as const;

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
  problem: rawProblem,
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
  // #2054 i18n: resolve the live API problem text (name / description /
  // instructions + revealed hint content) for the current locale so the portal's
  // locale switcher localizes the Home + ProblemDetail panels. ja is canonical.
  const lang = useLang();
  const problem = localizeProblem(rawProblem, lang);
  const now = useNowMs(COUNTDOWN_REFRESH_MS);
  const kindLabel = describeProblemKind(t, problem.scoring);
  const autoDeleteNotice = buildAutoDeleteNotice(t, problem.expiresAt, now);
  // #688: phased-polling / uptime-flat / uptime-multi / attack-detection も Battle 軸
  // (= uptime と同じ "古い lastScoredAt = stale" UX を適用)。 flag だけ非 Battle。
  const isStale = isStaleProblem(problem, now);
  const flagScoring = getCompleteFlagScoring(problem);
  const multiFlagScoring = getCompleteMultiFlagScoring(problem);
  const stackOutputs = splitStackOutputs(problem.stackOutputs);
  // Issue #1917: uptime kind のみ集約 health を返す。 採点が減点したとき「サービスが落ちている」
  // と一目で分かるよう Score の隣に出す (= 減点理由の可視化)。
  const health = problem.applicationStatus
    ? describeApplicationStatus(problem.applicationStatus, t)
    : null;

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
          {resolveProblemTitle(problem)}
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
        {/* #1975: 問題文 (name / description / instructions)。 local mode は同梱して返すので
            「何の問題か / 何をすべきか」 を表示できる。 AWS mode は未配信なので不在時は何も出さない。 */}
        <ProblemStatement problem={problem} t={t} />
        <ProblemWriteup problem={problem} t={t} />
        {/* Audit #3: Job ID (= 内部 ULID) は競技者に見せない。 Region は問題ごとに異なる
            (operator が問題単位で deploy 先を選ぶ) ため、 どの region に建っているかを明示する
            (= 「Event region」 1 つだけだと混乱する、 運用フィードバック)。 */}
        <KeyValuePairs
          items={[
            { label: t("problem_panel.region_label"), value: <code>{problem.region}</code> },
            { label: t("problem_panel.current_score_label"), value: `${problem.score} pt` },
            // Issue #1917: uptime のみ。 「Score が下がった = サービスが degraded/down」 を
            // 同じ行群で結びつけ、 減点理由を競技者が把握できるようにする (per-endpoint は非露出)。
            ...(health
              ? [
                  {
                    label: t("problem_panel.health_label"),
                    value: <StatusIndicator type={health.type}>{health.label}</StatusIndicator>,
                  },
                ]
              : []),
            {
              label: t("problem_panel.last_scored_label"),
              value: describeAgo(problem.lastScoredAt, now),
            },
          ]}
        />

        {stackOutputs.accessUrlEntries.length > 0 && (
          <Container header={<Header variant="h3">{t("problem_panel.outputs_header")}</Header>}>
            <KeyValuePairs
              items={stackOutputs.accessUrlEntries.map(([label, value]) => ({
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
        {stackOutputs.detailEntries.length > 0 && (
          <ExpandableSection
            headerText={t("problem_panel.stack_outputs_detail_header")}
            defaultExpanded={false}
          >
            <KeyValuePairs
              items={stackOutputs.detailEntries.map(([label, value]) => ({
                label,
                value: <code>{value}</code>,
              }))}
            />
          </ExpandableSection>
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
            revealOrder={flagScoring.hintReveal}
          />
        )}
        {multiFlagScoring && (
          <MultiFlagSubmissionPanel
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problem.problemId}
            flags={multiFlagScoring.flags ?? []}
            onScored={onScored}
            revealOrder={multiFlagScoring.hintReveal}
          />
        )}
      </SpaceBetween>
    </Container>
  );
}
