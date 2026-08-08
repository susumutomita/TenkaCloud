import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { ErrorState, toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useApiClient } from "../api/client";
import {
  fetchTenantsInsightSummary,
  indexSummaryByTenantId,
  type TenantInsightSummary,
} from "../api/insight";
import { listTenants, type Tenant, tenantStatusBadgeColor, tierBadgeColor } from "../api/tenants";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";
import { interpolate, useT } from "../i18n";
import {
  buildUsageRows,
  computeTierDistribution,
  computeUsageTotals,
  sortUsageRows,
  type UsageRow,
  type UsageSortField,
} from "../lib/usage";

/**
 * Issue #1767: テナント利用量ダッシュボード。既存 API のみで構成する (frontend 完結):
 *   - Control Plane API `GET /tenants` (= tenant 一覧、 tier / status)
 *   - AdminInsight API `GET /admin/insight/tenants/summary` (= per-tenant active/failed deploys)
 *
 * 受け入れ条件の loud-fail: どちらの API の失敗も ErrorState で明示する。 TenantList は
 * 一覧本体を守るため insight 失敗を黙って column hide するが、 本 page は集計が主役なので
 * 失敗を隠さない。 AdminInsight が「未配線 / SystemAdmin でない」 (= fetch が null を返す)
 * ケースだけは error ではなく info Alert で明示する (= サイレントな空表示にしない)。
 */

/** 集計カード 1 枚。 testId は page test の anchor (数値は page 内で重複しうるため)。 */
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

