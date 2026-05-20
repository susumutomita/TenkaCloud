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
import { useEffect, useState } from "react";
import {
  type DeployLogsResponse,
  type DeploymentLogEntry,
  type DeploymentLogView,
  type DeploymentStatus,
  getDeployLogs,
  type ParticipantHintView,
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
  revealHint,
  type SubmitFlagOutcome,
  submitFlag,
  TERMINAL_STATUSES,
} from "../api/portal-client";
import { useT } from "../i18n";
import { describeAgo } from "../lib/format";
import { CelebrationOverlay } from "./CelebrationOverlay";

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
  EXPIRED: "warning",
  AUTO_DELETED: "stopped",
};

const SCORING_KIND_KEY: Record<string, string> = {
  flag: "problem_panel.kind_flag",
  uptime: "problem_panel.kind_uptime",
  "uptime-flat": "problem_panel.kind_uptime",
  "uptime-multi": "problem_panel.kind_uptime",
  "phased-polling": "problem_panel.kind_phased",
  "attack-detection": "problem_panel.kind_attack",
};

type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #1006: scoring gate (= 競技開始前 / 終了後 / 一時停止) のエラーを 「いつ開始 / 終了か」
 * を添えた人間可読 message に変換する。 backend が startsAt / endsAt を返すようになったので、
 * UI 側で 「あと N 分」 を計算して表示する。 #1093: i18n 化。
 */
function describeScoringGate(t: TFn, err: PortalScoringGateError, now: Date = new Date()): string {
  if (err.kind === "scoring_not_started") {
    if (!err.startsAt) return t("problem_panel.scoring_gate_not_started_no_eta");
    const startsAt = new Date(err.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      return t("problem_panel.scoring_gate_not_started_unknown");
    }
    const diffMs = startsAt.getTime() - now.getTime();
    if (diffMs <= 0) {
      return t("problem_panel.scoring_gate_not_started_passed", {
        startsAt: startsAt.toLocaleString(),
      });
    }
    const minutes = Math.ceil(diffMs / 60_000);
    return t("problem_panel.scoring_gate_not_started_remaining", {
      minutes,
      startsAt: startsAt.toLocaleString(),
    });
  }
  if (err.kind === "scoring_ended") {
    if (!err.endsAt) return t("problem_panel.scoring_gate_ended_no_eta");
    const endsAt = new Date(err.endsAt);
    if (Number.isNaN(endsAt.getTime())) return t("problem_panel.scoring_gate_ended_unknown");
    return t("problem_panel.scoring_gate_ended_at", { endsAt: endsAt.toLocaleString() });
  }
  return t("problem_panel.scoring_gate_paused");
}

/** uptime kind で `lastScoredAt` がこの閾値より古ければ「停滞」表示。 */
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒は 12 req/min/user で過多)。
const POLL_INTERVAL_MS = 30_000;
const LIVE_DEPLOY_LOG_POLL_INTERVAL_MS = 5_000;
const COUNTDOWN_REFRESH_MS = 30_000;
const AUTO_DELETE_SOON_THRESHOLD_MS = 15 * 60 * 1000;

const DEPLOY_LOG_LEVEL_COLOR: Record<DeploymentLogEntry["level"], string> = {
  info: "#9bd3ff",
  success: "#9dffb0",
  warning: "#ffd27d",
  error: "#ff9b9b",
};

function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

