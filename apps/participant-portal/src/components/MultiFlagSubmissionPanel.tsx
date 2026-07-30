import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
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
import { CelebrationOverlay } from "./CelebrationOverlay";
import { formatProblemPanelActionError } from "./ProblemPanel.helpers";
import { HintsPanel } from "./ProblemPanelFlagSubmission";
import "./OnboardingTutorial.css";

interface TutorialChoiceSpec {
  readonly value: string;
  readonly correct: boolean;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly successKey: string;
}

interface TutorialStepSpec {
  readonly titleKey: string;
  readonly scenarioKey: string;
  readonly questionKey: string;
  readonly choices: readonly TutorialChoiceSpec[];
}

const TUTORIAL_STEP_SPECS: Readonly<Record<string, TutorialStepSpec>> = {
  "tenka-what": {
    titleKey: "onboarding_tutorial.step_1.title",
    scenarioKey: "onboarding_tutorial.step_1.scenario",
    questionKey: "onboarding_tutorial.step_1.question",
    choices: [
      {
        value: "real cloud",
        correct: true,
        labelKey: "onboarding_tutorial.step_1.cloud_label",
        descriptionKey: "onboarding_tutorial.step_1.cloud_description",
        successKey: "onboarding_tutorial.step_1.success",
      },
      {
        value: "paper",
        correct: false,
        labelKey: "onboarding_tutorial.step_1.paper_label",
        descriptionKey: "onboarding_tutorial.step_1.paper_description",
        successKey: "onboarding_tutorial.step_1.success",
      },
    ],
  },
  "battle-challenge": {
    titleKey: "onboarding_tutorial.step_2.title",
    scenarioKey: "onboarding_tutorial.step_2.scenario",
    questionKey: "onboarding_tutorial.step_2.question",
    choices: [
      {
        value: "battle",
        correct: true,
        labelKey: "onboarding_tutorial.step_2.battle_label",
        descriptionKey: "onboarding_tutorial.step_2.battle_description",
        successKey: "onboarding_tutorial.step_2.success",
      },
      {
        value: "challenge",
        correct: false,
        labelKey: "onboarding_tutorial.step_2.challenge_label",
        descriptionKey: "onboarding_tutorial.step_2.challenge_description",
        successKey: "onboarding_tutorial.step_2.success",
      },
    ],
  },
  "choose-mode": {
    titleKey: "onboarding_tutorial.step_3.title",
    scenarioKey: "onboarding_tutorial.step_3.scenario",
    questionKey: "onboarding_tutorial.step_3.question",
    choices: [
      {
        value: "local",
        correct: true,
        labelKey: "onboarding_tutorial.step_3.local_label",
        descriptionKey: "onboarding_tutorial.step_3.local_description",
        successKey: "onboarding_tutorial.step_3.local_success",
      },
      {
        value: "lite",
        correct: true,
        labelKey: "onboarding_tutorial.step_3.lite_label",
        descriptionKey: "onboarding_tutorial.step_3.lite_description",
        successKey: "onboarding_tutorial.step_3.lite_success",
      },
    ],
  },
  "first-flag": {
    titleKey: "onboarding_tutorial.step_4.title",
    scenarioKey: "onboarding_tutorial.step_4.scenario",
    questionKey: "onboarding_tutorial.step_4.question",
    choices: [
      {
        value: "TC{HELLO-TENKACLOUD}",
        correct: true,
        labelKey: "onboarding_tutorial.step_4.submit_label",
        descriptionKey: "onboarding_tutorial.step_4.submit_description",
        successKey: "onboarding_tutorial.step_4.success",
      },
    ],
  },
};

