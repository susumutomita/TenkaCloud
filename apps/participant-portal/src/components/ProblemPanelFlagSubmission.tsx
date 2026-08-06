import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import {
  type HintRevealMode,
  type ParticipantHintView,
  PortalValidationError,
  revealHint,
  type SubmitFlagOutcome,
  submitFlag,
} from "../api/portal-client";
import { useIsMock } from "../config-context";
import { evaluateMockFlag } from "../dev-mock/flag-submit";
import { useLang, useT } from "../i18n";
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
  revealOrder,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  flagSubmitted: boolean;
  points: number;
  hints: readonly ParticipantHintView[];
  onScored: () => Promise<void>;
  /** 問題 `scoring.hintReveal`; `"flat"` で hint 順序ゲートを外す (既定 sequential)。 */
  revealOrder?: HintRevealMode;
}) {
  const t = useT();
  // dev-mock mode (= LP 「モックで試す」 動線) のとき submit を backend に投げず、
  // dev-mock/flag-submit.evaluateMockFlag で local 評価する。 mode は AppConfig
  // context から直接読む (= 旧 isMock prop drill を撤去)。
  const isMock = useIsMock();
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 正解直後 (mock / backend 共通): 祝祭 confetti + 獲得スコアを表示する。 outcome を保持
  // している限りこの画面を維持するので submit form は再表示されない。 これが mock mode の
  // 「refetch が空振りして提出済みに切り替わらない」 ケースも吸収するため、 旧 mockCleared
  // state は不要になった (= 重複した状態を撤去)。
  if (outcome?.kind === "ok") {
    return (
      <>
        <CelebrationOverlay visible />
        <Alert
          type="success"
          header={t("problem_panel.ok_alert_header", { delta: outcome.scoreDelta })}
        >
          {t("problem_panel.ok_alert_body", { total: outcome.totalScore })}
        </Alert>
        <RevealedHintsReview hints={hints} />
      </>
    );
  }

  if (flagSubmitted) {
    // audit #6: reload 後など server 由来の 「提出済み」 表示。 事務的ではなく祝祭的 message。
    return (
      <>
        <Alert type="success" header={t("problem_panel.celebrate_header", { points })}>
          {t("problem_panel.celebrate_body")}
        </Alert>
        <RevealedHintsReview hints={hints} />
      </>
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
        ? evaluateMockFlag(flag, points)
        : await submitFlag(apiBaseUrl, sessionToken, problemId, flag);
      setOutcome(result);
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
          revealOrder={revealOrder}
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
 * [#2908] 解答済み表示の下に残す、開封済みヒントの read-only 振り返り。
 *
 * 正解した瞬間に HintsPanel ごと DOM から消え、開いたヒントを振り返れなくなる
 * regression の修正。server (scripts/local-play/api-views.ts) は解答後も revealed
 * hint の content / revealedAt を返し続けるので、開封済みの部分集合だけを描画する。
 * 未開封 hint は content 自体が API から届かないため、ここから新規開封はできず、
 * 追加減点も発生しない。既定は折りたたみ (クリック / キーボードで展開)。
 */
export function RevealedHintsReview({ hints }: { hints: readonly ParticipantHintView[] }) {
  const t = useT();
  const revealed = hints.filter((hint) => hint.revealed && hint.content?.trim());
  if (revealed.length === 0) return null;
  return (
    <ExpandableSection
      headerText={t("problem_panel.hint_review_header", { count: revealed.length })}
      variant="footer"
    >
      <SpaceBetween size="xs">
        {revealed.map((hint) => (
          <Box key={hint.id}>
            {/* 番号は解答前の HintsPanel と同じ「全 hint 中の位置」で振る。 */}
            <strong>
              {t("problem_panel.hint_label_colon", { index: hints.indexOf(hint) + 1 })}
            </strong>{" "}
            {hint.content}
          </Box>
        ))}
      </SpaceBetween>
    </ExpandableSection>
  );
}

/**
 * Issue #1315: 409 hint_out_of_order は missingHintId を hints から index 引きして
 * 「ヒント N を先に公開してください」 の親切文言を出す。 他の error は既存の
 * formatProblemPanelActionError 経路に委譲する。
 */
function formatRevealError(
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
  err: unknown,
  hints: readonly ParticipantHintView[],
): string {
  if (err instanceof PortalValidationError && err.errorCode === "hint_out_of_order") {
    const missingId =
      typeof err.details?.missingHintId === "string" ? err.details.missingHintId : undefined;
    const missingIdx = missingId ? hints.findIndex((h) => h.id === missingId) : -1;
    const indexLabel = missingIdx >= 0 ? missingIdx + 1 : 1;
    return t("problem_panel.hint_out_of_order_error", { index: indexLabel });
  }
  return formatProblemPanelActionError(t, err, "problem_panel.validation_error");
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
export function HintsPanel({
  apiBaseUrl,
  sessionToken,
  problemId,
  hints,
  onRevealed,
  onRevealTracked,
  revealOrder,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  problemId: string;
  hints: readonly ParticipantHintView[];
  onRevealed: () => Promise<void>;
  /** 公開成功時の計測 hook。回答や hint 本文は渡さず id だけ通知する。 */
  onRevealTracked?: (hintId: string) => void;
  /**
   * Issue #1315 ← 問題 `scoring.hintReveal`: hint 公開順。 `"flat"` のとき順序ゲート
   * (predecessor lock) を外し、 全 hint を任意順で開封できる。 未指定 / `"sequential"`
   * は既定の progressive gate (hint N は hint 1..N-1 開封後のみ)。
   */
  revealOrder?: HintRevealMode;
}) {
  const t = useT();
  // #2711 follow-up: 開封時刻の相対表示 (describeAgo) も locale に合わせる。
  const lang = useLang();
  // [#2707] dev-mock (= LP デモ) では backend が無いので reveal をローカル state で行う。
  // fixture がドリルの hint content を同梱し (公開前提のオンボーディング教材)、 開封状態
  // だけをこの Set で持つ。 backend mode では従来どおり server truth。
  const isMock = useIsMock();
  const [mockRevealed, setMockRevealed] = useState<ReadonlySet<string>>(new Set());
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [pendingReveal, setPendingReveal] = useState<ParticipantHintView | null>(null);
  const [pendingIndex, setPendingIndex] = useState<number>(0);

  const effectiveHints = isMock
    ? hints.map((h) => (mockRevealed.has(h.id) ? { ...h, revealed: true } : h))
    : hints;

  const handleReveal = async (hintId: string) => {
    // 再入防止ガード。 唯一の呼び出し元 (confirm modal の submit button) は reveal 実行中
    // `loading` で無効化されるので UI からは再入できない (= 防御的に残す不到達分岐)。
    /* v8 ignore next */
    if (revealing) return;
    if (isMock) {
      setMockRevealed((prev) => new Set([...prev, hintId]));
      onRevealTracked?.(hintId);
      setPendingReveal(null);
      return;
    }
    setRevealing(hintId);
    setRevealError(null);
    try {
      await revealHint(apiBaseUrl, sessionToken, problemId, hintId);
      onRevealTracked?.(hintId);
      await onRevealed();
    } catch (err) {
      setRevealError(formatRevealError(t, err, hints));
    } finally {
      setRevealing(null);
      setPendingReveal(null);
    }
  };

  const revealedCount = effectiveHints.filter((h) => h.revealed).length;
  // flat モードでは順序ゲートを一切かけない (= どの hint も独立に開封できる)。
  const flat = revealOrder === "flat";
  return (
    <>
      <Alert
        type="info"
        header={t("problem_panel.hint_header", { revealed: revealedCount, total: hints.length })}
      >
        <SpaceBetween size="xs">
          {effectiveHints.map((h, i) => {
            // Issue #1315: progressive hint 順序制約。 Hint N (index i) は Hint 1..i が
            // すべて revealed=true のときのみ button 有効。 backend (409 hint_out_of_order)
            // と同じ contract を UI で先回り disable し、 不要な round trip を抑える。
            // flat モード (問題の scoring.hintReveal="flat") では順序制約を外す。
            const predecessorsRevealed = effectiveHints.slice(0, i).every((prev) => prev.revealed);
            const lockedByOrder = !flat && !predecessorsRevealed;
            const ariaLabel = lockedByOrder
              ? t("problem_panel.hint_predecessor_required_aria", { index: i })
              : undefined;
            return (
              <Box key={h.id}>
                {h.revealed ? (
                  <Box>
                    <strong>{t("problem_panel.hint_label_colon", { index: i + 1 })}</strong>{" "}
                    {h.content}
                    {h.revealedAt && (
                      <Box variant="small" color="text-status-info" margin={{ top: "xxs" }}>
                        {t("problem_panel.hint_revealed_ago", {
                          ago: describeAgo(h.revealedAt, Date.now(), lang),
                        })}
                      </Box>
                    )}
                  </Box>
                ) : (
                  <Box>
                    <strong>{t("problem_panel.hint_label", { index: i + 1 })}</strong>{" "}
                    <span style={{ color: h.penalty > 0 ? "#b54708" : "#475467" }}>
                      {h.penalty > 0
                        ? t("problem_panel.hint_penalty_note", { penalty: h.penalty })
                        : t("problem_panel.hint_no_penalty_note")}
                    </span>{" "}
                    <Button
                      variant="normal"
                      iconName="lock-private"
                      loading={revealing === h.id}
                      disabled={lockedByOrder || (revealing !== null && revealing !== h.id)}
                      ariaLabel={ariaLabel}
                      onClick={() => {
                        setPendingReveal(h);
                        setPendingIndex(i);
                      }}
                    >
                      {t("problem_panel.hint_reveal_button")}
                    </Button>
                    {lockedByOrder && (
                      <Box variant="small" color="text-status-inactive" margin={{ top: "xxs" }}>
                        {t("problem_panel.hint_predecessor_required", { index: i })}
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
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
                  // submit button は modal が visible (= pendingReveal !== null) のときだけ
                  // 描画されるので null チェックは型絞り込み用。 else 側は不到達。
                  /* v8 ignore next */
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
