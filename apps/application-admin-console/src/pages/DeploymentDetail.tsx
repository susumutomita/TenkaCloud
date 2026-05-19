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
import { useT } from "../i18n";
import {
  buildTerminalLog,
  type DeployPhase,
  deploySummaryTitle,
  derivePhases,
  formatLogTimestamp,
  type LogLine,
  type PhaseStatus,
} from "../lib/deploy-phases";

type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

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
  const t = useT();
  const [item, setItem] = useState<DeploymentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
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
    return <Alert type="error">{t("deployment_detail.invalid_job_id")}</Alert>;
  }

  if (!item && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("deployment_detail.loading_status")}
      </Box>
    );
  }

  if (error && !item) {
    return (
      <Alert type="error" header={t("deployment_detail.fetch_failed_header")}>
        {error}
      </Alert>
    );
  }

  if (!item) return null;

  const outputs = parseStackOutputs(item.stackOutputs);
  const teamLoginKey = item.teamLoginKey;
  const summaryTitle = deploySummaryTitle(item);

  return (
    <SpaceBetween size="l">
      {/* #1091: 黒い Netlify 風 banner を撤去し Cloudscape の標準 Header に揃える。
       *   個別 deployment の削除は ここから行わず、 Event 全体の teardown
       *   (= EventDetail の bulk teardown modal) に一本化する。
       */}
      <Header
        variant="h1"
        description={`${item.problemId} · ${item.displayTeamName ?? item.teamName} · Job ${item.jobId}`}
        actions={
          <Button onClick={() => fetchOnce({ showSpinner: true })} loading={manualRefreshing}>
            {t("deployment_detail.reload")}
          </Button>
        }
      >
        {summaryTitle}
      </Header>

      {item.status === "FAILED" && item.failureReason && (
        <Alert type="error" header={t("deployment_detail.failure_reason_header")}>
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
                    ariaLabel={t("deployment_detail.log_scroll_top")}
                    onClick={() => scrollDeployLog("top")}
                  />
                  <Button
                    variant="icon"
                    iconName="angle-down"
                    ariaLabel={t("deployment_detail.log_scroll_bottom")}
                    onClick={() => scrollDeployLog("bottom")}
                  />
                  <Button
                    iconName="expand"
                    onClick={() => setLogModalOpen(true)}
                    data-testid="maximize-log"
                  >
                    {t("deployment_detail.log_maximize")}
                  </Button>
                </SpaceBetween>
              }
              description={
                !TERMINAL_STATUSES.has(item.status)
                  ? t("deployment_detail.log_auto_refresh", {
                      seconds: POLL_INTERVAL_MS / 1000,
                    })
                  : undefined
              }
            >
              {t("deployment_detail.deploy_log_header")}
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
                t={t}
              />
            ))}
          </SpaceBetween>
        </Container>
      </div>

      <Container header={<Header variant="h2">{t("deployment_detail.basic_info_header")}</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              {
                label: t("deployment_detail.label_problem_id"),
                value: <code>{item.problemId}</code>,
              },
              {
                label: t("deployment_detail.label_display_name"),
                value: item.displayTeamName ?? t("deployment_detail.value_unset"),
              },
              {
                label: t("deployment_detail.label_internal_slug"),
                value: <code>{item.teamName}</code>,
              },
              {
                label: t("deployment_detail.label_aws_account"),
                value: <code>{item.awsAccountId}</code>,
              },
              { label: t("deployment_detail.label_region"), value: item.region },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: t("deployment_detail.label_stack_prefix"),
                value: <code>{item.namePrefix}</code>,
              },
              {
                label: t("deployment_detail.label_stack_id"),
                value: item.stackId ? (
                  <code>{item.stackId}</code>
                ) : (
                  t("deployment_detail.value_unassigned")
                ),
              },
              { label: t("deployment_detail.label_created_at"), value: item.createdAt },
              { label: t("deployment_detail.label_updated_at"), value: item.updatedAt },
            ]}
          />
        </ColumnLayout>
      </Container>

      {teamLoginKey && (
        <Container
          header={
            <Header variant="h2" description={t("deployment_detail.handoff_description")}>
              {t("deployment_detail.handoff_header")}
            </Header>
          }
        >
          <KeyValuePairs
            items={[
              {
                label: t("deployment_detail.label_team_login_key"),
                value: (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Box variant="code">{teamLoginKey}</Box>
                    <Button
                      iconName="copy"
                      ariaLabel={t("deployment_detail.copy_login_key_aria")}
                      onClick={() => void navigator.clipboard?.writeText(teamLoginKey)}
                    >
                      {t("deployment_detail.copy")}
                    </Button>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        </Container>
      )}

      {Object.keys(outputs).length > 0 && (
        <Container
          header={<Header variant="h2">{t("deployment_detail.cfn_outputs_header")}</Header>}
        >
          <KeyValuePairs
            items={Object.entries(outputs).map(([label, value]) => ({
              label,
              value: <code>{value}</code>,
            }))}
          />
        </Container>
      )}

      {/* Maximize log: terminal-style 全 phase の log。Cloudscape の Modal size="max"。 */}
      <Modal
        visible={logModalOpen}
        onDismiss={() => setLogModalOpen(false)}
        header={t("deployment_detail.deploy_log_header")}
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
  readonly t: TFn;
}) {
  const { phase, deployment, stackProgress, stackProgressError, stackProgressPending, t } = props;

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
        t={t}
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
  readonly t: TFn;
}) {
  const { phase, deployment, stackProgress, stackProgressError, stackProgressPending, t } = props;

  switch (phase.id) {
    case "enqueued":
      return (
        <KeyValuePairs
          items={[
            { label: t("deployment_detail.label_enqueued_at"), value: deployment.createdAt },
            {
              label: t("deployment_detail.label_tenant_id"),
              value: <code>{deployment.tenantId}</code>,
            },
            {
              label: t("deployment_detail.label_problem_id"),
              value: <code>{deployment.problemId}</code>,
            },
            {
              label: t("deployment_detail.label_team"),
              value: deployment.displayTeamName ?? deployment.teamName,
            },
          ]}
        />
      );
    case "building":
      return (
        <SpaceBetween size="s">
          <Box variant="p">{t("deployment_detail.phase_building_description")}</Box>
          {stackProgress?.consoleUrl ? (
            <Link href={stackProgress.consoleUrl} external>
              {t("deployment_detail.phase_building_link")}
            </Link>
          ) : (
            <Box variant="small" color="text-status-info">
              {t("deployment_detail.phase_building_url_unavailable")}
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
          t={t}
        />
      );
    case "health-check":
      return (
        <Box variant="p" color="text-status-info">
          {phase.note ?? t("deployment_detail.phase_health_skipped")}
        </Box>
      );
    case "complete":
      return (
        <KeyValuePairs
          items={[
            {
              label: t("deployment_detail.label_final_status"),
              value: <code>{deployment.status}</code>,
            },
            { label: t("deployment_detail.label_last_updated"), value: deployment.updatedAt },
            ...(deployment.failureReason
              ? [
                  {
                    label: t("deployment_detail.label_failure_reason"),
                    value: deployment.failureReason,
                  },
                ]
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
  readonly t: TFn;
}) {
  const { progress, error, pending, t } = props;

  if (!progress && !error && pending) {
    return (
      <Box textAlign="center" padding="m">
        <Spinner /> {t("deployment_detail.stack_loading")}
      </Box>
    );
  }

  if (error && !progress) {
    return error.notYetCreated ? (
      <Box color="text-status-info">{t("deployment_detail.stack_not_yet_created")}</Box>
    ) : (
      <Alert type="warning" header={t("deployment_detail.stack_fetch_failed_header")}>
        {error.message}
      </Alert>
    );
  }

  if (!progress) return null;

  const firstFailure = progress.events.find((e) => e.resourceStatus.endsWith("_FAILED"));

  return (
    <SpaceBetween size="m">
      <Box>
        <Link href={progress.consoleUrl} external>
          {t("deployment_detail.open_cfn_console")}
        </Link>
        {progress.stackStatus && (
          <Box variant="small" margin={{ top: "xxs" }}>
            {t("deployment_detail.stack_status_label")}: <code>{progress.stackStatus}</code>
          </Box>
        )}
      </Box>

      {firstFailure && (
        <Alert
          type="error"
          header={t("deployment_detail.failure_alert_header", {
            logicalId: firstFailure.logicalResourceId,
          })}
        >
          <Box>
            {t("deployment_detail.failure_body", {
              resourceType: firstFailure.resourceType,
              status: firstFailure.resourceStatus,
            })}
          </Box>
          {firstFailure.resourceStatusReason && (
            <Box variant="small">{firstFailure.resourceStatusReason}</Box>
          )}
        </Alert>
      )}

      {progress.stuck?.isStuck && (
        <Alert type="warning" header={t("deployment_detail.stuck_header")}>
          <SpaceBetween size="xs">
            <Box>
              {t("deployment_detail.stuck_elapsed", { minutes: progress.stuck.elapsedMinutes })}
              {progress.stuck.resourceLogicalId && (
                <>
                  {" "}
                  {t("deployment_detail.stuck_target")}:{" "}
                  <code>{progress.stuck.resourceLogicalId}</code>
                  {progress.stuck.resourceStatus ? (
                    <>
                      {" "}
                      (<code>{progress.stuck.resourceStatus}</code>)
                    </>
                  ) : null}
                </>
              )}
            </Box>
            <Box>{progress.stuck.reason}</Box>
            <Box variant="small">{progress.stuck.remediationHint}</Box>
          </SpaceBetween>
        </Alert>
      )}

      <Table<StackProgressEvent>
        variant="embedded"
        header={
          <Header variant="h3">
            {t("deployment_detail.events_header", { count: progress.events.length })}
          </Header>
        }
        items={[...progress.events]}
        empty={
          <Box textAlign="center" color="inherit" padding="l">
            {t("deployment_detail.events_empty")}
          </Box>
        }
        columnDefinitions={[
          {
            id: "timestamp",
            header: t("deployment_detail.col_timestamp"),
            cell: (e) => e.timestamp,
            width: 200,
          },
          {
            id: "logicalResourceId",
            header: t("deployment_detail.col_logical_id"),
            cell: (e) => <code>{e.logicalResourceId}</code>,
            width: 220,
          },
          {
            id: "resourceType",
            header: t("deployment_detail.col_resource_type"),
            cell: (e) => <code>{e.resourceType}</code>,
            width: 220,
          },
          {
            id: "status",
            header: t("deployment_detail.col_status"),
            cell: (e) => (
              <StatusIndicator type={statusToIndicator(e.resourceStatus)}>
                {e.resourceStatus}
              </StatusIndicator>
            ),
            width: 240,
          },
          {
            id: "reason",
            header: t("deployment_detail.col_reason"),
            cell: (e) => e.resourceStatusReason ?? "",
          },
        ]}
      />

      <Table<StackProgressResource>
        variant="embedded"
        header={
          <Header variant="h3">
            {t("deployment_detail.resources_header", { count: progress.resources.length })}
          </Header>
        }
        items={[...progress.resources]}
        empty={
          <Box textAlign="center" color="inherit" padding="l">
            {t("deployment_detail.resources_empty")}
          </Box>
        }
        columnDefinitions={[
          {
            id: "logicalResourceId",
            header: t("deployment_detail.col_logical_id"),
            cell: (r) => <code>{r.logicalResourceId}</code>,
            width: 220,
          },
          {
            id: "resourceType",
            header: t("deployment_detail.col_resource_type"),
            cell: (r) => <code>{r.resourceType}</code>,
            width: 220,
          },
          {
            id: "status",
            header: t("deployment_detail.col_status"),
            cell: (r) => (
              <StatusIndicator type={statusToIndicator(r.resourceStatus)}>
                {r.resourceStatus}
              </StatusIndicator>
            ),
            width: 240,
          },
          {
            id: "physicalResourceId",
            header: t("deployment_detail.col_physical_id"),
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
 * Component-scoped CSS。Cloudscape primitive で表現しきれない terminal-style
 * log の grid と code styling だけをここで閉じる。 旧 dark-background summary
 * card 用 CSS は #1091 で Cloudscape Header に揃えたため撤去済。
 */
function DeploySummaryStyles() {
  return (
    <style>{`
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
