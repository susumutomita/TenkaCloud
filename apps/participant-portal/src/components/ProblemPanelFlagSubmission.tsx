import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import {
  type ParticipantHintView,
  revealHint,
  type SubmitFlagOutcome,
  submitFlag,
} from "../api/portal-client";
import { useT } from "../i18n";
import { describeAgo } from "../lib/format";
import { CelebrationOverlay } from "./CelebrationOverlay";
import {
  formatProblemPanelActionError,
  shouldRefreshAfterFlagSubmit,
} from "./ProblemPanel.helpers";

export function FlagSubmissionPanel({
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
  hints: readonly ParticipantHintView[];
  onScored: () => Promise<void>;
}) {
  const t = useT();
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (flagSubmitted) {
    // audit #6: 既出提出 (= reload した後の表示)。 「事務的 提出済み」 ではなく祝祭的 message。
    return (
      <Alert type="success" header={t("problem_panel.celebrate_header", { points })}>
        {t("problem_panel.celebrate_body")}
      </Alert>
    );
  }

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!canSubmitFlag(flag, submitting)) return;
    setSubmitting(true);
    setSubmitError(null);
    setOutcome(null);
    try {
      const result = await submitFlag(apiBaseUrl, sessionToken, problemId, flag);
      setOutcome(result);
      if (shouldRefreshAfterFlagSubmit(result)) await onScored();
    } catch (err) {
      setSubmitError(formatProblemPanelActionError(t, err, "problem_panel.submit_error_prefix"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SpaceBetween size="s">
      {hints.length > 0 && (
        <HintsPanel
          apiBaseUrl={apiBaseUrl}
          sessionToken={sessionToken}
          problemId={problemId}
          hints={hints}
          onRevealed={onScored}
        />
      )}
      <form onSubmit={handleSubmit}>
        <Form
          actions={
            <Button variant="primary" loading={submitting} formAction="submit">
              {t("problem_panel.submit_button", { points })}
            </Button>
          }
        >
          <FormField label={t("problem_panel.flag_field_label")}>
            <Input
              value={flag}
              onChange={(e) => setFlag(e.detail.value)}
              placeholder={t("problem_panel.flag_placeholder")}
              disabled={submitting}
            />
          </FormField>
        </Form>
      </form>
      <CelebrationOverlay visible={outcome?.kind === "ok"} />
      {outcome?.kind === "ok" && (
        <Alert
          type="success"
          header={t("problem_panel.ok_alert_header", { delta: outcome.scoreDelta })}
        >
          {t("problem_panel.ok_alert_body", { total: outcome.totalScore })}
        </Alert>
      )}
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
    </SpaceBetween>
  );
}

function canSubmitFlag(flag: string, submitting: boolean): boolean {
  return flag.trim().length > 0 && !submitting;
}

/**
 * Issue #742 Phase 4: progressive hint UI。
 *
 * - revealed=false (locked): 「ヒント N (-X pt)」 + 「reveal」 button
 * - revealed=true (unlocked): hint content + revealedAt 表示
 *
 * reveal クリック時に POST /portal/me/problems/:problemId/hints/:hintId/reveal を叩き、
 * 成功時に親 (= onScored) を呼んで score / hint 状態を refetch する (= optimistic に状態
 * 更新せず、 server truth を読み直す)。 失敗時は inline error を表示。
 */
function HintsPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
  hints,
  onRevealed,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  hints: readonly ParticipantHintView[];
  onRevealed: () => Promise<void>;
}) {
  const t = useT();
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [pendingReveal, setPendingReveal] = useState<ParticipantHintView | null>(null);
  const [pendingIndex, setPendingIndex] = useState<number>(0);

  const handleReveal = async (hintId: string) => {
    if (revealing) return;
    setRevealing(hintId);
    setRevealError(null);
    try {
      await revealHint(apiBaseUrl, sessionToken, problemId, hintId);
      await onRevealed();
    } catch (err) {
      setRevealError(formatProblemPanelActionError(t, err, "problem_panel.validation_error"));
    } finally {
      setRevealing(null);
      setPendingReveal(null);
    }
  };

  const revealedCount = hints.filter((h) => h.revealed).length;
  return (
    <>
      <Alert
        type="info"
        header={t("problem_panel.hint_header", { revealed: revealedCount, total: hints.length })}
      >
        <SpaceBetween size="xs">
          {hints.map((h, i) => (
            <Box key={h.id}>
              {h.revealed ? (
                <Box>
                  <strong>{t("problem_panel.hint_label_colon", { index: i + 1 })}</strong>{" "}
                  {h.content}
                  {h.revealedAt && (
                    <Box variant="small" color="text-status-info" margin={{ top: "xxs" }}>
                      {t("problem_panel.hint_revealed_ago", {
                        ago: describeAgo(h.revealedAt, Date.now()),
                      })}
                    </Box>
                  )}
                </Box>
              ) : (
                <Box>
                  <strong>{t("problem_panel.hint_label", { index: i + 1 })}</strong>{" "}
                  <span style={{ color: h.penalty > 0 ? "#b54708" : "#475467" }}>
                    {t("problem_panel.hint_penalty_note", { penalty: h.penalty })}
                  </span>{" "}
                  <Button
                    variant="normal"
                    iconName="lock-private"
                    loading={revealing === h.id}
                    disabled={revealing !== null && revealing !== h.id}
                    onClick={() => {
                      setPendingReveal(h);
                      setPendingIndex(i);
                    }}
                  >
                    {t("problem_panel.hint_reveal_button")}
                  </Button>
                </Box>
              )}
            </Box>
          ))}
          {revealError && (
            <Box color="text-status-error" variant="small">
              {revealError}
            </Box>
          )}
        </SpaceBetween>
      </Alert>

      <Modal
        visible={pendingReveal !== null}
        onDismiss={() => setPendingReveal(null)}
        header={t("problem_panel.hint_confirm_header", { index: pendingIndex + 1 })}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => setPendingReveal(null)}
                disabled={revealing !== null}
              >
                {t("problem_panel.hint_confirm_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={revealing !== null}
                onClick={() => {
                  if (pendingReveal) void handleReveal(pendingReveal.id);
                }}
              >
                {t("problem_panel.hint_confirm_submit")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {pendingReveal && (
          <SpaceBetween size="xs">
            <Box>
              {pendingReveal.penalty > 0
                ? t("problem_panel.hint_confirm_penalty", { penalty: pendingReveal.penalty })
                : t("problem_panel.hint_confirm_no_penalty")}
            </Box>
            <Box variant="small" color="text-status-inactive">
              {t("problem_panel.hint_confirm_footer")}
            </Box>
          </SpaceBetween>
        )}
      </Modal>
    </>
  );
}
