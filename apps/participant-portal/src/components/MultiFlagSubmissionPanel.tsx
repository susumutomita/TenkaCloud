import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  type HintRevealMode,
  type MultiFlagEntryView,
  type SubmitFlagOutcome,
  submitFlag,
} from "../api/portal-client";
import { useIsMock } from "../config-context";
import {
  evaluateMockSubFlag,
  isStrictDrillProblem,
  LITE_DRILL_JOB_ID,
  LOCAL_DRILL_JOB_ID,
  WHAT_IS_DRILL_PROBLEM_ID,
} from "../dev-mock/flag-submit";
import { loadMockSolvedFlagIds, saveMockSolvedFlagId } from "../dev-mock/progress-store";
import { useLang, useT } from "../i18n";
import { trackOnboardingEvent } from "../onboarding-analytics";
import { CelebrationOverlay } from "./CelebrationOverlay";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";
import { HintsPanel } from "./ProblemPanelFlagSubmission";

const PARTICIPANT_MANUAL_URL = "https://tenkacloud.com/docs/manual/participant/";

export type OnboardingVariant = "list" | "step";
const ONBOARDING_VARIANT_STORAGE_KEY = "tenkacloud.onboarding.variant.v1";

export function onboardingVariantFromSearch(search: string): OnboardingVariant | undefined {
  const value = new URLSearchParams(search).get("onboarding");
  return value === "list" || value === "step" ? value : undefined;
}

export function resolveOnboardingVariant({
  search,
  storage,
  sample = Math.random,
}: {
  search: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  sample?: () => number;
}): OnboardingVariant {
  const forced = onboardingVariantFromSearch(search);
  if (forced) return forced;

  const stored = storage.getItem(ONBOARDING_VARIANT_STORAGE_KEY);
  if (stored === "list" || stored === "step") return stored;

  const assigned = sample() < 0.5 ? "list" : "step";
  storage.setItem(ONBOARDING_VARIANT_STORAGE_KEY, assigned);
  return assigned;
}

/**
 * Issue #1796: multi-flag kind の提出パネル。 1 問題に N 個の独立 flag を持ち、 競技者が各 flag を
 * 別々に提出して個別加点される。 `ProblemPanelFlagSubmission` (= 単一 flag kind) を sub-flag ごとに
 * 並べた構造で、 solved 表示 / 提出欄 / 状態 alert を flag 単位で持つ。
 *
 * - solved な flag: 「解答済 (+N pt)」 の success Alert
 * - 未 solved な flag: label 付き Input + submit Button (= per-flag の submitting state)
 * - dev-mock mode では backend を叩かず `evaluateMockSubFlag` で local 評価する
 *   (Lite deploy ドリル #2696 は sub-flag ごとのチェックポイントコード一致を要求)
 * - 正解後は `onScored()` で /portal/me を refetch し、 server truth (= solved 状態) を読み直す
 *
 * polling 以外の状態同期 (SSE / WebSocket) は使わない (AGENTS.md)。 refetch は親の polling と
 * 正解直後の明示 refetch (= onScored) に閉じる。
 */
