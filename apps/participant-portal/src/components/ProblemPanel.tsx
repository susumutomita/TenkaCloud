import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useState } from "react";
import {
  type DeploymentStatus,
  type ParticipantHintView,
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
  revealHint,
  type SubmitFlagOutcome,
  submitFlag,
  TERMINAL_STATUSES,
} from "../api/portal-client";
import { describeAgo } from "../lib/format";
import { CelebrationOverlay } from "./CelebrationOverlay";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

const SCORING_KIND_LABEL: Record<string, string> = {
  flag: "Challenge (flag 提出)",
  uptime: "Battle (uptime 加点)",
  "uptime-flat": "Battle (uptime 加点)",
  "uptime-multi": "Battle (uptime 加点)",
  "phased-polling": "Battle (時間経過で加点ルール変動)",
  "attack-detection": "Battle (攻撃 detection)",
};

const FALLBACK_KIND_LABEL = "(未設定)";

/**
 * Issue #1006: scoring gate (= 競技開始前 / 終了後 / 一時停止) のエラーを 「いつ開始 / 終了か」
 * を添えた人間可読 message に変換する。 backend が startsAt / endsAt を返すようになったので、
 * UI 側で 「あと N 分」 を計算して表示する。
 */
function describeScoringGate(err: PortalScoringGateError, now: Date = new Date()): string {
  if (err.kind === "scoring_not_started") {
    if (!err.startsAt) {
      return "競技はまだ開始していません。 運営の開始合図をお待ちください。";
    }
    const startsAt = new Date(err.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      return "競技はまだ開始していません。";
    }
    const diffMs = startsAt.getTime() - now.getTime();
    if (diffMs <= 0) {
      return `競技開始時刻は ${startsAt.toLocaleString()} です (= 既に経過)。 反映に時差がある場合があります。`;
    }
    const minutes = Math.ceil(diffMs / 60_000);
    return `競技開始まで約 ${minutes} 分です (開始予定: ${startsAt.toLocaleString()})。 開始までお待ちください。`;
  }
  if (err.kind === "scoring_ended") {
    if (!err.endsAt) return "競技は終了しました。 採点 gate は閉じています。";
    const endsAt = new Date(err.endsAt);
    if (Number.isNaN(endsAt.getTime())) return "競技は終了しました。";
    return `競技は終了しました (終了: ${endsAt.toLocaleString()})。 採点 gate は閉じています。`;
  }
  return "採点が一時停止されています。 運営にお問い合わせください。";
}

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒は 12 req/min/user で過多)。
const POLL_INTERVAL_MS = 30_000;

/**
 * 1 problem 単位の詳細パネル。Home (= 全 problem を縦並べ) と ProblemDetail
 * (= 1 problem 専用ページ) の両方から使う共通 component。
 */
