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
import { Markdown, useNowMs } from "@tenkacloud/web-kit";
import type {
  DeploymentStatus,
  ParticipantProblemView,
  ProblemLifecycleStatus,
} from "../api/portal-client";
import { useAppConfig } from "../config-context";
import { WHAT_IS_DRILL_PROBLEM_ID } from "../dev-mock/flag-submit";
import { useLang, useT } from "../i18n";
import { describeAgo, type SupportedLang } from "../lib/format";
import { AttackProbesPanel } from "./AttackProbesPanel";
import { MultiFlagSubmissionPanel } from "./MultiFlagSubmissionPanel";
import {
  buildAutoDeleteNotice,
  codespacesLoopbackUrl,
  describeApplicationStatus,
  describeProblemKind,
  getCompleteFlagScoring,
  getCompleteMultiFlagScoring,
  hasProblemStatement,
  isProblemPlayable,
  isStaleProblem,
  localizeProblem,
  type ProblemPanelT,
  resolveProblemTitle,
  shouldShowContainerTerminal,
  splitStackOutputs,
} from "./ProblemPanel.helpers";
import { FlagSubmissionPanel } from "./ProblemPanelFlagSubmission";
import { ProblemLifecyclePanel } from "./ProblemPanelLifecycle";
import { ProblemTerminalPanel } from "./ProblemTerminalPanel";

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

/**
 * [#2392 Phase 2] local-play on-demand container の header 表示。 lifecycle field を持つ
 * 問題は deploy status (= local backend では常に COMPLETE) ではなく container の状態を
 * header に出す (= 「Running」 なのに endpoint が無い、 という嘘をつかない)。
 */
const LIFECYCLE_STATUS_TYPE: Record<ProblemLifecycleStatus, StatusIndicatorProps.Type> = {
  stopped: "stopped",
  starting: "loading",
  running: "success",
  error: "error",
};

const COUNTDOWN_REFRESH_MS = 30_000;
const ONBOARDING_PRACTICE_ENDPOINT_FILE = "onboarding-practice.html";

function onboardingPracticeEndpointUrl(): string {
  return new URL(
    `${import.meta.env.BASE_URL}${ONBOARDING_PRACTICE_ENDPOINT_FILE}`,
    window.location.origin,
  ).href;
}

/** Defense in depth: runtime control material is never a participant stack output. */
function visibleStackOutputs(problem: ParticipantProblemView): Record<string, string> {
  if (problem.lifecycle?.runtimeKind !== "simulated-cloud") return problem.stackOutputs;
  return Object.fromEntries(
    Object.entries(problem.stackOutputs).filter(([key]) =>
      key.split(".").every((segment) => !segment.startsWith("Simulator")),
    ),
  );
}

function problemStackOutputs(
  problem: ParticipantProblemView,
  isIntroTutorial: boolean,
  t: ProblemPanelT,
): Record<string, string> {
  const outputs = visibleStackOutputs(problem);
  if (!isIntroTutorial) return outputs;
  return {
    ...outputs,
    [t("onboarding_tutorial.practice_endpoint_label")]: onboardingPracticeEndpointUrl(),
  };
}

/**
 * #1975 / #2473: 問題文 (description) を web-kit `<Markdown>` で描画する。
 *
 * instructions は `ProblemInfoSection` 側で描画される(#2473 で重複表示を解消)ので、
 * ここでは description のみを扱う。`<Markdown>` は marked → DOMPurify sanitize 済みの
 * 安全経路(`ProblemDetail` と同じ)で、`innerHTML` / `dangerouslySetInnerHTML` を
 * 直接使わない。不在の field は出さないので、AWS mode (問題文未配信) では section 全体が
 * 描画されず、既存挙動のまま。
 */
