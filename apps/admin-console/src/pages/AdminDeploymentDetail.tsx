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
import { interpolate, useT } from "../i18n";

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
  const t = useT();
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
    return <Alert type="error">{t("admin_deployment_detail.invalid_params")}</Alert>;
  }

  if (forbidden) {
    return (
      <Alert type="error" header={t("admin_deployment_detail.forbidden_header")}>
        {t("admin_deployment_detail.forbidden_body")}
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
              {t("admin_deployment_detail.back_to_events")}
            </Button>
          }
        >
          {t("admin_deployment_detail.not_found_header")}
        </Header>
        <Alert type="warning">
          {interpolate(t("admin_deployment_detail.not_found_body"), { tenantId, jobId })}
        </Alert>
      </SpaceBetween>
    );
  }

  if (!item && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("admin_deployment_detail.loading")}
      </Box>
    );
  }

  if (error && !item) {
    return (
      <Alert type="error" header={t("admin_deployment_detail.fetch_error_header")}>
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
            {t("admin_deployment_detail.tenant_label")}: <code>{tenantId}</code> /{" "}
            {t("admin_deployment_detail.job_id_label")}: <code>{item.jobId}</code>
          </>
        }
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="normal"
              onClick={() => navigate(`/tenants/${encodeURIComponent(tenantId)}/events`)}
            >
              {t("admin_deployment_detail.back_to_events")}
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
                {t("admin_deployment_detail.back_to_parent_event")}
              </Button>
            )}
          </SpaceBetween>
        }
      >
        {interpolate(t("admin_deployment_detail.title"), {
          teamName: item.displayTeamName ?? item.teamName,
        })}
      </Header>

      {error && (
        <Alert
          type="warning"
          header={t("admin_deployment_detail.reload_error_header")}
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <Container
        header={<Header variant="h2">{t("admin_deployment_detail.status_header")}</Header>}
      >
        <SpaceBetween size="m">
          <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
            {item.status}
          </StatusIndicator>
          {item.status === "FAILED" && item.failureReason && (
            <Alert type="error" header={t("admin_deployment_detail.failure_reason_header")}>
              {item.failureReason}
            </Alert>
          )}
          {!TERMINAL_STATUSES.has(item.status) && (
            <Box variant="small" color="text-status-info">
              {interpolate(t("admin_deployment_detail.auto_refresh"), {
                seconds: String(POLL_INTERVAL_MS / 1000),
              })}
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container
        header={<Header variant="h2">{t("admin_deployment_detail.basic_info_header")}</Header>}
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              {
                label: t("admin_deployment_detail.label_problem_id"),
                value: <code>{item.problemId}</code>,
              },
              {
                label: t("admin_deployment_detail.label_display_name"),
                value: item.displayTeamName ?? t("admin_deployment_detail.unset"),
              },
              {
                label: t("admin_deployment_detail.label_internal_slug"),
                value: <code>{item.teamName}</code>,
              },
              {
                label: t("admin_deployment_detail.label_aws_account"),
                value: <code>{item.awsAccountId}</code>,
              },
              { label: t("admin_deployment_detail.label_region"), value: item.region },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: t("admin_deployment_detail.label_stack_name_prefix"),
                value: <code>{item.namePrefix}</code>,
              },
              {
                label: t("admin_deployment_detail.label_stack_id"),
                value: item.stackId ? (
                  <code>{item.stackId}</code>
                ) : (
                  t("admin_deployment_detail.unassigned")
                ),
              },
              { label: t("admin_deployment_detail.label_created"), value: item.createdAt },
              { label: t("admin_deployment_detail.label_updated"), value: item.updatedAt },
              {
                label: t("admin_deployment_detail.label_event_id"),
                value: item.eventId ? (
                  <code>{item.eventId}</code>
                ) : (
                  t("admin_deployment_detail.not_applicable")
                ),
              },
            ]}
          />
        </ColumnLayout>
        <Box variant="small" color="text-status-info" padding={{ top: "s" }}>
          {t("admin_deployment_detail.login_key_note")}
        </Box>
      </Container>

      <StackProgressSection
        progress={stackProgress}
        error={stackProgressError}
        pending={stackProgressPending}
      />

      {Object.keys(outputs).length > 0 && (
        <Container
          header={
            <Header variant="h2">
              {t("admin_deployment_detail.cloudformation_outputs_header")}
            </Header>
          }
        >
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
  const t = useT();

  if (!progress && !error && pending) {
    return (
      <Container
        header={<Header variant="h2">{t("admin_deployment_detail.stack_progress_header")}</Header>}
      >
        <Box textAlign="center" padding="m">
          <Spinner /> {t("admin_deployment_detail.stack_progress_loading")}
        </Box>
      </Container>
    );
  }

  if (error && !progress) {
    return (
      <Container
        header={<Header variant="h2">{t("admin_deployment_detail.stack_progress_header")}</Header>}
      >
        {error.notYetCreated ? (
          <Box color="text-status-info">{t("admin_deployment_detail.stack_not_yet_created")}</Box>
        ) : (
          <Alert type="warning" header={t("admin_deployment_detail.stack_progress_error_header")}>
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
              ? interpolate(t("admin_deployment_detail.stack_status_description"), {
                  status: progress.stackStatus,
                })
              : t("admin_deployment_detail.stack_direct_fetch_description")
          }
          actions={
            <Link href={progress.consoleUrl} external>
              {t("admin_deployment_detail.open_cfn_console")}
            </Link>
          }
        >
          {t("admin_deployment_detail.stack_progress_header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {firstFailure && (
          <Alert
            type="error"
            header={interpolate(t("admin_deployment_detail.stack_failure_header"), {
              logicalResourceId: firstFailure.logicalResourceId,
            })}
          >
            <Box>
              {interpolate(t("admin_deployment_detail.stack_failure_body"), {
                resourceType: firstFailure.resourceType,
                resourceStatus: firstFailure.resourceStatus,
              })}
            </Box>
            {firstFailure.resourceStatusReason && (
              <Box variant="small">{firstFailure.resourceStatusReason}</Box>
            )}
          </Alert>
        )}

        <Table<StackProgressEvent>
          variant="embedded"
          header={
            <Header variant="h3">
              {interpolate(t("admin_deployment_detail.stack_events_header"), {
                count: String(progress.events.length),
              })}
            </Header>
          }
          items={[...progress.events]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              {t("admin_deployment_detail.stack_events_empty")}
            </Box>
          }
          columnDefinitions={[
            {
              id: "timestamp",
              header: t("admin_deployment_detail.col_timestamp"),
              cell: (e) => e.timestamp,
              width: 200,
            },
            {
              id: "logicalResourceId",
              header: t("admin_deployment_detail.col_logical_id"),
              cell: (e) => <code>{e.logicalResourceId}</code>,
              width: 220,
            },
            {
              id: "resourceType",
              header: t("admin_deployment_detail.col_type"),
              cell: (e) => <code>{e.resourceType}</code>,
              width: 220,
            },
            {
              id: "status",
              header: t("admin_deployment_detail.col_status"),
              cell: (e) => (
                <StatusIndicator type={cfnStatusToIndicator(e.resourceStatus)}>
                  {e.resourceStatus}
                </StatusIndicator>
              ),
              width: 240,
            },
            {
              id: "reason",
              header: t("admin_deployment_detail.col_reason"),
              cell: (e) => e.resourceStatusReason ?? "",
            },
          ]}
        />

        <Table<StackProgressResource>
          variant="embedded"
          header={
            <Header variant="h3">
              {interpolate(t("admin_deployment_detail.resources_header"), {
                count: String(progress.resources.length),
              })}
            </Header>
          }
          items={[...progress.resources]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              {t("admin_deployment_detail.resources_empty")}
            </Box>
          }
          columnDefinitions={[
            {
              id: "logicalResourceId",
              header: t("admin_deployment_detail.col_logical_id"),
              cell: (r) => <code>{r.logicalResourceId}</code>,
              width: 220,
            },
            {
              id: "resourceType",
              header: t("admin_deployment_detail.col_type"),
              cell: (r) => <code>{r.resourceType}</code>,
              width: 220,
            },
            {
              id: "status",
              header: t("admin_deployment_detail.col_status"),
              cell: (r) => (
                <StatusIndicator type={cfnStatusToIndicator(r.resourceStatus)}>
                  {r.resourceStatus}
                </StatusIndicator>
              ),
              width: 240,
            },
            {
              id: "physicalResourceId",
              header: t("admin_deployment_detail.col_physical_id"),
              cell: (r) => (r.physicalResourceId ? <code>{r.physicalResourceId}</code> : ""),
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}