export function UsagePage({ config }: { config: AppConfig }) {
  const api = useApiClient(config);
  const auth = useAuth();
  const t = useT();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  // insight 3 状態: null = 未取得 (loading / unavailable / error)、 map = 取得済み。
  const [insight, setInsight] = useState<Record<string, TenantInsightSummary> | null>(null);
  const [insightUnavailable, setInsightUnavailable] = useState(false);
  const [insightError, setInsightError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ field: UsageSortField; descending: boolean }>({
    field: "activeDeploys",
    descending: true,
  });

  const refreshTenants = useCallback(async () => {
    if (!api) return;
    try {
      setTenantsError(null);
      setTenants(await listTenants(api));
    } catch (err) {
      setTenantsError(toErrorMessage(err));
    }
  }, [api]);

  useEffect(() => {
    void refreshTenants();
  }, [refreshTenants]);

  const pollInsight = useCallback(async () => {
    const idToken = auth.tokens?.idToken;
    if (!idToken || !tenants) return;
    if (!config.adminInsightApiUrl) {
      // phase 2 初回 deploy 前 / dev 未配線。 fetch 自体を skip して「未配線」を明示する。
      setInsightUnavailable(true);
      return;
    }
    try {
      const summary = await fetchTenantsInsightSummary(
        config,
        idToken,
        tenants.map((tenant) => tenant.tenantId),
      );
      if (summary === null) {
        // 未配線 (adminInsightApiUrl 空) / 403 (SystemAdmin claim 無し)。 deploy 集計は出せない
        // が、 黙って空にせず info Alert で明示する。
        setInsight(null);
        setInsightUnavailable(true);
        return;
      }
      setInsight(indexSummaryByTenantId(summary));
      setInsightUnavailable(false);
      setInsightError(null);
    } catch (err) {
      // loud-fail (#1767 受け入れ条件): 集計 fetch の失敗を ErrorState で表示する。
      setInsight(null);
      setInsightError(toErrorMessage(err));
    }
  }, [auth.tokens?.idToken, tenants, config]);

  // 初回 fetch + 60s polling + unmount cleanup は usePolling (web-kit) に集約 (#1418 DRY)。
  usePolling(pollInsight, ADMIN_POLL_INTERVAL_MS);

  const totals = useMemo(() => computeUsageTotals(tenants ?? [], insight), [tenants, insight]);
  const tierCounts = useMemo(() => computeTierDistribution(tenants ?? []), [tenants]);
  const rows = useMemo(
    () => sortUsageRows(buildUsageRows(tenants ?? [], insight), sort.field, sort.descending),
    [tenants, insight, sort],
  );

  const deployCell = (value: number | null) =>
    value === null ? <Box color="text-status-inactive">—</Box> : value;

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("usage.description")}>
        {t("usage.title")}
      </Header>

      {tenantsError && (
        <ErrorState
          title={t("usage.tenants_error_header")}
          hint={tenantsError}
          retry={{ label: t("usage.retry"), onClick: () => void refreshTenants() }}
        />
      )}

      {insightError && (
        <ErrorState
          title={t("usage.insight_error_header")}
          hint={insightError}
          retry={{ label: t("usage.retry"), onClick: () => void pollInsight() }}
        />
      )}

      {insightUnavailable && !insightError && (
        <Alert type="info" header={t("usage.insight_not_available_header")}>
          {t("usage.insight_not_available_body")}
        </Alert>
      )}

      <Container header={<Header variant="h2">{t("usage.summary_header")}</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Stat
            testId="usage-stat-total-tenants"
            label={t("usage.card_total_tenants")}
            value={totals.totalTenants}
          />
          <Stat
            testId="usage-stat-active-tenants"
            label={t("usage.card_active_tenants")}
            value={totals.activeTenants}
          />
          <Stat
            testId="usage-stat-active-deploys"
            label={t("usage.card_active_deploys")}
            value={totals.totalActiveDeploys ?? "—"}
          />
          <Stat
            testId="usage-stat-failed-deploys"
            label={t("usage.card_failed_deploys")}
            value={totals.totalFailedDeploys ?? "—"}
          />
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">{t("usage.tier_header")}</Header>}>
        {tierCounts.length === 0 ? (
          <Box color="text-status-inactive">{t("usage.tier_empty")}</Box>
        ) : (
          <ColumnLayout columns={Math.min(tierCounts.length, 4)} variant="text-grid">
            {tierCounts.map(({ tier, count, percentage }) => (
              <div key={tier} data-testid={`usage-tier-${tier}`}>
                <Badge color={tierBadgeColor(tier)}>{tier}</Badge>
                <Box fontSize="display-l" fontWeight="bold">
                  {count}
                </Box>
                <Box variant="small">
                  {interpolate(t("usage.tier_share"), { percentage: String(percentage) })}
                </Box>
              </div>
            ))}
          </ColumnLayout>
        )}
      </Container>

      <Table<UsageRow>
        variant="container"
        header={
          <Header variant="h2" counter={`(${rows.length})`}>
            {t("usage.table_header")}
          </Header>
        }
        loading={tenants === null && tenantsError === null}
        loadingText={t("usage.loading")}
        items={[...rows]}
        trackBy="tenantId"
        sortingColumn={{ sortingField: sort.field }}
        sortingDescending={sort.descending}
        onSortingChange={({ detail }) =>
          setSort({
            // sortingField 付き列しか sortable にしていないので ?? の右辺は型ガード (不到達)。
            /* v8 ignore next */
            field: (detail.sortingColumn.sortingField ?? "tenantName") as UsageSortField,
            /* v8 ignore next */
            descending: detail.isDescending ?? false,
          })
        }
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {t("usage.table_empty")}
          </Box>
        }
        columnDefinitions={[
          {
            id: "tenantName",
            header: t("usage.col_tenant_name"),
            cell: (row) => row.tenantName,
            sortingField: "tenantName",
          },
          {
            id: "tier",
            header: t("usage.col_tier"),
            cell: (row) => <Badge color={tierBadgeColor(row.tier)}>{row.tier}</Badge>,
            sortingField: "tier",
          },
          {
            id: "tenantStatus",
            header: t("usage.col_status"),
            cell: (row) => (
              <Badge color={tenantStatusBadgeColor(row.tenantStatus)}>{row.tenantStatus}</Badge>
            ),
            sortingField: "tenantStatus",
          },
          {
            id: "activeDeploys",
            header: t("usage.col_active_deploys"),
            cell: (row) => deployCell(row.activeDeploys),
            sortingField: "activeDeploys",
          },
          // 実行中 / 失敗の 2 列だけだと、 成功して稼働中の tenant も何もしていない tenant も
          // 0 / 0 になり operator が区別できない (2026-08-08 SaaS モード動作確認で誤認された)。
          // App Plane の deployment 明細を持ち込むのは plane 境界違反なので、 集計値の列を足す
          // (docs/architecture/principles.md)。
          {
            id: "completedDeploys",
            header: t("usage.col_completed_deploys"),
            cell: (row) => deployCell(row.completedDeploys),
            sortingField: "completedDeploys",
          },
          {
            id: "failedDeploys",
            header: t("usage.col_failed_deploys"),
            cell: (row) => deployCell(row.failedDeploys),
            sortingField: "failedDeploys",
          },
          {
            // [Issue #2946] 現在値の 2 列は撤去すると揃って 0 になる。この列だけが撤去後も
            // 残るので、「成功する deploy を回しているテナント」と「一度も deploy していない
            // テナント」を区別できる。`null` は不明であって 0 件成功ではない (deployCell が
            // "—" を出す)。
            id: "everCompletedDeploys",
            header: t("usage.col_ever_completed_deploys"),
            cell: (row) => deployCell(row.everCompletedDeploys),
            sortingField: "everCompletedDeploys",
          },
        ]}
      />
    </SpaceBetween>
  );
}