export function isWhatIsTutorialShape(flags: readonly MultiFlagEntryView[]): boolean {
  return (
    flags.length === 4 &&
    flags.every((flag, index) => {
      const expected = ["tenka-what", "battle-challenge", "choose-mode", "first-flag"][index];
      return flag.id === expected && TUTORIAL_STEP_SPECS[flag.id] !== undefined;
    })
  );
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
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flags: readonly MultiFlagEntryView[];
  onScored: () => Promise<void>;
  /** 問題 `scoring.hintReveal`; `"flat"` で各 sub-flag の hint 順序ゲートを外す。 */
  revealOrder?: HintRevealMode;
}) {
  const t = useT();
  const isMock = useIsMock();
  // dev-mock has no backend refetch to persist solved flags. Keep the solved ids
  // at panel level (so the progress counter can reach 4/4 and reveal the
  // completion handoff) and mirror them into the sessionStorage progress store —
  // without it, navigating away unmounts the panel and the demo looks reset.
  const [mockSolvedIds, setMockSolvedIds] = useState<ReadonlySet<string>>(() =>
    isMock ? loadMockSolvedFlagIds(problemId) : new Set(),
  );
  const isSolved = (flag: MultiFlagEntryView) => flag.solved || mockSolvedIds.has(flag.id);
  const solvedCount = flags.filter(isSolved).length;
  const allSolved = flags.length > 0 && solvedCount === flags.length;

  if (problemId === WHAT_IS_DRILL_PROBLEM_ID && isWhatIsTutorialShape(flags)) {
    return (
      <WhatIsTutorialWizard
        apiBaseUrl={apiBaseUrl}
        sessionToken={sessionToken}
        problemId={problemId}
        flags={flags}
        isSolved={isSolved}
        onMockSolved={(flagId) => {
          setMockSolvedIds((current) => new Set([...current, flagId]));
          saveMockSolvedFlagId(problemId, flagId);
        }}
        onScored={onScored}
      />
    );
  }

  return (
    <SpaceBetween size="s">
      <Alert
        type={allSolved ? "success" : "info"}
        header={t("multi_flag.progress_header", { solved: solvedCount, total: flags.length })}
      >
        {allSolved ? t("multi_flag.all_solved_body") : t("multi_flag.progress_body")}
      </Alert>
      {flags.map((flag) => (
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
        />
      ))}
    </SpaceBetween>
  );
}