export function MultiFlagSubmissionPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
  flags,
  onScored,
  revealOrder,
  onboardingVariant,
  prepareSubmission,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flags: readonly MultiFlagEntryView[];
  onScored: () => Promise<void>;
  /** 問題 `scoring.hintReveal`; `"flat"` で各 sub-flag の hint 順序ゲートを外す。 */
  revealOrder?: HintRevealMode;
  /** #2822 A/B preview: list = 動画と同じ一覧、step = 標準 UI を 1 flag ずつ表示。 */
  onboardingVariant?: OnboardingVariant;
  /**
   * Local container editor hook. When present, every checkpoint submission is
   * prepared from the current editor files plus all direct-answer values. Multiline
   * checkpoint inputs are replaced by the shared source editors.
   */
  prepareSubmission?: (flagId: string, values: Readonly<Record<string, string>>) => Promise<string>;
}) {
  const t = useT();
  const isMock = useIsMock();
  // dev-mock has no backend refetch to persist solved flags. Keep the solved ids
  // at panel level (so the progress counter can reach the last step and reveal the
  // completion handoff) and mirror them into the sessionStorage progress store —
  // without it, navigating away unmounts the panel and the demo looks reset.
  const [mockSolvedIds, setMockSolvedIds] = useState<ReadonlySet<string>>(() =>
    isMock ? loadMockSolvedFlagIds(problemId) : new Set(),
  );
  const [submissionValues, setSubmissionValues] = useState<Readonly<Record<string, string>>>({});
  const isSolved = (flag: MultiFlagEntryView) => flag.solved || mockSolvedIds.has(flag.id);
  const solvedCount = flags.filter(isSolved).length;
  const allSolved = flags.length > 0 && solvedCount === flags.length;
  const [resolvedOnboardingVariant] = useState<OnboardingVariant>(() =>
    problemId === WHAT_IS_DRILL_PROBLEM_ID
      ? (onboardingVariant ??
        resolveOnboardingVariant({
          search: window.location.search,
          storage: window.localStorage,
        }))
      : "list",
  );
  const onboardingStartedAt = useRef(Date.now());
  const initialSolvedCount = useRef(solvedCount);
  const wrongAttempts = useRef(0);
  const revealedHints = useRef(new Set<string>());
  const viewedSteps = useRef(new Set<string>());
  const completionTracked = useRef(false);
  const assignmentSource = useRef(
    onboardingVariant !== undefined || onboardingVariantFromSearch(window.location.search)
      ? "forced"
      : "assigned",
  );
  const activeFlag = flags.find((flag) => !isSolved(flag));
  const visibleFlags = resolvedOnboardingVariant === "step" && activeFlag ? [activeFlag] : flags;
  const progress = flags.length === 0 ? 0 : Math.round((solvedCount / flags.length) * 100);

  useEffect(() => {
    if (problemId !== WHAT_IS_DRILL_PROBLEM_ID) return;
    trackOnboardingEvent("onboarding_view", {
      onboarding_variant: resolvedOnboardingVariant,
      assignment_source: assignmentSource.current,
      total_steps: flags.length,
    });
  }, [flags.length, problemId, resolvedOnboardingVariant]);

  useEffect(() => {
    if (problemId !== WHAT_IS_DRILL_PROBLEM_ID) return;
    for (const flag of visibleFlags) {
      if (viewedSteps.current.has(flag.id)) continue;
      viewedSteps.current.add(flag.id);
      trackOnboardingEvent("onboarding_step_view", {
        onboarding_variant: resolvedOnboardingVariant,
        assignment_source: assignmentSource.current,
        onboarding_step: flag.id,
        step_index: flags.indexOf(flag) + 1,
      });
    }
  }, [flags, problemId, resolvedOnboardingVariant, visibleFlags]);

  useEffect(() => {
    if (
      problemId !== WHAT_IS_DRILL_PROBLEM_ID ||
      !allSolved ||
      completionTracked.current ||
      initialSolvedCount.current === flags.length
    ) {
      return;
    }
    completionTracked.current = true;
    trackOnboardingEvent("onboarding_complete", {
      onboarding_variant: resolvedOnboardingVariant,
      assignment_source: assignmentSource.current,
      elapsed_ms: Date.now() - onboardingStartedAt.current,
      hint_count: revealedHints.current.size,
      wrong_attempt_count: wrongAttempts.current,
    });
  }, [allSolved, flags.length, problemId, resolvedOnboardingVariant]);

  return (
    <div data-onboarding-variant={resolvedOnboardingVariant}>
      <SpaceBetween size="s">
        {resolvedOnboardingVariant === "step" && !allSolved ? (
          <ProgressBar
            value={progress}
            label={t("onboarding_tutorial.progress", {
              current: Math.min(solvedCount + 1, flags.length),
              total: flags.length,
            })}
            description={t("onboarding_tutorial.cleared", { solved: solvedCount })}
          />
        ) : (
          <Alert
            type={allSolved ? "success" : "info"}
            header={t("multi_flag.progress_header", { solved: solvedCount, total: flags.length })}
          >
            {allSolved ? t("multi_flag.all_solved_body") : t("multi_flag.progress_body")}
          </Alert>
        )}
        {visibleFlags.map((flag) => (
          <SubFlagRow
            key={flag.id}
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problemId}
            flag={flag}
            solved={isSolved(flag)}
            onMockSolved={(flagId) => {
              setMockSolvedIds((current) => new Set([...current, flagId]));
              saveMockSolvedFlagId(problemId, flagId);
            }}
            onScored={onScored}
            revealOrder={revealOrder}
            value={submissionValues[flag.id] ?? ""}
            values={submissionValues}
            onValueChange={(value) =>
              setSubmissionValues((current) => ({ ...current, [flag.id]: value }))
            }
            prepareSubmission={prepareSubmission}
            onHintRevealed={(hintId) => {
              if (problemId !== WHAT_IS_DRILL_PROBLEM_ID) return;
              revealedHints.current.add(hintId);
              trackOnboardingEvent("onboarding_hint_reveal", {
                onboarding_variant: resolvedOnboardingVariant,
                assignment_source: assignmentSource.current,
                onboarding_step: flag.id,
                step_index: flags.indexOf(flag) + 1,
              });
            }}
            onSubmitted={(outcome) => {
              if (problemId !== WHAT_IS_DRILL_PROBLEM_ID) return;
              if (outcome.kind === "wrong") wrongAttempts.current += 1;
              trackOnboardingEvent("onboarding_submit", {
                onboarding_variant: resolvedOnboardingVariant,
                assignment_source: assignmentSource.current,
                onboarding_step: flag.id,
                onboarding_result: outcome.kind,
                step_index: flags.indexOf(flag) + 1,
              });
              if (outcome.kind === "ok") {
                trackOnboardingEvent("onboarding_step_complete", {
                  onboarding_variant: resolvedOnboardingVariant,
                  assignment_source: assignmentSource.current,
                  onboarding_step: flag.id,
                  step_index: flags.indexOf(flag) + 1,
                });
              }
            }}
          />
        ))}
        {problemId === WHAT_IS_DRILL_PROBLEM_ID && allSolved && <WhatIsTutorialComplete />}
      </SpaceBetween>
    </div>
  );
}