function ProblemStatement({
  hidden,
  problem,
  t,
}: {
  hidden: boolean;
  problem: ParticipantProblemView;
  t: ProblemPanelT;
}) {
  if (hidden || !hasProblemStatement(problem)) return null;
  return (
    <Container header={<Header variant="h3">{t("problem_panel.statement_heading")}</Header>}>
      <Markdown source={problem.description} />
    </Container>
  );
}

function ProblemFacts({
  hidden,
  problem,
  health,
  now,
  lang,
  t,
}: {
  hidden: boolean;
  problem: ParticipantProblemView;
  health: { readonly type: StatusIndicatorProps.Type; readonly label: string } | null;
  now: number;
  lang: SupportedLang;
  t: ProblemPanelT;
}) {
  if (hidden) return null;
  return (
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
          value: describeAgo(problem.lastScoredAt, now, lang),
        },
      ]}
    />
  );
}

/**
 * [#2846] container terminal。 docker runtime (= AC26 companion track の network-surface
 * 無し問題を含む local-play container) の running 問題にだけ出す。 simulated-cloud (= console
 * handoff で足りる) / AWS mode (lifecycle 不在) には出さない。 `ProblemStatement` などと同じ
 * 「早期 null return」 の流儀に揃え、 gating の `&&` を `ProblemPanel` 本体から追い出す。
 */
function ContainerTerminal({
  problem,
  apiBaseUrl,
  sessionToken,
}: {
  problem: ParticipantProblemView;
  apiBaseUrl: string;
  sessionToken: string;
}) {
  if (!shouldShowContainerTerminal(problem)) return null;
  return (
    <ProblemTerminalPanel
      apiBaseUrl={apiBaseUrl}
      sessionToken={sessionToken}
      problemId={problem.problemId}
    />
  );
}

/** Writeup is absent from the API until its spoiler-release policy is satisfied. */
function ProblemWriteup({ problem, t }: { problem: ParticipantProblemView; t: ProblemPanelT }) {
  // Cloud releases writeups too (post-event, solved), so gate the local-only
  // drill pointer on local mode — an AWS competitor has no repo / `tenka-drill`.
  const isLocal = useAppConfig().cloudMode === "local";
  if (!problem.writeup?.trim()) return null;
  return (
    <Container header={<Header variant="h3">{t("problem_panel.writeup_heading")}</Header>}>
      <Markdown source={problem.writeup} />
      {/* Local-only pointer to the `tenka-drill` skill: no AI runs in the portal;
          the learner digs deeper in their own Claude Code (their subscription). */}
      {isLocal && (
        <Box variant="small" color="text-status-inactive" margin={{ top: "s" }}>
          {t("problem_panel.writeup_drill_hint", { command: `/tenka-drill ${problem.problemId}` })}
        </Box>
      )}
    </Container>
  );
}

