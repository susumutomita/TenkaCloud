import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DeploymentStatus,
  type EndpointHealth,
  getPortalMe,
  type ParticipantView,
  PortalAuthError,
  PortalValidationError,
  type SubmitFlagOutcome,
  submitFlag,
  TERMINAL_STATUSES,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

const POLL_INTERVAL_MS = 5_000;

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

const SCORING_KIND_LABEL = {
  flag: "Challenge (flag 提出)",
  uptime: "Battle (uptime 加点)",
} as const;

/**
 * Polling 結果が前回と意味的に同じなら true → setView を skip し React 再 render を抑制。
 *
 * `endpointsHealth` の比較は `checkedAt` を除外 (= 状態 ok/since が変わらない限り
 * 1 分ごとの checkedAt 更新で再 render しないようにする)。UI は ok / since 派生の
 * 「N 分前から」だけを表示するので checkedAt は表示要素ではない。
 */
function viewIsUnchanged(prev: ParticipantView | null, next: ParticipantView): boolean {
  if (!prev) return false;
  return (
    prev.status === next.status &&
    prev.score === next.score &&
    prev.lastScoredAt === next.lastScoredAt &&
    prev.lastResult === next.lastResult &&
    prev.scoring?.flagSubmitted === next.scoring?.flagSubmitted &&
    prev.teamName === next.teamName &&
    prev.failureReason === next.failureReason &&
    JSON.stringify(prev.stackOutputs) === JSON.stringify(next.stackOutputs) &&
    healthSignature(prev.endpointsHealth) === healthSignature(next.endpointsHealth)
  );
}

/** `endpointsHealth` を `[outputKey, ok, since||""]` の配列で正規化 (checkedAt 無視)。 */
function healthSignature(h: ParticipantView["endpointsHealth"]): string {
  if (!h) return "";
  return Object.entries(h)
    .map(([k, v]) => `${k}:${v.ok}:${v.since ?? ""}`)
    .sort()
    .join("|");
}

