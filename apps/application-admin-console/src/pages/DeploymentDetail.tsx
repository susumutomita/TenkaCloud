import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { ApiError, useApiClient } from "../api/client";
import {
  type DeploymentSummary,
  deleteDeployment,
  getDeployment,
  getStackProgress,
  JOB_ID_RE,
  parseStackOutputs,
  type StackProgress,
  type StackProgressEvent,
  type StackProgressResource,
  statusToIndicator,
  TERMINAL_STATUSES,
} from "../api/deploy-client";
import type { AppConfig } from "../config";
import {
  buildTerminalLog,
  type DeployPhase,
  deploySummaryTitle,
  derivePhases,
  formatLogTimestamp,
  type LogLine,
  type PhaseStatus,
} from "../lib/deploy-phases";

// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒 polling は 12 req/min/user で過多)。
// deploy phase の進行は CloudFormation 側で数十秒〜数分単位なので、 30 秒粒度で十分。
const POLL_INTERVAL_MS = 30_000;

/** Phase status を Cloudscape StatusIndicator にマップ。Netlify と意味的に揃える。 */
const PHASE_STATUS_INDICATOR: Record<PhaseStatus, StatusIndicatorProps.Type> = {
  complete: "success",
  "in-progress": "in-progress",
  failed: "error",
  skipped: "stopped",
  pending: "pending",
};

const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  complete: "Complete",
  "in-progress": "In Progress",
  failed: "Failed",
  skipped: "Skipped",
  pending: "Pending",
};