function ProblemPanelAlerts({
  problem,
  isStale,
  autoDeleteNotice,
  now,
  t,
  lang,
}: {
  problem: ParticipantProblemView;
  isStale: boolean;
  autoDeleteNotice?: { readonly type: "warning"; readonly body: string };
  now: number;
  t: ProblemPanelT;
  lang: SupportedLang;
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
          {t("problem_panel.stale_body", { ago: describeAgo(problem.lastScoredAt, now, lang) })}
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
  const isIntroTutorial =
    problem.problemId === WHAT_IS_DRILL_PROBLEM_ID && multiFlagScoring !== undefined;
  const stackOutputs = splitStackOutputs(problemStackOutputs(problem, isIntroTutorial, t));
  // [#2392 Phase 2] local-play on-demand container。 lifecycle 不在 = AWS mode = running 扱い。
  const lifecycleStatus = problem.lifecycle?.status;
  const playable = isProblemPlayable(problem);
  // Issue #1917: uptime kind のみ集約 health を返す。 採点が減点したとき「サービスが落ちている」
  // と一目で分かるよう Score の隣に出す (= 減点理由の可視化)。
  const health = problem.applicationStatus
    ? describeApplicationStatus(problem.applicationStatus, t)
    : null;
  let panelTitle = resolveProblemTitle(problem);
  let panelDescription = `${kindLabel} / ${problem.score} pt`;
  if (isIntroTutorial) {
    panelTitle = t("onboarding_tutorial.panel_title");
    panelDescription = t("onboarding_tutorial.panel_description");
  }

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={panelDescription}
          actions={
            lifecycleStatus !== undefined ? (
              <StatusIndicator type={LIFECYCLE_STATUS_TYPE[lifecycleStatus]}>
                {t(`problem_panel.lifecycle_${lifecycleStatus}`)}
              </StatusIndicator>
            ) : (
              <StatusIndicator type={STATUS_TYPE[problem.status]}>
                {t(`quests.status_label.${problem.status}`)}
              </StatusIndicator>
            )
          }
        >
          {panelTitle}
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
          lang={lang}
        />
        {/* #1975 / #2473: 問題文 (name / description)。 local mode は同梱して返すので
            「何の問題か」 を表示できる。 instructions は ProblemInfoSection 側の唯一の描画経路に
            一本化した(#2473)ので、ここでは description のみ。 AWS mode は未配信なので不在時は
            何も出さない。 */}
        <ProblemStatement hidden={isIntroTutorial} problem={problem} t={t} />
        <ProblemWriteup problem={problem} t={t} />
        {/* [#2392 Phase 2] on-demand start / stop control。 lifecycle 不在 (= AWS mode) は出さない。 */}
        {lifecycleStatus !== undefined && (
          <ProblemLifecyclePanel
            status={lifecycleStatus}
            runtimeKind={problem.lifecycle?.runtimeKind}
            cleanupRequired={problem.lifecycle?.cleanupRequired === true}
            lastError={problem.lifecycle?.lastError}
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problem.problemId}
            onScored={onScored}
          />
        )}
        {/* Audit #3: Job ID (= 内部 ULID) は競技者に見せない。 Region は問題ごとに異なる
            (operator が問題単位で deploy 先を選ぶ) ため、 どの region に建っているかを明示する
            (= 「Event region」 1 つだけだと混乱する、 運用フィードバック)。 */}
        <ProblemFacts
          hidden={isIntroTutorial}
          problem={problem}
          health={health}
          now={now}
          lang={lang}
          t={t}
        />

        {/* Issue #2422: uptime-multi の attack-probe 結果。 「green なのに満点でない理由」を
            defender に見せる (= まだ刺さっている probe + このサイクルの減点)。 attackProbes を
            持つ問題でのみ backend が返すので、 それ以外では何も描画されない。 */}
        {problem.attackProbeStatus && problem.attackProbeStatus.probes.length > 0 && (
          <AttackProbesPanel status={problem.attackProbeStatus} t={t} />
        )}

        {/* [#2392 Phase 2] play surface。 on-demand container が running でない間は
            (stale な) endpoint と提出 UI を隠し、 上の start control に差し替える。 */}
        {playable && (
          <>
            <ContainerTerminal
              problem={problem}
              apiBaseUrl={apiBaseUrl}
              sessionToken={sessionToken}
            />
            {stackOutputs.accessUrlEntries.length > 0 && (
              <Container header={<Header variant="h3">{t("problem_panel.outputs_header")}</Header>}>
                <KeyValuePairs
                  items={stackOutputs.accessUrlEntries.map(([label, value]) => {
                    const loopback = codespacesLoopbackUrl(value);
                    return {
                      label,
                      value: (
                        <SpaceBetween size="xxs">
                          <a href={value} target="_blank" rel="noreferrer noopener">
                            <code>{value}</code>
                          </a>
                          {loopback && (
                            <Box fontSize="body-s" color="text-status-inactive">
                              {t("problem_panel.codespaces_terminal_hint")} <code>{loopback}</code>
                            </Box>
                          )}
                        </SpaceBetween>
                      ),
                    };
                  })}
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
          </>
        )}
      </SpaceBetween>
    </Container>
  );
}