function WhatIsTutorialComplete() {
  const t = useT();
  const navigate = useNavigate();

  // #2711 follow-up: 完走後の導線は実在ドリル 2 本に絞る (旧クエスト「欠けた数」は
  // 削除済み)。 primary は AWS 不要のローカルモード、 次点で Lite 実デプロイ。
  return (
    <Container header={<Header variant="h3">{t("multi_flag.tutorial_complete_header")}</Header>}>
      <SpaceBetween size="m">
        <Box>{t("multi_flag.tutorial_complete_body")}</Box>
        <Alert type="success" header={t("multi_flag.tutorial_next_header")}>
          {t("multi_flag.tutorial_next_body")}
        </Alert>
        <SpaceBetween size="xs" direction="horizontal">
          <Button
            href={PARTICIPANT_MANUAL_URL}
            target="_blank"
            iconName="external"
            ariaLabel={t("multi_flag.tutorial_manual_aria")}
          >
            {t("multi_flag.tutorial_manual_button")}
          </Button>
          <Button variant="primary" onClick={() => navigate(`/problems/${LOCAL_DRILL_JOB_ID}`)}>
            {t("multi_flag.tutorial_local_button")}
          </Button>
          <Button onClick={() => navigate(`/problems/${LITE_DRILL_JOB_ID}`)}>
            {t("multi_flag.tutorial_lite_button")}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}

/**
 * #2711 follow-up: 提出欄の label / description / placeholder を strict ドリルか否かで出し分ける
 * pure helper。 厳密ドリル (= what-is / local / lite) はクイズ回答欄なので 「(deployment output
 * value)」 接尾辞と 「部分一致 / Easter egg OK」 の demo helper が誤案内になる — 素の label +
 * 正直な drill 文言に差し替える。
 */
export function subFlagFieldPresentation(
  strict: boolean,
  isMock: boolean,
  label: string,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): { label: string; description: string | undefined; placeholder: string } {
  if (strict) {
    return {
      label,
      description: isMock ? t("problem_panel.flag_drill_hint") : undefined,
      placeholder: t("problem_panel.flag_drill_placeholder"),
    };
  }
  return {
    label: t("multi_flag.flag_field_label", { label }),
    description: isMock ? t("problem_panel.flag_mock_hint") : undefined,
    placeholder: isMock
      ? t("problem_panel.flag_mock_placeholder")
      : t("problem_panel.flag_placeholder"),
  };
}

interface SubFlagRowProps {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flag: MultiFlagEntryView;
  solved: boolean;
  onMockSolved: (flagId: string) => void;
  onScored: () => Promise<void>;
  revealOrder?: HintRevealMode;
  onHintRevealed?: (hintId: string) => void;
  onSubmitted?: (outcome: SubmitFlagOutcome) => void;
  value: string;
  values: Readonly<Record<string, string>>;
  onValueChange: (value: string) => void;
  prepareSubmission?: (flagId: string, values: Readonly<Record<string, string>>) => Promise<string>;
}

function canSubmitSubFlag(
  value: string,
  input: MultiFlagEntryView["input"],
  prepareSubmission: SubFlagRowProps["prepareSubmission"],
): boolean {
  return value.trim().length > 0 || (prepareSubmission !== undefined && input === "multiline");
}

function revealedHintCountLabel(
  count: number,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  return t(
    count === 1 ? "multi_flag.review_hint_count_one" : "multi_flag.review_hint_count_other",
    { count },
  );
}

function SolvedSubFlagReview({
  flag,
  label,
  celebrate,
}: {
  readonly flag: MultiFlagEntryView;
  readonly label: string;
  readonly celebrate: boolean;
}) {
  const t = useT();
  const revealedHints = (flag.hints ?? []).flatMap((hint, index) =>
    hint.revealed ? [{ hint, index }] : [],
  );
  const hintCount = revealedHintCountLabel(revealedHints.length, t);

  return (
    <>
      {celebrate && <CelebrationOverlay visible />}
      <ExpandableSection
        variant="container"
        defaultExpanded={false}
        headingTagOverride="h3"
        headerText={t("multi_flag.solved_header", { label })}
        headerDescription={t("multi_flag.review_summary", {
          points: flag.points,
          hintCount,
        })}
        headerAriaLabel={t("multi_flag.review_aria", { label, hintCount })}
      >
        {revealedHints.length === 0 ? (
          <Box color="text-body-secondary">{t("multi_flag.review_no_hints")}</Box>
        ) : (
          <SpaceBetween size="s">
            {revealedHints.map(({ hint, index }) => (
              <Box key={hint.id}>
                <strong>{t("problem_panel.hint_label_colon", { index: index + 1 })}</strong>{" "}
                <span style={{ color: hint.penalty > 0 ? "#b54708" : "#475467" }}>
                  {hint.penalty > 0
                    ? t("multi_flag.review_hint_penalty", { penalty: hint.penalty })
                    : t("multi_flag.review_hint_no_penalty")}
                </span>
                {hint.content && <Box margin={{ top: "xxs" }}>{hint.content}</Box>}
              </Box>
            ))}
          </SpaceBetween>
        )}
      </ExpandableSection>
    </>
  );
}

function SubFlagRow({
  apiBaseUrl,
  sessionToken,
  problemId,
  flag,
  solved,
  onMockSolved,
  onScored,
  revealOrder,
  onHintRevealed,
  onSubmitted,
  value,
  values,
  onValueChange,
  prepareSubmission,
}: SubFlagRowProps) {
  const t = useT();
  const lang = useLang();
  // [#2252] i18n.en.checks 由来の label 訳 (multi-verify)。 無ければ ja label に fallback。
  const label = lang === "en" && flag.i18n?.en?.label ? flag.i18n.en.label : flag.label;
  // dev-mock mode のとき submit を backend に投げず evaluateMockSubFlag で local 評価する
  // (= 単一 flag kind の FlagSubmissionPanel と同方針。 ドリル問題のみ per-flag 判定)。
  const isMock = useIsMock();
  const field = subFlagFieldPresentation(isStrictDrillProblem(problemId), isMock, label, t);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 正解直後 (mock / backend 共通): 祝祭 + 獲得スコア。 server 由来の solved 表示も同じ success
  // review row に倒すので、 「refetch が空振りして solved に切り替わらない」 mock mode も吸収できる。
  // review は revealed=true の hint だけを表示し、 reveal / score API を呼ぶ操作を持たない。
  if (solved || outcome?.kind === "ok") {
    return <SolvedSubFlagReview flag={flag} label={label} celebrate={outcome?.kind === "ok"} />;
  }

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!canSubmitSubFlag(value, flag.input, prepareSubmission) || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setOutcome(null);
    try {
      const submission = prepareSubmission ? await prepareSubmission(flag.id, values) : value;
      const result = isMock
        ? evaluateMockSubFlag(problemId, flag.id, submission, flag.points)
        : await submitFlag(apiBaseUrl, sessionToken, problemId, submission, flag.id);
      setOutcome(result);
      onSubmitted?.(result);
      switch (result.kind) {
        case "ok":
          if (isMock) onMockSolved(flag.id);
          else await onScored();
          break;
        default:
          break;
      }
    } catch (err) {
      setSubmitError(formatProblemPanelActionError(t, err, "problem_panel.submit_error_prefix"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SpaceBetween size="xs">
      <form onSubmit={handleSubmit}>
        <Form
          actions={
            <Button variant="primary" loading={submitting} formAction="submit">
              {t("multi_flag.submit_button", { points: flag.points })}
            </Button>
          }
        >
          <FormField label={field.label} description={field.description}>
            {prepareSubmission !== undefined && flag.input === "multiline" ? (
              <Box color="text-body-secondary">{t("multi_flag.editor_source_description")}</Box>
            ) : flag.input === "multiline" ? (
              <Textarea
                value={value}
                onChange={(e) => onValueChange(e.detail.value)}
                placeholder={field.placeholder}
                disabled={submitting}
                rows={10}
              />
            ) : (
              <Input
                value={value}
                onChange={(e) => onValueChange(e.detail.value)}
                placeholder={field.placeholder}
                disabled={submitting}
              />
            )}
          </FormField>
        </Form>
      </form>
      {outcome?.kind === "wrong" && (
        <Alert
          type="warning"
          header={
            outcome.scoreDelta < 0
              ? t("problem_panel.wrong_with_penalty_header", {
                  delta: outcome.scoreDelta,
                  total: outcome.totalScore,
                })
              : t("problem_panel.wrong_header")
          }
        >
          {outcome.scoreDelta < 0
            ? t("problem_panel.wrong_with_penalty_body", {
                count: outcome.wrongCount,
                penalty: -outcome.scoreDelta,
              })
            : t("problem_panel.wrong_body")}
        </Alert>
      )}
      {outcome?.kind === "already_scored" && (
        <Alert type="info" header={t("problem_panel.already_scored_header")}>
          {t("problem_panel.already_scored_body", { total: outcome.totalScore })}
        </Alert>
      )}
      {submitError && (
        <Alert type="error" header={t("problem_panel.submit_failed_header")}>
          {submitError}
        </Alert>
      )}
      {/* [#2252] multi-verify: per-check progressive hints。 flat reveal route を再利用。
          revealOrder="flat" のとき各 check の hint 順序ゲートを外す。 */}
      {flag.hints && flag.hints.length > 0 && (
        <HintsPanel
          apiBaseUrl={apiBaseUrl}
          sessionToken={sessionToken}
          problemId={problemId}
          hints={flag.hints}
          onRevealed={onScored}
          revealOrder={revealOrder}
          onRevealTracked={onHintRevealed}
        />
      )}
    </SpaceBetween>
  );
}
