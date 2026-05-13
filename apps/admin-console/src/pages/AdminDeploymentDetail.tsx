import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  AdminInsightApiError,
  cfnStatusToIndicator,
  DEPLOYMENT_STATUS_INDICATOR,
  type DeploymentDetail,
  fetchTenantDeploymentDetail,
  fetchTenantStackProgress,
  parseStackOutputs,
  type StackProgress,
  type StackProgressEvent,
  type StackProgressResource,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * Phase 1.B drill-down — Deploy job 詳細 (read-only mirror、ADR-011 / #598)。
 *
 * Application Admin Console の DeploymentDetail.tsx と異なる点:
 *   - read-only。**「削除」 button は持たない** (= SystemAdmin は tenant の deploy を削除しない)
 *   - 「競技者 hand-off」 (= teamLoginKey 表示) section は **無い**。SystemAdmin 経路では
 *     一切露出しない (ADR-011 D2)
 *
 * polling 5s で基本情報 + CFn StackProgress を更新する (= operator UX を Tenant Admin
 * console と揃える)。Terminal status (COMPLETE / FAILED / DELETED) に遷移したら停止。
 */
// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒は 12 req/min/user で過多)。
const POLL_INTERVAL_MS = 30_000;
const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED", "DELETED"]);

export function AdminDeploymentDetailPage({ config }: { config: AppConfig }) {
  const { tenantId, jobId } = useParams<{ tenantId: string; jobId: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const [item, setItem] = useState<DeploymentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [stackProgress, setStackProgress] = useState<StackProgress | null>(null);
  const [stackProgressError, setStackProgressError] = useState<{
    message: string;
    notYetCreated: boolean;
  } | null>(null);
  const [stackProgressPending, setStackProgressPending] = useState(false);
  const stopPollingRef = useRef(false);

  const idToken = auth.tokens?.idToken;

  const fetchDetail = useCallback(async () => {
    if (!idToken || !tenantId || !jobId) return;
    try {
      const res = await fetchTenantDeploymentDetail(config, idToken, tenantId, jobId);
      if (res === null) return; // adminInsightApiUrl 未配線
      setItem(res);
      setError(null);
      setForbidden(false);
      setNotFound(false);
      if (TERMINAL_STATUSES.has(res.status)) stopPollingRef.current = true;
    } catch (err) {
      if (err instanceof AdminInsightApiError) {
        if (err.status === StatusCodes.FORBIDDEN) {
          setForbidden(true);
          return;
        }
        if (err.status === StatusCodes.NOT_FOUND) {
          setNotFound(true);
          return;
        }
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [config, idToken, tenantId, jobId]);

  const fetchProgress = useCallback(async () => {
    if (!idToken || !tenantId || !jobId) return;
    setStackProgressPending(true);
    try {
      const res = await fetchTenantStackProgress(config, idToken, tenantId, jobId);
      if (res === null) return;
      setStackProgress(res);
      setStackProgressError(null);
    } catch (err) {
      const notYetCreated =
        err instanceof AdminInsightApiError && err.status === StatusCodes.CONFLICT;
      const message = err instanceof Error ? err.message : String(err);
      setStackProgressError({ message, notYetCreated });
    } finally {
      setStackProgressPending(false);
    }
  }, [config, idToken, tenantId, jobId]);

  useEffect(() => {
    let cancelled = false;
    stopPollingRef.current = false;
    const tick = async () => {
      if (cancelled || stopPollingRef.current) return;
      await Promise.all([fetchDetail(), fetchProgress()]);
    };
    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [fetchDetail, fetchProgress]);

  if (!tenantId || !jobId || !JOB_ID_RE.test(jobId)) {
    return <Alert type="error">不正なパラメータです。</Alert>;
  }

  if (forbidden) {
    return (
      <Alert type="error" header="権限がありません">
        この機能は SystemAdmin group のメンバーのみ閲覧できます。ログインし直してください。
      </Alert>
    );
  }

  if (notFound) {
    return (
      <SpaceBetween size="l">
        <Header
          variant="h1"
          actions={
            <Button
              variant="normal"
              onClick={() => navigate(`/tenants/${encodeURIComponent(tenantId)}/events`)}
            >
              Event 一覧に戻る
            </Button>
          }
        >
          Deploy Job が見つかりません
        </Header>
        <Alert type="warning">
          Tenant {tenantId} に Job {jobId} は存在しません。
        </Alert>
      </SpaceBetween>
    );
  }

  if (!item && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 状態を取得中…
      </Box>
    );
  }

  if (error && !item) {
    return (
      <Alert type="error" header="Deploy Job 詳細の取得に失敗しました">
        {error}
      </Alert>
    );
  }

  if (!item) return null;

  const outputs = parseStackOutputs(item.stackOutputs);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={
          <>
            Tenant: <code>{tenantId}</code> / Job ID: <code>{item.jobId}</code>
          </>
        }
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="normal"
              onClick={() => navigate(`/tenants/${encodeURIComponent(tenantId)}/events`)}
            >
              Event 一覧に戻る
            </Button>
            {item.eventId && (
              <Button
                variant="normal"
                onClick={() => {
                  const parentEventId = item.eventId;
                  if (parentEventId) {
                    navigate(
                      `/tenants/${encodeURIComponent(tenantId)}/events/${encodeURIComponent(parentEventId)}`,
                    );
                  }
                }}
              >
                親 Event に戻る
              </Button>
            )}
          </SpaceBetween>
        }
      >
        Deploy「{item.displayTeamName ?? item.teamName}」
      </Header>

      {error && (
        <Alert
          type="warning"
          header="再読み込みに失敗しました"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <Container header={<Header variant="h2">ステータス</Header>}>
        <SpaceBetween size="m">
          <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
            {item.status}
          </StatusIndicator>
          {item.status === "FAILED" && item.failureReason && (
            <Alert type="error" header="失敗理由">
              {item.failureReason}
            </Alert>
          )}
          {!TERMINAL_STATUSES.has(item.status) && (
            <Box variant="small" color="text-status-info">
              {POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">基本情報</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "Problem ID", value: <code>{item.problemId}</code> },
              { label: "表示名 (競技者選択)", value: item.displayTeamName ?? "(未設定)" },
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
              {
                label: "Event ID",
                value: item.eventId ? <code>{item.eventId}</code> : "(該当なし)",
              },
            ]}
          />
        </ColumnLayout>
        <Box variant="small" color="text-status-info" padding={{ top: "s" }}>
          ※ ログインキー (`teamLoginKey`) は SystemAdmin 経路では露出しません (ADR-011 D2)。
        </Box>
      </Container>

      <StackProgressSection
        progress={stackProgress}
        error={stackProgressError}
        pending={stackProgressPending}
      />

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
    </SpaceBetween>
  );
}

/**
 * CFn 進行状況セクション。application-admin-console の StackProgressSection と
 * **同じ shape / behaviour** だが、read-only なので 「再試行」 button は持たない。
 */
function StackProgressSection(props: {
  readonly progress: StackProgress | null;
  readonly error: { message: string; notYetCreated: boolean } | null;
  readonly pending: boolean;
}) {
  const { progress, error, pending } = props;

  if (!progress && !error && pending) {
    return (
      <Container header={<Header variant="h2">Stack 進行状況</Header>}>
        <Box textAlign="center" padding="m">
          <Spinner /> CFn から取得中…
        </Box>
      </Container>
    );
  }

  if (error && !progress) {
    return (
      <Container header={<Header variant="h2">Stack 進行状況</Header>}>
        {error.notYetCreated ? (
          <Box color="text-status-info">
            CFn Stack はまだ作成されていません。deploy worker が起動し次第、ここに StackEvents /
            Resources が表示されます。
          </Box>
        ) : (
          <Alert type="warning" header="CFn の進行状況を取得できませんでした">
            {error.message}
          </Alert>
        )}
      </Container>
    );
  }

  if (!progress) return null;

  const firstFailure = progress.events.find((e) => e.resourceStatus.endsWith("_FAILED"));

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            progress.stackStatus
              ? `現在の CFn Stack 状態: ${progress.stackStatus}`
              : "CFn StackEvents / Resources を CFn API から直接取得しています。"
          }
          actions={
            <Link href={progress.consoleUrl} external>
              CFn console を開く
            </Link>
          }
        >
          Stack 進行状況
        </Header>
      }
    >
      <SpaceBetween size="m">
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
                <StatusIndicator type={cfnStatusToIndicator(e.resourceStatus)}>
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
                <StatusIndicator type={cfnStatusToIndicator(r.resourceStatus)}>
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
    </Container>
  );
}
