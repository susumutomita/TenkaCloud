import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
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
 * - 未 solved な flag: label 付き Textarea + submit Button (= per-flag の submitting state)
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
}) {
  const t = useT();
  const isMock = useIsMock();
  const [mockSolvedIds, setMockSolvedIds] = useState<ReadonlySet<string>>(() =>
    isMock ? loadMockSolvedFlagIds(problemId) : new Set(),
  );
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
}: {
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
}) {
  const t = useT();
  const lang = useLang();
  const label = lang === "en" && flag.i18n?.en?.label ? flag.i18n.en.label : flag.label;
  const isMock = useIsMock();
  const field = subFlagFieldPresentation(isStrictDrillProblem(problemId), isMock, label, t);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (solved || outcome?.kind === "ok") {
    return (
      <>
        {outcome?.kind === "ok" && <CelebrationOverlay visible />}
        <Alert type="success" header={t("multi_flag.solved_header", { label })}>
          {t("multi_flag.solved_body", { points: flag.points })}
        </Alert>
      </>
    );
  }

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (value.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setOutcome(null);
    try {
      const result = isMock
        ? evaluateMockSubFlag(problemId, flag.id, value, flag.points)
        : await submitFlag(apiBaseUrl, sessionToken, problemId, value, flag.id);
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
            <Textarea
              value={value}
              onChange={(e) => setValue(e.detail.value)}
              placeholder={field.placeholder}
              disabled={submitting}
              rows={6}
              ariaLabel={field.label}
            />
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