function describeRemainingUntilAutoDelete(t: TFn, diffMs: number): string {
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  if (totalMinutes < 60) {
    return t("problem_panel.auto_delete_remaining_minutes", { minutes: totalMinutes });
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return t("problem_panel.auto_delete_remaining_hours", { hours, minutes });
}

function buildAutoDeleteNotice(
  t: TFn,
  expiresAt: number,
  nowMs: number,
): { readonly type: "info" | "warning"; readonly body: string } | undefined {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return undefined;
  const expiresAtMs = expiresAt * 1000;
  const expiresAtLabel = new Date(expiresAtMs).toLocaleString();
  const diffMs = expiresAtMs - nowMs;
  if (diffMs <= 0) {
    return {
      type: "warning",
      body: t("problem_panel.auto_delete_expired_body", { expiresAt: expiresAtLabel }),
    };
  }
  const remaining = describeRemainingUntilAutoDelete(t, diffMs);
  if (diffMs <= AUTO_DELETE_SOON_THRESHOLD_MS) {
    return {
      type: "warning",
      body: t("problem_panel.auto_delete_soon_body", { remaining, expiresAt: expiresAtLabel }),
    };
  }
  return {
    type: "info",
    body: t("problem_panel.auto_delete_body", { remaining, expiresAt: expiresAtLabel }),
  };
}

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
  const t = useT();
  const now = useNowMs(COUNTDOWN_REFRESH_MS);
  const [liveDeployLog, setLiveDeployLog] = useState<DeploymentLogView | null>(null);
  const kindLabel = problem.scoring
    ? t(SCORING_KIND_KEY[problem.scoring.kind] ?? "problem_panel.kind_unknown")
    : t("problem_panel.kind_unknown");
  const lastScoredMs = problem.lastScoredAt ? new Date(problem.lastScoredAt).getTime() : Number.NaN;
  const autoDeleteNotice = buildAutoDeleteNotice(t, problem.expiresAt, now);
  // #688: phased-polling / uptime-flat / uptime-multi / attack-detection も Battle 軸
  // (= uptime と同じ "古い lastScoredAt = stale" UX を適用)。 flag だけ非 Battle。
  const isUptime = problem.scoring ? problem.scoring.kind !== "flag" : false;
  const isStale =
    isUptime &&
    Number.isFinite(lastScoredMs) &&
    now - lastScoredMs > STALE_THRESHOLD_MS &&
    problem.status === "COMPLETE";
  const displayedDeployLog =
    liveDeployLog && liveDeployLog.entries.length > 0 ? liveDeployLog : problem.deployLog;

  useEffect(() => {
    setLiveDeployLog(null);
    if (TERMINAL_STATUSES.has(problem.status)) return;

    let cancelled = false;
    let nextToken: string | undefined;
    const poll = async () => {
      try {
        const response = await getDeployLogs(apiBaseUrl, sessionToken, problem.jobId, {
          nextToken,
          limit: 50,
        });
        if (cancelled) return;
        nextToken = response.nextToken;
        setLiveDeployLog((prev) => mergeLiveDeployLog(prev, response));
        if (response.complete) cancelled = true;
      } catch {
        // Live logs are best-effort; keep the synthetic deployment log visible if polling fails.
      }
    };

    void poll();
    const interval = setInterval(() => {
      if (!cancelled) void poll();
    }, LIVE_DEPLOY_LOG_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiBaseUrl, sessionToken, problem.jobId, problem.status]);

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`${kindLabel} / ${problem.score} pt`}
          actions={
            <StatusIndicator type={STATUS_TYPE[problem.status]}>
              {t(`quests.status_label.${problem.status}`)}
            </StatusIndicator>
          }
        >
          {problem.problemId}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {problem.status === "FAILED" && problem.failureReason && (
          <Alert type="error" header={t("problem_panel.failure_reason_header")}>
            {problem.failureReason}
          </Alert>
        )}
        {isStale && (
          <Alert type="warning" header={t("problem_panel.stale_header")}>
            {t("problem_panel.stale_body", { ago: describeAgo(problem.lastScoredAt, now) })}
          </Alert>
        )}
        {autoDeleteNotice && (
          <Alert type={autoDeleteNotice.type} header={t("problem_panel.auto_delete_header")}>
            {autoDeleteNotice.body}
          </Alert>
        )}
        {/* Audit #3: Job ID (= 内部 ULID) は競技者に見せない。 Region は AWS 多リージョン
            の場合のみ意味があるが、 1 リージョン運用の現状では noise。 残すのは現在の score + 最終加点 */}
        <KeyValuePairs
          items={[
            { label: t("problem_panel.current_score_label"), value: `${problem.score} pt` },
            {
              label: t("problem_panel.last_scored_label"),
              value: describeAgo(problem.lastScoredAt, now),
            },
          ]}
        />

        {displayedDeployLog?.entries.length > 0 && (
          <DeployTerminal
            entries={displayedDeployLog.entries}
            title={t("problem_panel.deploy_log_header")}
          />
        )}

        {Object.keys(problem.stackOutputs).length > 0 && (
          <Container header={<Header variant="h3">{t("problem_panel.outputs_header")}</Header>}>
            <KeyValuePairs
              items={Object.entries(problem.stackOutputs).map(([label, value]) => ({
                label,
                // #1094: URL (= http(s)://) のときだけ click 可能リンクにする。 ARN / SSM
                //   parameter name / NamePrefix 等の非 URL output を a href で wrap すると
                //   broken link になるので plain code 表示に倒す。 「ParameterConsoleUrl」
                //   のような deep link を問題 author が emit すれば click で AWS Console
                //   直接遷移 (ssm:DescribeParameters 不要、 ADR-021 と整合)。
                value: /^https?:\/\//i.test(value) ? (
                  <a href={value} target="_blank" rel="noreferrer noopener">
                    <code>{value}</code>
                  </a>
                ) : (
                  <code>{value}</code>
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
            {t("problem_panel.auto_refresh_note", { seconds: POLL_INTERVAL_MS / 1000 })}
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}

function mergeLiveDeployLog(
  prev: DeploymentLogView | null,
  response: DeployLogsResponse,
): DeploymentLogView {
  const existing = prev?.entries ?? [];
  const seen = new Set(existing.map((entry) => entry.id));
  const next = response.entries
    .filter((entry) => !seen.has(entry.id))
    .map((entry): DeploymentLogEntry => ({ ...entry, level: classifyCodeBuildLog(entry.message) }));
  return {
    cursor: response.nextToken ?? prev?.cursor ?? "",
    entries: [...existing, ...next].slice(-200),
  };
}

function classifyCodeBuildLog(message: string): DeploymentLogEntry["level"] {
  if (/\b(error|failed|failure|timed out|fault)\b/i.test(message)) return "error";
  if (/\b(succeeded|complete|completed)\b/i.test(message)) return "success";
  if (/\b(warn|warning)\b/i.test(message)) return "warning";
  return "info";
}

function DeployTerminal({
  entries,
  title,
}: {
  entries: readonly DeploymentLogEntry[];
  title: string;
}) {
  return (
    <section aria-label={title}>
      <Box variant="h3">{title}</Box>
      <div
        style={{
          marginTop: 8,
          maxHeight: 240,
          overflowY: "auto",
          borderRadius: 6,
          background: "#0f1419",
          color: "#d5dde5",
          padding: "12px 14px",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {entries.map((entry) => (
          <div key={entry.id} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <span style={{ color: "#8796a5" }}>{formatTerminalTime(entry.timestamp)}</span>{" "}
            <span style={{ color: DEPLOY_LOG_LEVEL_COLOR[entry.level] }}>[{entry.level}]</span>{" "}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatTerminalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
      if (err instanceof PortalScoringGateError) {
        setSubmitError(describeScoringGate(t, err));
      } else if (err instanceof PortalValidationError) {
        setSubmitError(t("problem_panel.submit_error_prefix", { errorCode: err.errorCode }));
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
      if (err instanceof PortalScoringGateError) {
        setRevealError(describeScoringGate(t, err));
      } else if (err instanceof PortalValidationError) {
        setRevealError(t("problem_panel.validation_error", { errorCode: err.errorCode }));
      } else {
        setRevealError(err instanceof Error ? err.message : String(err));
      }
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
