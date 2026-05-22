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
  isMock = false,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flagSubmitted: boolean;
  points: number;
  hints: readonly ParticipantHintView[];
  onScored: () => Promise<void>;
  /**
   * dev-mock mode (= LP の 「モックで試す」 動線)。 true のとき submit を backend に投げず、
   * local state で 「正解 → celebration」 「不正解 → 減点 + リトライ」 を再現する。
   * 本物の AWS 環境は無いので flag の中身は問わず、 任意 1 文字以上の入力で OK とする。
   */
  isMock?: boolean;
}) {
  const t = useT();
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // dev-mock では submit 後の view refetch が空振りするので、 「celebration を出した
  // 後は同じ panel で 提出済み 表示にしない」 (= 再度 submit form を出さない) ために
  // local flag を保持する。
  const [mockCleared, setMockCleared] = useState(false);

  if (flagSubmitted || mockCleared) {
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
      const result = isMock
        ? simulateMockFlagSubmit(flag, points)
        : await submitFlag(apiBaseUrl, sessionToken, problemId, flag);
      setOutcome(result);
      if (result.kind === "ok") setMockCleared(true);
      if (!isMock && shouldRefreshAfterFlagSubmit(result)) await onScored();
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
          <FormField
            label={t("problem_panel.flag_field_label")}
            description={isMock ? t("problem_panel.flag_mock_hint") : undefined}
          >
            <Input
              value={flag}
              onChange={(e) => setFlag(e.detail.value)}
              placeholder={
                isMock
                  ? t("problem_panel.flag_mock_placeholder")
                  : t("problem_panel.flag_placeholder")
              }
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

/**
 * dev-mock 用 mock flag 検証。 LP visitor が submit 体験を試せるよう、 固定の
 * 「正解」 文字列 `tenkacloudsample` (case-insensitive、 部分一致) のときに celebration を
 * 出し、 それ以外は不正解 (= 減点 + リトライ) にする。 placeholder で答えを示唆する。
 */
export const MOCK_CORRECT_FLAG = "tenkacloudsample";

/**
 * Easter eggs. ふざけて submit してくれた visitor へのリワード (= 全部 正解扱い)。
 *  - `42`               : The Hitchhiker's Guide to the Galaxy
 *  - `claude`           : 開発で使ってる AI agent への nod
 *  - `kaizen`           : 改善 = 日本語の karma
 *  - `tenkadev`         : 開発者専用 dev wink
 *  - `konnichiwa`       : ja LP visitor 向け hello
 *  - `tenka`            : 部分マッチで通したいゆるさ
 */
const MOCK_EASTER_EGGS: readonly string[] = [
  "42",
  "claude",
  "kaizen",
  "tenkadev",
  "konnichiwa",
  "tenka",
];

function simulateMockFlagSubmit(flag: string, points: number): SubmitFlagOutcome {
  const trimmed = flag.trim().toLowerCase();
  if (trimmed.length === 0) {
    return { kind: "wrong", scoreDelta: -10, totalScore: -10, wrongCount: 1 };
  }
  // `tenkacloudsample` を含むか、 逆に `tenkacloudsample` が入力を含むときも OK
  // (= ユーザが `tenkacloud` だけ入れても通る、 typo に少し寛容)。
  if (trimmed.includes(MOCK_CORRECT_FLAG) || MOCK_CORRECT_FLAG.includes(trimmed)) {
    return { kind: "ok", scoreDelta: points, totalScore: points };
  }
  if (MOCK_EASTER_EGGS.some((egg) => trimmed === egg)) {
    return { kind: "ok", scoreDelta: points, totalScore: points };
  }
  return { kind: "wrong", scoreDelta: -10, totalScore: -10, wrongCount: 1 };
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