export function ProblemPanel({
  problem,
  apiBaseUrl,
  sessionToken,
  onScored,
}: {
  problem: ParticipantProblemView;
  apiBaseUrl: string;
  sessionToken: string;
  onScored: () => Promise<void>;
}) {
  const kindLabel = problem.scoring
    ? (SCORING_KIND_LABEL[problem.scoring.kind] ?? FALLBACK_KIND_LABEL)
    : FALLBACK_KIND_LABEL;
  const now = Date.now();
  const lastScoredMs = problem.lastScoredAt ? new Date(problem.lastScoredAt).getTime() : Number.NaN;
  // #688: phased-polling / uptime-flat / uptime-multi / attack-detection も Battle 軸
  // (= uptime と同じ \"古い lastScoredAt = stale\" UX を適用)。 flag だけ非 Battle。
  const isUptime = problem.scoring ? problem.scoring.kind !== "flag" : false;
  const isStale =
    isUptime &&
    Number.isFinite(lastScoredMs) &&
    now - lastScoredMs > STALE_THRESHOLD_MS &&
    problem.status === "COMPLETE";

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`${kindLabel} / ${problem.score} pt`}
          actions={
            <StatusIndicator type={STATUS_TYPE[problem.status]}>{problem.status}</StatusIndicator>
          }
        >
          {problem.problemId}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {problem.status === "FAILED" && problem.failureReason && (
          <Alert type="error" header="失敗理由">
            {problem.failureReason}
          </Alert>
        )}
        {isStale && (
          <Alert type="warning" header="スコアが伸びていません">
            直近の採点から {describeAgo(problem.lastScoredAt, now)} 経過。サービスのどこかが
            期待通り応答していない可能性があります。
          </Alert>
        )}
        {/* Audit #3: Job ID (= 内部 ULID) は競技者に見せない。 Region は AWS 多リージョン
            の場合のみ意味があるが、 1 リージョン運用の現状では noise。 残すのは現在の score + 最終加点 */}
        <KeyValuePairs
          items={[
            { label: "現在の score", value: `${problem.score} pt` },
            { label: "最終加点", value: describeAgo(problem.lastScoredAt, now) },
          ]}
        />

        {Object.keys(problem.stackOutputs).length > 0 && (
          <Container header={<Header variant="h3">アクセス先 URL</Header>}>
            <KeyValuePairs
              items={Object.entries(problem.stackOutputs).map(([label, value]) => ({
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
        {problem.scoring?.kind === "flag" && problem.status === "COMPLETE" && (
          <FlagSubmissionPanel
            apiBaseUrl={apiBaseUrl}
            sessionToken={sessionToken}
            problemId={problem.problemId}
            flagSubmitted={problem.scoring.flagSubmitted ?? false}
            points={problem.scoring.points ?? 0}
            hints={problem.scoring.hints ?? []}
            onScored={onScored}
          />
        )}
        {!TERMINAL_STATUSES.has(problem.status) && (
          <Box variant="small" color="text-status-info">
            {POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}

function FlagSubmissionPanel({
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
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (flagSubmitted) {
    // audit #6: 既出提出 (= reload した後の表示)。 「事務的 提出済み」 ではなく祝祭的 message。
    return (
      <Alert type="success" header={`🏆 クリア済み +${points} pt`}>
        この問題は正解済みです。 引き続き他の問題に挑戦してください！
      </Alert>
    );
  }

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!flag.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setOutcome(null);
    try {
      const result = await submitFlag(apiBaseUrl, sessionToken, problemId, flag);
      setOutcome(result);
      if (result.kind === "ok" || result.kind === "already_scored") {
        await onScored();
      }
    } catch (err) {
      // Issue #1006: scoring gate は startsAt / endsAt を含む専用 error。 「あと N 分」 を表示。
      if (err instanceof PortalScoringGateError) {
        setSubmitError(describeScoringGate(err));
      } else if (err instanceof PortalValidationError) {
        // 旧 path (= backend 古い / 別 error code) の fallback。
        setSubmitError(`エラー: ${err.errorCode}`);
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
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
              Flag 提出 (+{points} pt)
            </Button>
          }
        >
          <FormField label="Flag (Stack Output 値)">
            <Input
              value={flag}
              onChange={(e) => setFlag(e.detail.value)}
              placeholder="例: Hello from tc-hello-world-..."
              disabled={submitting}
            />
          </FormField>
        </Form>
      </form>
      {/* audit #6: 正解時の祝祭演出。 alert は大きめの emoji + ハイライト、 同時に画面全体に
          confetti animation を 3 秒被せる。 旧 「正解 (+100 pt) 合計スコア: 100 pt」 の事務的
          message から、 達成感を伴う UX に差し替え。 */}
      <CelebrationOverlay visible={outcome?.kind === "ok"} />
      {outcome?.kind === "ok" && (
        <Alert type="success" header={`🎉 正解！  +${outcome.scoreDelta} pt`}>
          おめでとうございます。 合計スコアは <strong>{outcome.totalScore} pt</strong> です。
        </Alert>
      )}
      {outcome?.kind === "wrong" && (
        <Alert
          type="warning"
          header={
            outcome.scoreDelta < 0
              ? `不正解 (${outcome.scoreDelta} pt) — 累計 ${outcome.totalScore} pt`
              : "不正解"
          }
        >
          {outcome.scoreDelta < 0 ? (
            <>
              これまで {outcome.wrongCount} 回 不正解です。 値を確認して再度提出してください。
              ペナルティは不正解 1 回あたり {-outcome.scoreDelta} pt で、 累計スコアは 0 pt
              未満になりません。
            </>
          ) : (
            <>値を確認して再度提出してください。</>
          )}
        </Alert>
      )}
      {outcome?.kind === "already_scored" && (
        <Alert type="info" header="提出済み">
          既に正解済みです (合計 {outcome.totalScore} pt)。
        </Alert>
      )}
      {submitError && (
        <Alert type="error" header="提出に失敗しました">
          {submitError}
        </Alert>
      )}
    </SpaceBetween>
  );
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
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  // Issue #819: 誤クリック防止のため confirmation Modal を出す。 `pendingReveal` は
  // 「Modal を開いている対象 hint」 (= 確定するまで API call しない)。
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
      // Issue #1006: hint reveal も scoring gate (= 競技開始前は開けない) の友好的 message を出す。
      if (err instanceof PortalScoringGateError) {
        setRevealError(describeScoringGate(err));
      } else if (err instanceof PortalValidationError) {
        setRevealError(`バリデーションエラー: ${err.errorCode}`);
      } else {
        setRevealError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRevealing(null);
      setPendingReveal(null);
    }
  };

  return (
    <>
      <Alert
        type="info"
        header={`ヒント (${hints.filter((h) => h.revealed).length} / ${hints.length} 公開済)`}
      >
        <SpaceBetween size="xs">
          {hints.map((h, i) => (
            <Box key={h.id}>
              {h.revealed ? (
                <Box>
                  <strong>ヒント {i + 1}:</strong> {h.content}
                  {h.revealedAt && (
                    <Box variant="small" color="text-status-info" margin={{ top: "xxs" }}>
                      公開済 ({describeAgo(h.revealedAt, Date.now())})
                    </Box>
                  )}
                </Box>
              ) : (
                <Box>
                  <strong>ヒント {i + 1}</strong>{" "}
                  <span style={{ color: h.penalty > 0 ? "#b54708" : "#475467" }}>
                    (公開すると -{h.penalty} pt)
                  </span>{" "}
                  {/* Issue #819: variant="normal" + iconName で明示的に button 化
                     (= 旧 "inline-link" だと地味で click 可能か視認しづらかった)。
                     onClick は Modal を開いて confirm を待つ (= 誤クリック防御)。 */}
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
                    ヒントを公開する
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

      {/* Issue #819: 誤クリック防御の confirmation Modal。 penalty=0 でも出す
         (= 「ヒントを見る」 という行為自体に明示的同意が要る、 UX 上の合意形成)。 */}
      <Modal
        visible={pendingReveal !== null}
        onDismiss={() => setPendingReveal(null)}
        header={`ヒント ${pendingIndex + 1} を公開しますか?`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => setPendingReveal(null)}
                disabled={revealing !== null}
              >
                キャンセル
              </Button>
              <Button
                variant="primary"
                loading={revealing !== null}
                onClick={() => {
                  if (pendingReveal) void handleReveal(pendingReveal.id);
                }}
              >
                公開する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {pendingReveal && (
          <SpaceBetween size="xs">
            <Box>
              {pendingReveal.penalty > 0 ? (
                <>
                  公開すると{" "}
                  <strong style={{ color: "#b54708" }}>-{pendingReveal.penalty} pt</strong>{" "}
                  減点されます。 一度公開すると元に戻せません。
                </>
              ) : (
                <>このヒントには減点はありません。 公開するとヒントが表示されます。</>
              )}
            </Box>
            <Box variant="small" color="text-status-inactive">
              ヒント本文は公開後に表示されます。
            </Box>
          </SpaceBetween>
        )}
      </Modal>
    </>
  );
}
