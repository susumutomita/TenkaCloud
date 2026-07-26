/**
 * 課題 1 つ分の UI: 実装エディタ相当の雛形 → 入力欄 → 自動採点 → 段階ヒント → AI サポート
 *
 * **学習者のコードはブラウザ内で実行しない。** `eval` / `new Function` はプラットフォーム全体で
 * 禁止しており (CLAUDE.md「Security」)、教材のためにその境界を緩めない。代わりに
 * 「手元で関数を書き、示された複数の入力に対する出力を貼る」形にする。複数入力を並べるのは
 * 自分で実装した方が早い状態を作るためで、実装の存在を証明するものではない (期待値は bundle
 * から読める)。得られるのは自分の出力が合っているかという自己学習のフィードバックだけである。
 *
 * AI サポートも同じ理由で **プラットフォームから LLM を呼ばない**。組み立てたプロンプトを
 * 読み取り専用の欄に出し、学習者自身の Claude Code へ貼ってもらう。
 */

import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import RadioGroup from "@cloudscape-design/components/radio-group";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import {
  buildCoachPrompt,
  type CaseVerdict,
  type CoachMode,
  type DrillProgress,
  type DrillSection,
  type DrillTask,
  type GradeResult,
  gradeTask,
  hasMoreHints,
  isValueTask,
  type LocaleCode,
  localize,
  taskProgress,
  visibleHints,
} from "@tenkacloud/crypto-drill";
import { useState } from "react";
import "./crypto-drill.css";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const VERDICT_KEYS: Readonly<Record<CaseVerdict, string>> = {
  correct: "crypto_drill.verdict_correct",
  incorrect: "crypto_drill.verdict_incorrect",
  malformed: "crypto_drill.verdict_malformed",
  empty: "crypto_drill.verdict_empty",
};

/** 判定 → 表示する i18n キー。 */
export function verdictKey(verdict: CaseVerdict): string {
  return VERDICT_KEYS[verdict];
}

/** 判定 → Badge の色。正解以外は「間違い」ではなく「まだ通っていない」として同じ扱いにする。 */
export function verdictColor(verdict: CaseVerdict): "green" | "red" | "grey" {
  if (verdict === "correct") return "green";
  if (verdict === "empty") return "grey";
  return "red";
}

function CaseResults({ result, t }: { readonly result: GradeResult; readonly t: Translate }) {
  return (
    <SpaceBetween size="xxs">
      {result.cases.map((entry) => (
        <Box key={entry.caseId} data-testid={`case-result-${entry.caseId}`}>
          <SpaceBetween size="xs" direction="horizontal">
            <Badge color={verdictColor(entry.verdict)}>{t(verdictKey(entry.verdict))}</Badge>
            <span className="tc-drill-mono">{entry.caseId}</span>
            {entry.verdict === "incorrect" || entry.verdict === "malformed" ? (
              <Box variant="small" color="text-body-secondary">
                {t("crypto_drill.read_as", { value: entry.normalized })}
              </Box>
            ) : null}
          </SpaceBetween>
        </Box>
      ))}
    </SpaceBetween>
  );
}

export interface DrillTaskCardProps {
  readonly drillTitle: string;
  readonly section: DrillSection;
  readonly task: DrillTask;
  readonly progress: DrillProgress;
  readonly locale: LocaleCode;
  readonly t: Translate;
  readonly onAttempt: (taskId: string, passed: boolean) => void;
  readonly onRevealHint: (taskId: string, hintCount: number) => void;
}

