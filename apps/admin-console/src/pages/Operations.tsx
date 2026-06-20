import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { ErrorState, toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  AdminInsightApiError,
  fetchPipelineExecutions,
  fetchStateMachineExecutions,
  type PipelineExecutionItem,
  type StateMachineExecutionItem,
} from "../api/admin-drill-down";
import { type ApiClient, useApiClient } from "../api/client";
import {
  fetchTenantsInsightSummary,
  indexSummaryByTenantId,
  type TenantInsightSummary,
} from "../api/insight";
import { listTenants, type Tenant } from "../api/tenants";
import { useAuth } from "../auth/AuthProvider";
import { BudgetConsumptionPanel } from "../components/BudgetConsumptionPanel";
import type { AppConfig } from "../config";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";
import { useT } from "../i18n";
import { computeUsageTotals } from "../lib/usage";

/**
 * Issue #1770: System Admin 向け Operations page。
 *
 * 第一弾は既存 API だけで構成する:
 *   - Control Plane API `GET /tenants` (= tenant count / active tenants)
 *   - AdminInsight API `GET /admin/insight/tenants/summary` (= active / failed deploy count)
 *   - AdminInsight jobs API (= recent provisioning / deprovisioning failures)
 *
 * CloudWatch Dashboard / AWS Budgets / Alarms の deep link (#1080) はページ下部に残し、
 * CloudWatch Metrics API 連携は後続 issue に分割する。 SSE/WebSocket は使わず
 * `usePolling` の 60 秒 polling に統一する。
 */
const RECENT_FAILURE_FETCH_LIMIT = 20;
const RECENT_FAILURE_DISPLAY_LIMIT = 10;

interface OperationsSnapshot {
  readonly tenants: readonly Tenant[];
  readonly insight: Readonly<Record<string, TenantInsightSummary>> | null;
  readonly recentFailures: readonly RecentFailure[];
  readonly insightUnavailable: boolean;
}

interface RecentFailure {
  readonly rowId: string;
  readonly id: string;
  readonly kind: "provisioning" | "deprovisioning";
  readonly status: string;
  readonly startTimeIso: string | undefined;
  readonly lastUpdateTimeIso: string | undefined;
  readonly consoleUrl: string;
}

const FAILED_PIPELINE_STATUSES = new Set(["Failed"]);
const FAILED_STATE_MACHINE_STATUSES = new Set(["FAILED", "TIMED_OUT", "ABORTED"]);