function describeDuration(sinceIso: string, nowMs: number): string {
  const sinceMs = new Date(sinceIso).getTime();
  if (!Number.isFinite(sinceMs)) return "?";
  const diff = Math.max(0, nowMs - sinceMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前から`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前から`;
  const hr = Math.floor(min / 60);
  return `${hr} 時間 ${min % 60} 分前から`;
}

export function HomePage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const teamName = auth.session?.teamName ?? "(unknown)";
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";

  const [view, setView] = useState<ParticipantView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopPollingRef = useRef(false);

  const tick = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
    try {
      const next = await getPortalMe(config.apiBaseUrl, sessionToken);
      setView((prev) => (viewIsUnchanged(prev, next) ? prev : next));
      setError(null);
      // uptime 採点は COMPLETE になっても polling を続けたい (= score が増え続ける)。
      // Terminal 停止は FAILED / DELETED のみに限定。
      if (next.status === "FAILED" || next.status === "DELETED") {
        stopPollingRef.current = true;
      }
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [isBackend, sessionToken, config.apiBaseUrl, auth]);

  useEffect(() => {
    if (!isBackend || !sessionToken) return;
    let cancelled = false;
    stopPollingRef.current = false;
    const run = async () => {
      if (cancelled || stopPollingRef.current) return;
      await tick();
    };
    void run();
    const interval = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isBackend, sessionToken, tick]);

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`${config.eventTitle} へようこそ`}>
        Welcome, {teamName}
      </Header>

      {view && <ScorePanel view={view} />}

      {view?.scoring?.kind === "uptime" && view.endpointsHealth && (
        <ServiceHealthPanel endpointsHealth={view.endpointsHealth} />
      )}

      <Container header={<Header variant="h2">問題のデプロイ状況</Header>}>
        <SpaceBetween size="m">
          {!isBackend && (
            <Alert type="info">
              dev-mock モードで動作中です。実 backend と接続するには runtime-config の{" "}
              <code>mode</code> を <code>backend</code> に設定してください。
            </Alert>
          )}
          {error && (
            <Alert type="error" header="状態の取得に失敗しました">
              {error}
            </Alert>
          )}
          {isBackend && !view && !error && <Box>状態を取得中...</Box>}
          {view && (
            <>
              <StatusIndicator type={STATUS_TYPE[view.status]}>{view.status}</StatusIndicator>
              {view.status === "FAILED" && view.failureReason && (
                <Alert type="error" header="失敗理由">
                  {view.failureReason}
                </Alert>
              )}
              <ColumnLayout columns={2} variant="text-grid">
                <KeyValuePairs
                  items={[
                    { label: "Problem", value: <code>{view.problemId}</code> },
                    { label: "Region", value: view.region },
                  ]}
                />
                <KeyValuePairs
                  items={[
                    { label: "Job ID", value: <code>{view.jobId}</code> },
                    { label: "Team", value: view.teamName },
                  ]}
                />
              </ColumnLayout>
              {Object.keys(view.stackOutputs).length > 0 && (
                <Container header={<Header variant="h3">アクセス先 URL</Header>}>
                  <KeyValuePairs
                    items={Object.entries(view.stackOutputs).map(([label, value]) => ({
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
              {!TERMINAL_STATUSES.has(view.status) && (
                <Box variant="small" color="text-status-info">
                  {POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。
                </Box>
              )}
            </>
          )}
        </SpaceBetween>
      </Container>

      {view?.scoring?.kind === "flag" && view.status === "COMPLETE" && (
        <FlagSubmissionPanel
          apiBaseUrl={config.apiBaseUrl}
          sessionToken={sessionToken ?? ""}
          flagSubmitted={view.scoring.flagSubmitted ?? false}
          points={view.scoring.points ?? 0}
          hints={view.scoring.hints ?? []}
          onScored={tick}
        />
      )}
    </SpaceBetween>
  );
}

/**
 * 各 endpoint の現在ヘルス + down している時間を表示。Battle 中の防御側が
 * 「どこから攻撃を受けて何分前から落ちている」を一目で判断できる経路。
 */
function ServiceHealthPanel({
  endpointsHealth,
}: {
  endpointsHealth: Record<string, EndpointHealth>;
}) {
  const entries = Object.entries(endpointsHealth);
  if (entries.length === 0) return null;
  const anyDown = entries.some(([, h]) => !h.ok);
  const now = Date.now();
  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            anyDown
              ? "サービスが落ちている間はスコアが加算されません。早急に復旧してください。"
              : "全エンドポイント正常。スコアは 1 分ごとに加算されます。"
          }
        >
          サービス健全性
        </Header>
      }
    >
      <SpaceBetween size="m">
        {anyDown && (
          <Alert type="error" header="攻撃検知 / サービス停止">
            下記エンドポイントが応答していません。SSM Session で接続して復旧してください。
          </Alert>
        )}
        <KeyValuePairs
          columns={Math.min(entries.length, 3)}
          items={entries.map(([key, h]) => ({
            label: key,
            value: h.ok ? (
              <StatusIndicator type="success">OK</StatusIndicator>
            ) : (
              <Box>
                <StatusIndicator type="error">DOWN</StatusIndicator>
                {h.since && (
                  <Box variant="small" color="text-status-error">
                    {describeDuration(h.since, now)}
                  </Box>
                )}
              </Box>
            ),
          }))}
        />
      </SpaceBetween>
    </Container>
  );
}

function ScorePanel({ view }: { view: ParticipantView }) {
  const kindLabel = view.scoring ? SCORING_KIND_LABEL[view.scoring.kind] : "(未設定)";
  return (
    <Container header={<Header variant="h2">スコア</Header>}>
      <KeyValuePairs
        columns={3}
        items={[
          {
            label: "現在の累計",
            value: (
              <Box variant="awsui-value-large" color="text-status-success">
                {view.score} pt
              </Box>
            ),
          },
          { label: "形式", value: kindLabel },
          { label: "最終チェック", value: view.lastScoredAt ?? "(まだ未採点)" },
        ]}
      />
    </Container>
  );
}

function FlagSubmissionPanel({
  apiBaseUrl,
  sessionToken,
  flagSubmitted,
  points,
  hints,
  onScored,
}: {
  apiBaseUrl: string;
  sessionToken: string;
  flagSubmitted: boolean;
  points: number;
  hints: readonly string[];
  onScored: () => Promise<void>;
}) {
  const [flag, setFlag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitFlagOutcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (flagSubmitted) {
    return (
      <Container header={<Header variant="h2">Flag 提出</Header>}>
        <Alert type="success" header="提出済み">
          このチームは既に正解を提出済みです (+{points} pt)。
        </Alert>
      </Container>
    );
  }

  const handleSubmit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!flag.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setOutcome(null);
    try {
      const result = await submitFlag(apiBaseUrl, sessionToken, flag);
      setOutcome(result);
      if (result.kind === "ok" || result.kind === "already_scored") {
        await onScored();
      }
    } catch (err) {
      if (err instanceof PortalValidationError) {
        setSubmitError(`バリデーションエラー: ${err.errorCode}`);
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container
      header={
        <Header variant="h2" description={`正解を入力すると +${points} pt 獲得します。`}>
          Flag 提出
        </Header>
      }
    >
      <SpaceBetween size="m">
        {hints.length > 0 && (
          <Alert type="info" header="ヒント">
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </Alert>
        )}
        <form onSubmit={handleSubmit}>
          <Form
            actions={
              <Button variant="primary" loading={submitting} formAction="submit">
                提出
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
        {outcome?.kind === "ok" && (
          <Alert type="success" header={`正解 (+${outcome.scoreDelta} pt)`}>
            合計スコア: {outcome.totalScore} pt
          </Alert>
        )}
        {outcome?.kind === "wrong" && (
          <Alert type="warning" header="不正解">
            値を確認して再度提出してください。
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
    </Container>
  );
}