export function DrillTaskCard({
  drillTitle,
  section,
  task,
  progress,
  locale,
  t,
  onAttempt,
  onRevealHint,
}: DrillTaskCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [coachPrompt, setCoachPrompt] = useState<string | null>(null);
  const state = taskProgress(progress, task.id);

  function grade() {
    const submission = isValueTask(task)
      ? ({ kind: "value", answers } as const)
      : ({ kind: "choice", selected } as const);
    const graded = gradeTask(task, submission);
    setResult(graded);
    onAttempt(task.id, graded.passed);
  }

  function showCoachPrompt(mode: CoachMode) {
    setCoachPrompt(
      buildCoachPrompt({
        drillTitle,
        section,
        task,
        locale,
        mode,
        attempts: state.attempts,
      }),
    );
  }

  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={
            state.completed ? <Badge color="green">{t("crypto_drill.task_done")}</Badge> : undefined
          }
          description={localize(task.instruction, locale)}
        >
          {localize(task.title, locale)}
        </Header>
      }
      data-testid={`drill-task-${task.id}`}
    >
      <SpaceBetween size="m">
        {isValueTask(task) && task.starter !== undefined && (
          <ExpandableSection headerText={t("crypto_drill.starter_header")}>
            <div className="tc-drill-scroll">
              <pre className="tc-drill-starter">{task.starter}</pre>
            </div>
            <Box variant="small" color="text-body-secondary">
              {t("crypto_drill.starter_note")}
            </Box>
          </ExpandableSection>
        )}

        {isValueTask(task) ? (
          <SpaceBetween size="s">
            {task.cases.map((drillCase) => (
              <FormField
                key={drillCase.id}
                label={localize(drillCase.label, locale)}
                description={t("crypto_drill.expected_format", {
                  format: t(`crypto_drill.format_${drillCase.format}`),
                  width: drillCase.width,
                })}
              >
                <Input
                  value={answers[drillCase.id] ?? ""}
                  onChange={({ detail }) =>
                    setAnswers((current) => ({ ...current, [drillCase.id]: detail.value }))
                  }
                  ariaLabel={localize(drillCase.label, locale)}
                />
              </FormField>
            ))}
          </SpaceBetween>
        ) : task.multi ? (
          <SpaceBetween size="xs">
            {task.choices.map((option) => (
              <Checkbox
                key={option.id}
                checked={selected.includes(option.id)}
                onChange={({ detail }) =>
                  setSelected((current) =>
                    detail.checked
                      ? [...current, option.id]
                      : current.filter((id) => id !== option.id),
                  )
                }
              >
                {localize(option.label, locale)}
              </Checkbox>
            ))}
          </SpaceBetween>
        ) : (
          <RadioGroup
            value={selected[0] ?? null}
            onChange={({ detail }) => setSelected([detail.value])}
            items={task.choices.map((option) => ({
              value: option.id,
              label: localize(option.label, locale),
            }))}
          />
        )}

        <SpaceBetween size="xs" direction="horizontal">
          <Button variant="primary" onClick={grade} data-testid={`grade-${task.id}`}>
            {t("crypto_drill.grade")}
          </Button>
          {hasMoreHints(task, state.revealedHints) && (
            <Button
              onClick={() => onRevealHint(task.id, task.hints.length)}
              data-testid={`hint-${task.id}`}
            >
              {t("crypto_drill.reveal_hint", {
                shown: state.revealedHints,
                total: task.hints.length,
              })}
            </Button>
          )}
          <Button onClick={() => showCoachPrompt("hint")} data-testid={`coach-hint-${task.id}`}>
            {t("crypto_drill.coach_hint")}
          </Button>
          <Button
            onClick={() => showCoachPrompt("explain")}
            data-testid={`coach-explain-${task.id}`}
          >
            {t("crypto_drill.coach_explain")}
          </Button>
        </SpaceBetween>

        {result !== null && (
          <Alert
            type={result.passed ? "success" : "warning"}
            header={result.passed ? t("crypto_drill.passed") : t("crypto_drill.not_yet")}
          >
            <CaseResults result={result} t={t} />
          </Alert>
        )}

        {visibleHints(task, state.revealedHints).map((entry) => (
          <Alert
            key={entry.level}
            type="info"
            header={t("crypto_drill.hint_level", { level: entry.level })}
          >
            {localize(entry.text, locale)}
          </Alert>
        ))}

        {!isValueTask(task) && result !== null && (
          <SpaceBetween size="xxs">
            {task.choices.map((option) => (
              <Box key={option.id} variant="small" color="text-body-secondary">
                {`${localize(option.label, locale)} — ${localize(option.rationale, locale)}`}
              </Box>
            ))}
          </SpaceBetween>
        )}

        {coachPrompt !== null && (
          <FormField
            label={t("crypto_drill.coach_prompt_label")}
            description={t("crypto_drill.coach_prompt_note")}
          >
            <Textarea
              value={coachPrompt}
              readOnly
              rows={10}
              ariaLabel={t("crypto_drill.coach_prompt_label")}
            />
          </FormField>
        )}
      </SpaceBetween>
    </Container>
  );
}