function failureTimestamp(failure: RecentFailure): number {
  const parsed = Date.parse(failure.lastUpdateTimeIso ?? failure.startTimeIso ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildRecentFailures(
  pipelineItems: readonly PipelineExecutionItem[],
  stateMachineItems: readonly StateMachineExecutionItem[],
): readonly RecentFailure[] {
  const provisioning = pipelineItems
    .filter((item) => FAILED_PIPELINE_STATUSES.has(item.status))
    .map((item) => ({
      rowId: `provisioning:${item.executionId}`,
      id: item.executionId,
      kind: "provisioning" as const,
      status: item.status,
      startTimeIso: item.startTimeIso,
      lastUpdateTimeIso: item.lastUpdateTimeIso,
      consoleUrl: item.consoleUrl,
    }));
  const deprovisioning = stateMachineItems
    .filter((item) => FAILED_STATE_MACHINE_STATUSES.has(item.status))
    .map((item) => ({
      rowId: `deprovisioning:${item.executionArn}`,
      id: item.name,
      kind: "deprovisioning" as const,
      status: item.status,
      startTimeIso: item.startTimeIso,
      lastUpdateTimeIso: item.stopTimeIso,
      consoleUrl: item.consoleUrl,
    }));
  return [...provisioning, ...deprovisioning]
    .sort((a, b) => failureTimestamp(b) - failureTimestamp(a))
    .slice(0, RECENT_FAILURE_DISPLAY_LIMIT);
}

async function fetchOperationsSnapshot(
  config: AppConfig,
  idToken: string,
  api: ApiClient,
): Promise<OperationsSnapshot> {
  const tenants = await listTenants(api);
  if (!config.adminInsightApiUrl) {
    return {
      tenants,
      insight: null,
      recentFailures: [],
      insightUnavailable: true,
    };
  }

  const [summary, pipeline, stateMachine] = await Promise.all([
    fetchTenantsInsightSummary(
      config,
      idToken,
      tenants.map((tenant) => tenant.tenantId),
    ),
    fetchPipelineExecutions(config, idToken, { limit: RECENT_FAILURE_FETCH_LIMIT }),
    fetchStateMachineExecutions(config, idToken, { limit: RECENT_FAILURE_FETCH_LIMIT }),
  ]);

  return {
    tenants,
    insight: summary === null ? null : indexSummaryByTenantId(summary),
    recentFailures: buildRecentFailures(pipeline?.items ?? [], stateMachine?.items ?? []),
    insightUnavailable: summary === null || pipeline === null,
  };
}

function isForbiddenAdminInsightError(err: unknown): boolean {
  return err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN;
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId: string }) {
  return (
    <div data-testid={testId}>
      <Box variant="awsui-key-label">{label}</Box>
      <Box fontSize="display-l" fontWeight="bold">
        {value}
      </Box>
    </div>
  );
}

export function OperationsPage({ config }: { config: AppConfig }) {
  const api = useApiClient(config);
  const auth = useAuth();
  const t = useT();
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const region = config.awsRegion || "ap-northeast-1";
  const dashboardName = config.cloudWatchDashboardName;
  const dashboardUrl = dashboardName
    ? `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${dashboardName}`
    : "";
  const budgetsUrl = "https://console.aws.amazon.com/billing/home#/budgets";
  const costExplorerUrl = "https://console.aws.amazon.com/cost-management/home#/cost-explorer";
  const cloudWatchAlarmsUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:`;

  const idToken = auth.tokens?.idToken;
  const refreshOperations = useCallback(
    async (isActive: () => boolean = () => true) => {
      if (!api || !idToken) return;
      try {
        const nextSnapshot = await fetchOperationsSnapshot(config, idToken, api);
        if (!isActive()) return;
        setSnapshot(nextSnapshot);
        setError(null);
        setForbidden(false);
      } catch (err) {
        if (!isActive()) return;
        if (isForbiddenAdminInsightError(err)) {
          setForbidden(true);
          setError(null);
          setSnapshot((prev) =>
            prev ? { ...prev, insight: null, recentFailures: [], insightUnavailable: false } : null,
          );
          return;
        }
        setError(toErrorMessage(err));
        setForbidden(false);
      }
    },
    [api, config, idToken],
  );

  usePolling(refreshOperations, ADMIN_POLL_INTERVAL_MS, { enabled: Boolean(api && idToken) });

  const totals = useMemo(
    () => computeUsageTotals(snapshot?.tenants ?? [], snapshot?.insight ?? null),
    [snapshot],
  );
  const statValue = (value: number | null): ReactNode => {
    if (snapshot === null) return "—";
    return value ?? "—";
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("operations.description")}>
        {t("operations.title")}
      </Header>

      {forbidden && (
        <Alert type="error" header={t("operations.forbidden_header")}>
          {t("operations.forbidden_body")}
        </Alert>
      )}

      {error && (
        <ErrorState
          title={t("operations.snapshot_error_header")}
          hint={error}
          retry={{ label: t("operations.retry"), onClick: () => void refreshOperations() }}
        />
      )}

      {snapshot?.insightUnavailable && !error && !forbidden && (
        <Alert type="info" header={t("operations.insight_not_available_header")}>
          {t("operations.insight_not_available_body")}
        </Alert>
      )}

      <Container
        header={
          <Header variant="h2" description={t("operations.snapshot_description")}>
            {t("operations.snapshot_header")}
          </Header>
        }
      >
        <ColumnLayout columns={4} variant="text-grid">
          <Stat
            testId="operations-stat-total-tenants"
            label={t("operations.card_total_tenants")}
            value={statValue(totals.totalTenants)}
          />
          <Stat
            testId="operations-stat-active-tenants"
            label={t("operations.card_active_tenants")}
            value={statValue(totals.activeTenants)}
          />
          <Stat
            testId="operations-stat-active-deploys"
            label={t("operations.card_active_deploys")}
            value={statValue(totals.totalActiveDeploys)}
          />
          <Stat
            testId="operations-stat-failed-deploys"
            label={t("operations.card_failed_deploys")}
            value={statValue(totals.totalFailedDeploys)}
          />
        </ColumnLayout>
      </Container>

      <Table<RecentFailure>
        variant="container"
        header={
          <Header variant="h2" counter={`(${snapshot?.recentFailures.length ?? 0})`}>
            {t("operations.recent_failures_header")}
          </Header>
        }
        items={[...(snapshot?.recentFailures ?? [])]}
        trackBy="rowId"
        loading={snapshot === null && !error && !forbidden}
        loadingText={t("operations.snapshot_loading")}
        empty={
          snapshot === null ? (
            <Box textAlign="center" padding="m">
              <Spinner /> {t("operations.snapshot_loading")}
            </Box>
          ) : (
            <Box textAlign="center" color="inherit" padding="xxl">
              {t("operations.recent_failures_empty")}
            </Box>
          )
        }
        columnDefinitions={[
          {
            id: "kind",
            header: t("operations.col_failure_kind"),
            cell: (item) =>
              item.kind === "provisioning"
                ? t("operations.failure_kind_provisioning")
                : t("operations.failure_kind_deprovisioning"),
          },
          {
            id: "id",
            header: t("operations.col_failure_id"),
            cell: (item) => <code>{item.id}</code>,
          },
          {
            id: "status",
            header: t("operations.col_failure_status"),
            cell: (item) => <Badge color="red">{item.status}</Badge>,
          },
          {
            id: "started",
            header: t("operations.col_failure_started"),
            cell: (item) => item.startTimeIso ?? "—",
          },
          {
            id: "updated",
            header: t("operations.col_failure_updated"),
            cell: (item) => item.lastUpdateTimeIso ?? "—",
          },
          {
            id: "console",
            header: t("operations.col_failure_link"),
            cell: (item) => (
              <Link
                external
                href={item.consoleUrl}
                ariaLabel={t("operations.open_failure_console_aria")}
              >
                {t("operations.open_failure_console")}
              </Link>
            ),
          },
        ]}
      />

      {!dashboardName && <Alert type="info">{t("operations.no_dashboard_dev_alert")}</Alert>}

      <Container header={<Header variant="h2">{t("operations.dashboard_header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("operations.dashboard_body")}</Box>
          <KeyValuePairs
            columns={2}
            items={[
              {
                label: t("operations.dashboard_name_label"),
                value: dashboardName ? <code>{dashboardName}</code> : "—",
              },
              { label: t("operations.region_label"), value: region },
            ]}
          />
          <Button
            variant="primary"
            iconName="external"
            disabled={!dashboardUrl}
            href={dashboardUrl}
            target="_blank"
          >
            {t("operations.open_dashboard_button")}
          </Button>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">{t("operations.budget_header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("operations.budget_body")}</Box>
          {/* Issue #1431: 現在のコスト予算消化を in-console で表示 (= AWS Budgets DescribeBudget、無料)。 */}
          <BudgetConsumptionPanel config={config} />
          <SpaceBetween direction="horizontal" size="xs">
            <Button iconName="external" href={budgetsUrl} target="_blank">
              {t("operations.open_budgets_button")}
            </Button>
            <Button iconName="external" href={costExplorerUrl} target="_blank">
              {t("operations.open_cost_explorer_button")}
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">{t("operations.alarms_header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("operations.alarms_body")}</Box>
          <Button iconName="external" href={cloudWatchAlarmsUrl} target="_blank">
            {t("operations.open_alarms_button")}
          </Button>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
