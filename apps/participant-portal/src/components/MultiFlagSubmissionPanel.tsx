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
}

interface TutorialStepSpec {
  readonly id: string;
  readonly titleKey: string;
  readonly scenarioKey: string;
  readonly termKey: string;
  readonly questionKey: string;
  readonly choices: readonly TutorialChoiceSpec[];
  readonly successKey: string;
  readonly submitsFlag?: boolean;
}

const PRACTICE_FLAG_ID = "first-flag";
const PRACTICE_FLAG_VALUE = "TC{HELLO-TENKACLOUD}";
const PARTICIPANT_MANUAL_URL = "https://tenkacloud.com/docs/manual/participant/";

const TUTORIAL_STEP_SPECS: readonly TutorialStepSpec[] = [
  {
    id: "real-cloud",
    titleKey: "onboarding_tutorial.step_1.title",
    scenarioKey: "onboarding_tutorial.step_1.scenario",
    termKey: "onboarding_tutorial.step_1.term",
    questionKey: "onboarding_tutorial.step_1.question",
    choices: [
      {
        value: "real-cloud-practice",
        correct: true,
        labelKey: "onboarding_tutorial.step_1.correct_label",
        descriptionKey: "onboarding_tutorial.step_1.correct_description",
      },
      {
        value: "word-quiz",
        correct: false,
        labelKey: "onboarding_tutorial.step_1.wrong_label",
        descriptionKey: "onboarding_tutorial.step_1.wrong_description",
      },
    ],
    successKey: "onboarding_tutorial.step_1.success",
  },
  {
    id: "battle-challenge",
    titleKey: "onboarding_tutorial.step_2.title",
    scenarioKey: "onboarding_tutorial.step_2.scenario",
    termKey: "onboarding_tutorial.step_2.term",
    questionKey: "onboarding_tutorial.step_2.question",
    choices: [
      {
        value: "battle",
        correct: true,
        labelKey: "onboarding_tutorial.step_2.correct_label",
        descriptionKey: "onboarding_tutorial.step_2.correct_description",
      },
      {
        value: "challenge",
        correct: false,
        labelKey: "onboarding_tutorial.step_2.wrong_label",
        descriptionKey: "onboarding_tutorial.step_2.wrong_description",
      },
    ],
    successKey: "onboarding_tutorial.step_2.success",
  },
  {
    id: "choose-mode",
    titleKey: "onboarding_tutorial.step_3.title",
    scenarioKey: "onboarding_tutorial.step_3.scenario",
    termKey: "onboarding_tutorial.step_3.term",
    questionKey: "onboarding_tutorial.step_3.question",
    choices: [
      {
        value: "local",
        correct: true,
        labelKey: "onboarding_tutorial.step_3.local_label",
        descriptionKey: "onboarding_tutorial.step_3.local_description",
      },
      {
        value: "lite",
        correct: true,
        labelKey: "onboarding_tutorial.step_3.lite_label",
        descriptionKey: "onboarding_tutorial.step_3.lite_description",
      },
      {
        value: "saas",
        correct: true,
        labelKey: "onboarding_tutorial.step_3.saas_label",
        descriptionKey: "onboarding_tutorial.step_3.saas_description",
      },
    ],
    successKey: "onboarding_tutorial.step_3.success",
  },
  {
    id: "read-problem",
    titleKey: "onboarding_tutorial.step_4.title",
    scenarioKey: "onboarding_tutorial.step_4.scenario",
    termKey: "onboarding_tutorial.step_4.term",
    questionKey: "onboarding_tutorial.step_4.question",
    choices: [
      {
        value: "read-goal",
        correct: true,
        labelKey: "onboarding_tutorial.step_4.correct_label",
        descriptionKey: "onboarding_tutorial.step_4.correct_description",
      },
      {
        value: "guess-from-title",
        correct: false,
        labelKey: "onboarding_tutorial.step_4.wrong_label",
        descriptionKey: "onboarding_tutorial.step_4.wrong_description",
      },
    ],
    successKey: "onboarding_tutorial.step_4.success",
  },
  {
    id: "start-environment",
    titleKey: "onboarding_tutorial.step_5.title",
    scenarioKey: "onboarding_tutorial.step_5.scenario",
    termKey: "onboarding_tutorial.step_5.term",
    questionKey: "onboarding_tutorial.step_5.question",
    choices: [
      {
        value: "start-and-investigate",
        correct: true,
        labelKey: "onboarding_tutorial.step_5.correct_label",
        descriptionKey: "onboarding_tutorial.step_5.correct_description",
      },
      {
        value: "submit-without-start",
        correct: false,
        labelKey: "onboarding_tutorial.step_5.wrong_label",
        descriptionKey: "onboarding_tutorial.step_5.wrong_description",
      },
    ],
    successKey: "onboarding_tutorial.step_5.success",
  },
  {
    id: PRACTICE_FLAG_ID,
    titleKey: "onboarding_tutorial.step_6.title",
    scenarioKey: "onboarding_tutorial.step_6.scenario",
    termKey: "onboarding_tutorial.step_6.term",
    questionKey: "onboarding_tutorial.step_6.question",
    choices: [],
    successKey: "onboarding_tutorial.step_6.success",
    submitsFlag: true,
  },
];