export function DeploymentDetailPage({ config }: { config: AppConfig }) {
  const { jobId } = useParams<{ jobId: string }>();
  const apiClient = useApiClient(config);
  const [item, setItem] = useState<DeploymentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const stopPollingRef = useRef(false);
  const deployLogRef = useRef<HTMLDivElement | null>(null);
  // #534: StackEvents / Resources は基本情報と独立 state。CFn API が throttle / 権限不足で
  // 落ちても基本情報まで巻き込まない (= 別 state に閉じる)。
  const [stackProgress, setStackProgress] = useState<StackProgress | null>(null);
  const [stackProgressError, setStackProgressError] = useState<{
    message: string;
    notYetCreated: boolean;
  } | null>(null);
  const [stackProgressPending, setStackProgressPending] = useState(false);

  // showSpinner=true は手動再読み込みボタンからの呼び出し時のみ。auto polling は
  // 5 秒ごとに spinner を点滅させずバックグラウンド更新する。
  const fetchOnce = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (!apiClient || !jobId || !JOB_ID_RE.test(jobId)) return;
      if (showSpinner) setManualRefreshing(true);
      try {
        const fetched = await getDeployment(apiClient, jobId);
        setItem(fetched);
        setError(null);
        if (TERMINAL_STATUSES.has(fetched.status)) stopPollingRef.current = true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (showSpinner) setManualRefreshing(false);
      }
    },
    [apiClient, jobId],
  );

  const fetchStackProgress = useCallback(async () => {
    if (!apiClient || !jobId || !JOB_ID_RE.test(jobId)) return;
    setStackProgressPending(true);
    try {
      const progress = await getStackProgress(apiClient, jobId);
      setStackProgress(progress);
      setStackProgressError(null);
    } catch (err) {
      // #687: 「stack 未割当」(= deploy 初期で CFn 未着手) は次のいずれかで判定:
      //   - 409 (= backend が `stack_not_yet_created` で返す正規 path)
      //   - 5xx (= upstream Lambda が cold / API GW route 未配線 等の transient 状態)
      //   - TypeError (= DNS / CORS preflight 失敗 = "Failed to fetch")
      // いずれも "準備中" graceful UI に集約し、 raw error は出さない (#656 と同 pattern)。
      const notYetCreated =
        (err instanceof ApiError &&
          (err.status === StatusCodes.CONFLICT ||
            err.status === StatusCodes.BAD_GATEWAY ||
            err.status === StatusCodes.SERVICE_UNAVAILABLE ||
            err.status === StatusCodes.GATEWAY_TIMEOUT)) ||
        err instanceof TypeError ||
        (err instanceof Error && /failed to fetch/i.test(err.message));
      const message = err instanceof Error ? err.message : String(err);
      setStackProgressError({ message, notYetCreated });
    } finally {
      setStackProgressPending(false);
    }
  }, [apiClient, jobId]);

  useEffect(() => {
    let cancelled = false;
    stopPollingRef.current = false;
    const tick = async () => {
      if (cancelled || stopPollingRef.current) return;
      // 基本情報 + stack-progress を並列に fetch。stack-progress の error は基本情報を
      // 巻き込まない (= 別 state に閉じる)。Terminal 後も最終 stack 状態を 1 回 fetch するため
      // stopPollingRef は両 promise の after に評価する。
      await Promise.all([fetchOnce(), fetchStackProgress()]);
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce, fetchStackProgress]);

  const handleDelete = useCallback(async () => {
    if (!apiClient || !jobId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDeployment(apiClient, jobId);
      setDeleteModalOpen(false);
      // DELETING / DELETE_COMPLETE 遷移は StatusUpdater (1 min) が反映する。
      // 既存の polling が拾うので追加フェッチ不要、stop flag も解除して継続。
      stopPollingRef.current = false;
      await fetchOnce({ showSpinner: false });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [apiClient, jobId, fetchOnce]);

  const phases = useMemo(
    () => (item ? derivePhases(item, stackProgress) : []),
    [item, stackProgress],
  );
  const terminalLog = useMemo(
    () => (item ? buildTerminalLog(item, stackProgress, phases) : []),
    [item, stackProgress, phases],
  );

  const scrollDeployLog = useCallback((direction: "top" | "bottom") => {
    const el = deployLogRef.current;
    if (!el) return;
    el.scrollIntoView({ block: direction === "top" ? "start" : "end", behavior: "smooth" });
  }, []);

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return <Alert type="error">不正な Job ID です。</Alert>;
  }

  if (!item && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 状態を取得中...
      </Box>
    );
  }

  if (error && !item) {
    return (
      <Alert type="error" header="ジョブの取得に失敗しました">
        {error}
      </Alert>
    );
  }

  if (!item) return null;

  const outputs = parseStackOutputs(item.stackOutputs);
  const canDelete = item.status !== "DELETING" && item.status !== "DELETED";
  const teamLoginKey = item.teamLoginKey;
  const summaryTitle = deploySummaryTitle(item);

  return (
    <SpaceBetween size="l">
      {/* Top summary card (Netlify 風)。Cloudscape Container を dark background で
          stylize する。Job ID + 主要メタを 1 枚で見せる。 */}
      <Container disableContentPaddings>
        <div className="tc-deploy-summary">
          <SpaceBetween size="xs">
            <Box variant="h1" color="inherit">
              {summaryTitle}
            </Box>
            <Box variant="p" color="inherit">
              {item.problemId} · {item.displayTeamName ?? item.teamName}
            </Box>
            <Box variant="small" color="inherit">
              {formatLogTimestamp(item.createdAt)} · Job <code>{item.jobId}</code> · Tenant{" "}
              <code>{item.tenantId}</code>
            </Box>
            <div className="tc-deploy-summary-actions">
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => fetchOnce({ showSpinner: true })} loading={manualRefreshing}>
                  再読み込み
                </Button>
                <Button
                  variant="normal"
                  iconName="delete-marker"
                  disabled={!canDelete}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteModalOpen(true);
                  }}
                >
                  削除
                </Button>
              </SpaceBetween>
            </div>
          </SpaceBetween>
        </div>
      </Container>

      {item.status === "FAILED" && item.failureReason && (
        <Alert type="error" header="失敗理由">
          {item.failureReason}
        </Alert>
      )}

      {/* Deploy log (= phase list)。Netlify の collapsed phase 列を模す。 */}
      <div ref={deployLogRef}>
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="icon"
                    iconName="angle-up"
                    ariaLabel="ログの先頭にスクロール"
                    onClick={() => scrollDeployLog("top")}
                  />
                  <Button
                    variant="icon"
                    iconName="angle-down"
                    ariaLabel="ログの末尾にスクロール"
                    onClick={() => scrollDeployLog("bottom")}
                  />
                  <Button
                    iconName="expand"
                    onClick={() => setLogModalOpen(true)}
                    data-testid="maximize-log"
                  >
                    Maximize log
                  </Button>
                </SpaceBetween>
              }
              description={
                !TERMINAL_STATUSES.has(item.status)
                  ? `${POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。`
                  : undefined
              }
            >
              Deploy log
            </Header>
          }
        >
          <SpaceBetween size="xxs">
            {phases.map((phase) => (
              <PhaseRow
                key={phase.id}
                phase={phase}
                deployment={item}
                stackProgress={stackProgress}
                stackProgressError={stackProgressError}
                stackProgressPending={stackProgressPending}
              />
            ))}
          </SpaceBetween>
        </Container>
      </div>

      <Container header={<Header variant="h2">基本情報</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "Problem ID", value: <code>{item.problemId}</code> },
              {
                label: "表示名 (競技者選択)",
                value: item.displayTeamName ?? "(未設定)",
              },
              { label: "内部 slug (operator 入力)", value: <code>{item.teamName}</code> },
              { label: "AWS Account", value: <code>{item.awsAccountId}</code> },
              { label: "Region", value: item.region },
            ]}
          />
          <KeyValuePairs
            items={[
              { label: "Stack 名 prefix", value: <code>{item.namePrefix}</code> },
              {
                label: "Stack ID",
                value: item.stackId ? <code>{item.stackId}</code> : "(未割当)",
              },
              { label: "作成", value: item.createdAt },
              { label: "更新", value: item.updatedAt },
            ]}
          />
        </ColumnLayout>
      </Container>

      {teamLoginKey && (
        <Container
          header={
            <Header
              variant="h2"
              description="競技者にこのキーを渡してください。Participant Portal にログインするとこのチーム用の問題環境にアクセスできます。"
            >
              競技者 hand-off
            </Header>
          }
        >
          <KeyValuePairs
            items={[
              {
                label: "チーム共有ログインキー",
                value: (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Box variant="code">{teamLoginKey}</Box>
                    <Button
                      iconName="copy"
                      ariaLabel="ログインキーをコピー"
                      onClick={() => void navigator.clipboard?.writeText(teamLoginKey)}
                    >
                      コピー
                    </Button>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        </Container>
      )}

      {Object.keys(outputs).length > 0 && (
        <Container header={<Header variant="h2">CloudFormation Outputs</Header>}>
          <KeyValuePairs
            items={Object.entries(outputs).map(([label, value]) => ({
              label,
              value: <code>{value}</code>,
            }))}
          />
        </Container>
      )}

      <Modal
        visible={deleteModalOpen}
        onDismiss={() => setDeleteModalOpen(false)}
        header={`「${item.teamName}」のデプロイを削除`}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeleteModalOpen(false)} disabled={deleting}>
                キャンセル
              </Button>
              <Button variant="primary" loading={deleting} onClick={handleDelete}>
                削除する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            競技アカウント (<code>{item.awsAccountId}</code> / {item.region}) で起動中の
            CloudFormation Stack <code>{item.namePrefix}</code> を削除します。
          </Box>
          <Box variant="small" color="text-status-warning">
            この操作は取り消せません。実際の削除は次の StatusUpdater 周期 (最大 1 分)
            で実行されます。
          </Box>
          {deleteError && <Alert type="error">{deleteError}</Alert>}
        </SpaceBetween>
      </Modal>

      {/* Maximize log: terminal-style 全 phase の log。Cloudscape の Modal size="max"。 */}
      <Modal
        visible={logModalOpen}
        onDismiss={() => setLogModalOpen(false)}
        header="Deploy log"
        size="max"
        data-testid="deploy-log-modal"
      >
        <TerminalLogView lines={terminalLog} />
      </Modal>

      <DeploySummaryStyles />
    </SpaceBetween>
  );
}

/**
 * 1 phase 行。ExpandableSection で `>` chevron + 展開を Cloudscape に任せる。
 * Header に phase 名 + StatusIndicator を並べる。Body は phase ごとに切替。
 */
function PhaseRow(props: {
  readonly phase: DeployPhase;
  readonly deployment: DeploymentSummary;
  readonly stackProgress: StackProgress | null;
  readonly stackProgressError: { message: string; notYetCreated: boolean } | null;
  readonly stackProgressPending: boolean;
}) {
  const { phase, deployment, stackProgress, stackProgressError, stackProgressPending } = props;

  return (
    <ExpandableSection
      variant="default"
      headerText={
        <span className="tc-phase-header" data-testid={`phase-${phase.id}`}>
          <span className="tc-phase-name">{phase.name}</span>
          <span className="tc-phase-status">
            <StatusIndicator type={PHASE_STATUS_INDICATOR[phase.status]}>
              {PHASE_STATUS_LABEL[phase.status]}
            </StatusIndicator>
          </span>
        </span>
      }
    >
      <PhaseBody
        phase={phase}
        deployment={deployment}
        stackProgress={stackProgress}
        stackProgressError={stackProgressError}
        stackProgressPending={stackProgressPending}
      />
    </ExpandableSection>
  );
}

function PhaseBody(props: {
  readonly phase: DeployPhase;
  readonly deployment: DeploymentSummary;
  readonly stackProgress: StackProgress | null;
  readonly stackProgressError: { message: string; notYetCreated: boolean } | null;
  readonly stackProgressPending: boolean;
}) {
  const { phase, deployment, stackProgress, stackProgressError, stackProgressPending } = props;

  switch (phase.id) {
    case "enqueued":
      return (
        <KeyValuePairs
          items={[
            { label: "Enqueued at", value: deployment.createdAt },
            { label: "Tenant ID", value: <code>{deployment.tenantId}</code> },
            { label: "Problem ID", value: <code>{deployment.problemId}</code> },
            {
              label: "Team",
              value: deployment.displayTeamName ?? deployment.teamName,
            },
          ]}
        />
      );
    case "building":
      return (
        <SpaceBetween size="s">
          <Box variant="p">
            CodeBuild が問題テンプレートを競技者アカウントへ deploy するための CFn を組み立てます。
          </Box>
          {stackProgress?.consoleUrl ? (
            <Link href={stackProgress.consoleUrl} external>
              Open CodeBuild / CloudFormation logs in AWS Console
            </Link>
          ) : (
            <Box variant="small" color="text-status-info">
              CodeBuild console URL is not yet available.
            </Box>
          )}
        </SpaceBetween>
      );
    case "cfn-deploy":
      return (
        <StackProgressBody
          progress={stackProgress}
          error={stackProgressError}
          pending={stackProgressPending}
        />
      );
    case "health-check":
      return (
        <Box variant="p" color="text-status-info">
          {phase.note ?? "Skipped"}
        </Box>
      );
    case "complete":
      return (
        <KeyValuePairs
          items={[
            { label: "Final status", value: <code>{deployment.status}</code> },
            { label: "Last updated", value: deployment.updatedAt },
            ...(deployment.failureReason
              ? [{ label: "Failure reason", value: deployment.failureReason }]
              : []),
          ]}
        />
      );
  }
}

/**
 * #534: CFn 進行状況セクション。Events / Resources / Console deep link を出す。
 * Phase 3 (CloudFormation Deploy) の body として PhaseBody から呼ばれる。
 */
function StackProgressBody(props: {
  readonly progress: StackProgress | null;
  readonly error: { message: string; notYetCreated: boolean } | null;
  readonly pending: boolean;
}) {
  const { progress, error, pending } = props;

  // 初回ローディング: error も progress も無く、fetch in-flight。
  if (!progress && !error && pending) {
    return (
      <Box textAlign="center" padding="m">
        <Spinner /> CFn から取得中...
      </Box>
    );
  }

  // Error 表示。stack 未割当 (= API 側の `stack_not_yet_created` 409) は別 message に分ける。
  if (error && !progress) {
    return error.notYetCreated ? (
      <Box color="text-status-info">
        CFn Stack はまだ作成されていません。deploy worker (CodeBuild) が起動し次第、 ここに
        StackEvents / Resources が表示されます。
      </Box>
    ) : (
      <Alert type="warning" header="CFn の進行状況を取得できませんでした">
        {error.message}
      </Alert>
    );
  }

  if (!progress) return null;

  // 失敗 event を抽出 (= CREATE_FAILED / UPDATE_FAILED 等)。
  const firstFailure = progress.events.find((e) => e.resourceStatus.endsWith("_FAILED"));

  return (
    <SpaceBetween size="m">
      <Box>
        <Link href={progress.consoleUrl} external>
          Open CloudFormation console
        </Link>
        {progress.stackStatus && (
          <Box variant="small" margin={{ top: "xxs" }}>
            現在の CFn Stack 状態: <code>{progress.stackStatus}</code>
          </Box>
        )}
      </Box>

      {firstFailure && (
        <Alert type="error" header={`失敗: ${firstFailure.logicalResourceId}`}>
          <Box>
            <code>{firstFailure.resourceType}</code> が <code>{firstFailure.resourceStatus}</code>{" "}
            になりました。
          </Box>
          {firstFailure.resourceStatusReason && (
            <Box variant="small">{firstFailure.resourceStatusReason}</Box>
          )}
        </Alert>
      )}

      <Table<StackProgressEvent>
        variant="embedded"
        header={<Header variant="h3">StackEvents (最新 {progress.events.length} 件)</Header>}
        items={[...progress.events]}
        empty={
          <Box textAlign="center" color="inherit" padding="l">
            StackEvents はまだありません。
          </Box>
        }
        columnDefinitions={[
          {
            id: "timestamp",
            header: "時刻",
            cell: (e) => e.timestamp,
            width: 200,
          },
          {
            id: "logicalResourceId",
            header: "LogicalId",
            cell: (e) => <code>{e.logicalResourceId}</code>,
            width: 220,
          },
          {
            id: "resourceType",
            header: "Type",
            cell: (e) => <code>{e.resourceType}</code>,
            width: 220,
          },
          {
            id: "status",
            header: "Status",
            cell: (e) => (
              <StatusIndicator type={statusToIndicator(e.resourceStatus)}>
                {e.resourceStatus}
              </StatusIndicator>
            ),
            width: 240,
          },
          {
            id: "reason",
            header: "Reason",
            cell: (e) => e.resourceStatusReason ?? "",
          },
        ]}
      />

      <Table<StackProgressResource>
        variant="embedded"
        header={<Header variant="h3">Resources ({progress.resources.length} 件)</Header>}
        items={[...progress.resources]}
        empty={
          <Box textAlign="center" color="inherit" padding="l">
            Resources はまだ作成されていません。
          </Box>
        }
        columnDefinitions={[
          {
            id: "logicalResourceId",
            header: "LogicalId",
            cell: (r) => <code>{r.logicalResourceId}</code>,
            width: 220,
          },
          {
            id: "resourceType",
            header: "Type",
            cell: (r) => <code>{r.resourceType}</code>,
            width: 220,
          },
          {
            id: "status",
            header: "Status",
            cell: (r) => (
              <StatusIndicator type={statusToIndicator(r.resourceStatus)}>
                {r.resourceStatus}
              </StatusIndicator>
            ),
            width: 240,
          },
          {
            id: "physicalResourceId",
            header: "PhysicalId",
            cell: (r) => (r.physicalResourceId ? <code>{r.physicalResourceId}</code> : ""),
          },
        ]}
      />
    </SpaceBetween>
  );
}

/**
 * Terminal-style log renderer。Netlify の expanded log view を模す。
 * - 左 gutter: 行番号 (right-aligned, dim)
 * - 中央 gutter: timestamp
 * - 右: log text (section header は cyan)
 */
function TerminalLogView({ lines }: { lines: readonly LogLine[] }) {
  // 行番号は append-only な log なので index で問題ないが、key には text + ts を
  // 組み合わせた stable な値を使う (biome の useArrayKey 規約)。同一行が重複するケース
  // のために locallyUnique counter を ts+text で消化する。
  const keys = (() => {
    const seen = new Map<string, number>();
    return lines.map((line) => {
      const base = `${line.timestamp ?? ""}|${line.header ? "H" : "L"}|${line.text}`;
      const dup = seen.get(base) ?? 0;
      seen.set(base, dup + 1);
      return dup === 0 ? base : `${base}#${dup}`;
    });
  })();
  return (
    <div className="tc-terminal-log" data-testid="terminal-log">
      <pre className="tc-terminal-log-pre">
        {lines.map((line, idx) => {
          const number = String(idx + 1).padStart(3, " ");
          const ts = line.timestamp ?? "";
          return (
            <div
              key={keys[idx]}
              className={line.header ? "tc-log-line tc-log-header" : "tc-log-line"}
            >
              <span className="tc-log-number">{number}</span>
              <span className="tc-log-ts">{ts && `${ts}:`}</span>
              <span className="tc-log-text">{line.text}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/**
 * Component-scoped CSS。Cloudscape primitive で表現しきれない:
 *   - dark background の summary card
 *   - terminal-style log の三列 grid
 * をここで閉じる。global stylesheet を汚さない。
 */
function DeploySummaryStyles() {
  return (
    <style>{`
.tc-deploy-summary {
  background: #0f1419;
  color: #e8eaed;
  padding: 24px 32px;
  border-radius: 12px;
}
.tc-deploy-summary code {
  color: #9ad3ff;
}
.tc-deploy-summary-actions {
  margin-top: 12px;
}
.tc-phase-header {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}
.tc-phase-name {
  font-weight: 600;
}
.tc-phase-status {
  margin-left: auto;
}
.tc-terminal-log {
  background: #0f1419;
  color: #e8eaed;
  padding: 16px;
  border-radius: 8px;
  max-height: 80vh;
  overflow: auto;
}
.tc-terminal-log-pre {
  margin: 0;
  font-family: "SF Mono", Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}
.tc-log-line {
  display: grid;
  grid-template-columns: 4ch 11ch 1fr;
  gap: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.tc-log-number {
  text-align: right;
  color: #5a6470;
  font-variant-numeric: tabular-nums;
}
.tc-log-ts {
  color: #8a99a8;
  font-variant-numeric: tabular-nums;
}
.tc-log-text {
  color: #e8eaed;
}
.tc-log-header .tc-log-text {
  color: #66d9ef;
  font-weight: 600;
}
`}</style>
  );
}