function WhatIsTutorialWizard({
  apiBaseUrl,
  sessionToken,
  problemId,
  flags,
  isSolved,
  onMockSolved,
  onScored,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flags: readonly MultiFlagEntryView[];
  isSolved: (flag: MultiFlagEntryView) => boolean;
  onMockSolved: (flagId: string) => void;
  onScored: () => Promise<void>;
}) {
  const t = useT();
  const isMock = useIsMock();
  const initialUnsolved = flags.findIndex((flag) => !isSolved(flag));
  const [activeIndex, setActiveIndex] = useState(
    initialUnsolved === -1 ? flags.length - 1 : initialUnsolved,
  );
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, SubmitFlagOutcome | undefined>>>(
    {},
  );
  const [successKeys, setSuccessKeys] = useState<Readonly<Record<string, string>>>({});
  const [submittingFlagId, setSubmittingFlagId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (activeIndex > 0) headingRef.current?.focus();
  }, [activeIndex]);

  const completed = (flag: MultiFlagEntryView): boolean => {
    const outcome = outcomes[flag.id];
    return isSolved(flag) || outcome?.kind === "ok" || outcome?.kind === "already_scored";
  };
  const completedCount = flags.filter(completed).length;
  const allSolved = completedCount === flags.length;
  const activeFlag = flags[activeIndex];
  const activeSpec = TUTORIAL_STEP_SPECS[activeFlag.id];
  const activeOutcome = outcomes[activeFlag.id];
  const activeCompleted = completed(activeFlag);
  const progress = Math.round((completedCount / flags.length) * 100);

  const submitChoice = async (choice: TutorialChoiceSpec): Promise<void> => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmittingFlagId(activeFlag.id);
    setSubmitError(null);
    try {
      const result = isMock
        ? evaluateMockSubFlag(problemId, activeFlag.id, choice.value, activeFlag.points)
        : await submitFlag(apiBaseUrl, sessionToken, problemId, choice.value, activeFlag.id);
      setOutcomes((current) => ({ ...current, [activeFlag.id]: result }));
      if (result.kind === "ok") {
        setSuccessKeys((current) => ({ ...current, [activeFlag.id]: choice.successKey }));
        if (isMock) onMockSolved(activeFlag.id);
        else await onScored();
      } else if (result.kind === "already_scored") {
        await onScored();
      }
    } catch (err) {
      setSubmitError(formatProblemPanelActionError(t, err, "problem_panel.submit_error_prefix"));
    } finally {
      submittingRef.current = false;
      setSubmittingFlagId(null);
    }
  };

  const selectChoice = (choice: TutorialChoiceSpec): void => {
    if (choice.correct) {
      void submitChoice(choice);
      return;
    }
    setOutcomes((current) => ({
      ...current,
      [activeFlag.id]: { kind: "wrong", scoreDelta: 0, totalScore: 0, wrongCount: 1 },
    }));
  };

  return (
    <div className="tc-onboarding" data-testid="what-is-tutorial">
      {activeOutcome?.kind === "ok" && <CelebrationOverlay visible />}
      <div className="tc-onboarding__progress">
        <div className="tc-onboarding__progress-label">
          <span>
            {t("onboarding_tutorial.progress", { current: activeIndex + 1, total: flags.length })}
          </span>
          <span>
            {t("onboarding_tutorial.cleared", { solved: completedCount, total: flags.length })}
          </span>
        </div>
        <div
          className="tc-onboarding__progress-track"
          role="progressbar"
          aria-label={t("onboarding_tutorial.progress_aria")}
          aria-valuemin={0}
          aria-valuemax={flags.length}
          aria-valuenow={completedCount}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      <section className="tc-onboarding__step" aria-labelledby={`tutorial-${activeFlag.id}`}>
        <p className="tc-onboarding__eyebrow">
          {t("onboarding_tutorial.mission", { current: activeIndex + 1 })}
          <span className="tc-onboarding__points">
            {t("onboarding_tutorial.points", { points: activeFlag.points })}
          </span>
        </p>
        <h3
          id={`tutorial-${activeFlag.id}`}
          className="tc-onboarding__title"
          ref={headingRef}
          tabIndex={-1}
        >
          {t(activeSpec.titleKey)}
        </h3>
        <p className="tc-onboarding__scenario">{t(activeSpec.scenarioKey)}</p>

        <div className="tc-onboarding__question">
          <p className="tc-onboarding__question-label">{t(activeSpec.questionKey)}</p>
          <div className="tc-onboarding__choices">
            {activeSpec.choices.map((choice) => (
              <button
                className="tc-onboarding__choice"
                type="button"
                key={choice.value}
                disabled={submittingFlagId !== null || activeCompleted}
                onClick={() => selectChoice(choice)}
              >
                <span className="tc-onboarding__choice-copy">
                  <strong>{t(choice.labelKey)}</strong>
                  <span>{t(choice.descriptionKey)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="tc-onboarding__feedback" aria-live="polite">
          {activeOutcome?.kind === "wrong" && (
            <Alert type="warning" header={t("onboarding_tutorial.wrong_header")}>
              {t("onboarding_tutorial.wrong_body")}
            </Alert>
          )}
          {activeOutcome?.kind === "already_scored" && (
            <Alert type="info" header={t("problem_panel.already_scored_header")}>
              {t("problem_panel.already_scored_body", { total: activeOutcome.totalScore })}
            </Alert>
          )}
          {submitError && (
            <Alert type="error" header={t("problem_panel.submit_failed_header")}>
              {submitError}
            </Alert>
          )}
          {activeCompleted && activeOutcome?.kind !== "already_scored" && (
            <Alert
              type="success"
              header={t("onboarding_tutorial.correct_header", { points: activeFlag.points })}
            >
              {t(successKeys[activeFlag.id] ?? activeSpec.choices[0].successKey)}
            </Alert>
          )}
        </div>

        {activeCompleted && !allSolved && (
          <div className="tc-onboarding__next">
            <Button
              variant="primary"
              onClick={() => setActiveIndex((current) => Math.min(current + 1, flags.length - 1))}
            >
              {t("onboarding_tutorial.next_button")}
            </Button>
          </div>
        )}
      </section>

      {allSolved && <WhatIsTutorialComplete />}
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

function SubFlagRow({
  apiBaseUrl,
  sessionToken,
  problemId,
  flag,
  solved,
  onMockSolved,
  onScored,
  revealOrder,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flag: MultiFlagEntryView;
  solved: boolean;
  onMockSolved: (flagId: string) => void;
  onScored: () => Promise<void>;
  revealOrder?: HintRevealMode;
}) {
  const t = useT();
  const lang = useLang();
  // [#2252] i18n.en.checks 由来の label 訳 (multi-verify)。 無ければ ja label に fallback。
  const label = lang === "en" && flag.i18n?.en?.label ? flag.i18n.en.label : flag.label;
  // dev-mock mode のとき submit を backend に投げず evaluateMockSubFlag で local 評価する
  // (= 単一 flag kind の FlagSubmissionPanel と同方針。 ドリル問題のみ per-flag 判定)。
  const isMock = useIsMock();
  const field = subFlagFieldPresentation(isStrictDrillProblem(problemId), isMock, label, t);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 正解直後 (mock / backend 共通): 祝祭 + 獲得スコア。 server 由来の solved 表示も同じ success
  // Alert に倒すので、 「refetch が空振りして solved に切り替わらない」 mock mode も吸収できる。
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
            <Input
              value={value}
              onChange={(e) => setValue(e.detail.value)}
              placeholder={field.placeholder}
              disabled={submitting}
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
        />
      )}
    </SpaceBetween>
  );
}