export function isWhatIsTutorialShape(flags: readonly MultiFlagEntryView[]): boolean {
  return flags.length === 1 && flags[0]?.id === PRACTICE_FLAG_ID;
}

function tutorialSuccessHeader(
  spec: TutorialStepSpec,
  points: number,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  if (spec.submitsFlag) {
    return t("onboarding_tutorial.correct_header", { points });
  }
  return t("onboarding_tutorial.step_complete_header");
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
  // at panel level (so the progress counter can reach the last step and reveal the
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
  const scoringFlag = flags[0];
  const restoredComplete = isSolved(scoringFlag);
  const [activeIndex, setActiveIndex] = useState(
    restoredComplete ? TUTORIAL_STEP_SPECS.length - 1 : 0,
  );
  const [completedSteps, setCompletedSteps] = useState<ReadonlySet<number>>(() =>
    restoredComplete ? new Set(TUTORIAL_STEP_SPECS.map((_, index) => index)) : new Set(),
  );
  const [wrongStep, setWrongStep] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | undefined>();
  const [practiceFlag, setPracticeFlag] = useState(PRACTICE_FLAG_VALUE);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (activeIndex > 0) headingRef.current?.focus();
  }, [activeIndex]);

  const finalSubmitted =
    restoredComplete || outcome?.kind === "ok" || outcome?.kind === "already_scored";
  const completedCount = finalSubmitted ? TUTORIAL_STEP_SPECS.length : completedSteps.size;
  const allSolved = completedCount === TUTORIAL_STEP_SPECS.length;
  const activeSpec = TUTORIAL_STEP_SPECS[activeIndex];
  const activeCompleted = activeSpec.submitsFlag ? finalSubmitted : completedSteps.has(activeIndex);
  const progress = Math.round((completedCount / TUTORIAL_STEP_SPECS.length) * 100);

  const submitPracticeFlag = async (): Promise<void> => {
    if (submittingRef.current) return;
    if (practiceFlag.trim().length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = isMock
        ? evaluateMockSubFlag(problemId, scoringFlag.id, practiceFlag, scoringFlag.points)
        : await submitFlag(apiBaseUrl, sessionToken, problemId, practiceFlag, scoringFlag.id);
      setOutcome(result);
      if (result.kind === "ok") {
        if (isMock) onMockSolved(scoringFlag.id);
        else await onScored();
      } else if (result.kind === "already_scored") {
        await onScored();
      }
    } catch (err) {
      setSubmitError(formatProblemPanelActionError(t, err, "problem_panel.submit_error_prefix"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const selectChoice = (choice: TutorialChoiceSpec): void => {
    if (!choice.correct) {
      setWrongStep(activeIndex);
      return;
    }
    setWrongStep(null);
    setCompletedSteps((current) => new Set([...current, activeIndex]));
  };

  return (
    <div className="tc-onboarding" data-testid="what-is-tutorial">
      {outcome?.kind === "ok" && <CelebrationOverlay visible />}
      <div className="tc-onboarding__progress">
        <div className="tc-onboarding__progress-label">
          <span>
            {t("onboarding_tutorial.progress", {
              current: activeIndex + 1,
              total: TUTORIAL_STEP_SPECS.length,
            })}
          </span>
          <span>
            {t("onboarding_tutorial.cleared", {
              solved: completedCount,
              total: TUTORIAL_STEP_SPECS.length,
            })}
          </span>
        </div>
        <div
          className="tc-onboarding__progress-track"
          role="progressbar"
          aria-label={t("onboarding_tutorial.progress_aria")}
          aria-valuemin={0}
          aria-valuemax={TUTORIAL_STEP_SPECS.length}
          aria-valuenow={completedCount}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      <section className="tc-onboarding__step" aria-labelledby={`tutorial-${activeSpec.id}`}>
        <p className="tc-onboarding__eyebrow">
          {t("onboarding_tutorial.step", { current: activeIndex + 1 })}
          {activeSpec.submitsFlag && (
            <span className="tc-onboarding__points">
              {t("onboarding_tutorial.points", { points: scoringFlag.points })}
            </span>
          )}
        </p>
        <h3
          id={`tutorial-${activeSpec.id}`}
          className="tc-onboarding__title"
          ref={headingRef}
          tabIndex={-1}
        >
          {t(activeSpec.titleKey)}
        </h3>
        <p className="tc-onboarding__scenario">{t(activeSpec.scenarioKey)}</p>
        <p className="tc-onboarding__term">
          <strong>{t("onboarding_tutorial.term_label")}</strong>
          <span>{t(activeSpec.termKey)}</span>
        </p>

        <div className="tc-onboarding__question">
          <p className="tc-onboarding__question-label">{t(activeSpec.questionKey)}</p>
          {activeSpec.submitsFlag ? (
            <form
              className="tc-onboarding__submission"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPracticeFlag();
              }}
            >
              <FormField
                label={t("onboarding_tutorial.step_6.field_label")}
                description={t("onboarding_tutorial.step_6.field_description")}
              >
                <Input
                  value={practiceFlag}
                  onChange={(event) => setPracticeFlag(event.detail.value)}
                  disabled={submitting || activeCompleted}
                />
              </FormField>
              <div className="tc-onboarding__submit-action">
                <Button
                  variant="primary"
                  formAction="submit"
                  loading={submitting}
                  disabled={activeCompleted}
                >
                  {t("onboarding_tutorial.step_6.submit_button", {
                    points: scoringFlag.points,
                  })}
                </Button>
              </div>
            </form>
          ) : (
            <div className="tc-onboarding__choices">
              {activeSpec.choices.map((choice) => (
                <button
                  className="tc-onboarding__choice"
                  type="button"
                  key={choice.value}
                  disabled={activeCompleted}
                  onClick={() => selectChoice(choice)}
                >
                  <span className="tc-onboarding__choice-copy">
                    <strong>{t(choice.labelKey)}</strong>
                    <span>{t(choice.descriptionKey)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tc-onboarding__feedback" aria-live="polite">
          {wrongStep === activeIndex && (
            <Alert type="warning" header={t("onboarding_tutorial.wrong_header")}>
              {t("onboarding_tutorial.wrong_body")}
            </Alert>
          )}
          {outcome?.kind === "wrong" && activeSpec.submitsFlag && (
            <Alert type="warning" header={t("onboarding_tutorial.submission_wrong_header")}>
              {t("onboarding_tutorial.submission_wrong_body")}
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
          {activeCompleted && outcome?.kind !== "already_scored" && (
            <Alert type="success" header={tutorialSuccessHeader(activeSpec, scoringFlag.points, t)}>
              {t(activeSpec.successKey)}
            </Alert>
          )}
        </div>

        {activeCompleted && !allSolved && (
          <div className="tc-onboarding__next">
            <Button
              variant="primary"
              onClick={() => {
                setWrongStep(null);
                setActiveIndex((current) => Math.min(current + 1, TUTORIAL_STEP_SPECS.length - 1));
              }}
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
