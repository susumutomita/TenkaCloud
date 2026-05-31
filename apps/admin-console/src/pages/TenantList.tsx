import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import Popover from "@cloudscape-design/components/popover";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import Toggle from "@cloudscape-design/components/toggle";
import { EmptyState, ErrorState } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import {
  fetchTenantsInsightSummary,
  indexSummaryByTenantId,
  type TenantInsightSummary,
} from "../api/insight";
import {
  buildCodeBuildBuildUrl,
  deleteTenant,
  listTenants,
  parseTenantConfig,
  type Tenant,
  tenantStatusBadgeColor,
  tierBadgeColor,
} from "../api/tenants";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { interpolate, useT } from "../i18n";
import { computeTenantProgress, isInProgress } from "../lib/tenant-progress";

/**
 * ADR-011 #590 Phase 1.A: 60s polling 周期。SSE / WebSocket は禁止 (Lambda 運用と整合せず)。
 * 5 tenants × ~50 deployments を 60s ごとに refresh して RCU 消費は 1 tenant あたり ~1 query。
 * Phase 3 dashboard で tenant 数が伸びるなら pre-aggregation table に置き換え。
 */
const INSIGHT_POLLING_INTERVAL_MS = 60 * 1000;

/**
 * deprovision 済みの tenant かどうかを判定する。
 *   - tenantStatus が "Deleted" / "DELETED" / "Deprovisioned" のいずれか
 *   - または isActive === false (SBT v0.3.9 の DELETE /tenants は isActive = false にする)
 *
 * 該当する行は Application Console / ログ / 操作 カラムをすべて灰色 "(deprovisioned)"
 * 表示にし、active なリンクは出さない。
 */
function isDeprovisioned(t: Tenant): boolean {
  const status = (t.tenantStatus ?? "").toLowerCase();
  if (status === "deleted" || status === "deprovisioned") return true;
  if (t.isActive === false) return true;
  return false;
}

function inactiveCell(label: string) {
  return (
    <Box color="text-status-inactive" variant="small">
      {label}
    </Box>
  );
}

export function TenantListPage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();
  const api = useApiClient(config);
  const auth = useAuth();
  const t = useT();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeprovision, setPendingDeprovision] = useState<Tenant | null>(null);
  // 2026-05-18 user feedback: 削除済 (= Deleted / Deprovisioned / isActive=false) tenant が
  // 一覧に蓄積し続けて操作対象を見つけにくくなる。 default は非表示、 toggle で表示切替。
  const [showDeprovisioned, setShowDeprovisioned] = useState(false);
  // #657: "In progress" の経過時間表示用 wall clock。 60 秒ごとに更新し severity 再評価。
  const [nowMs, setNowMs] = useState(() => Date.now());
  // ADR-011 #590 Phase 1.A: tenantId → 集計 の lookup。
  // - null = まだ fetch していない / AdminInsight API が未配線 (= column hide)
  // - {} = fetch 済みで対象 tenant が無い (= 集計 0 表示)
  const [insightByTenantId, setInsightByTenantId] = useState<Record<
    string,
    TenantInsightSummary
  > | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setError(null);
      setTenants(await listTenants(api));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // tenants が解決済みなら AdminInsight API を叩いて集計を join する。
  // tokens が無い / config.adminInsightApiUrl 未設定なら fetch を skip して null のまま
  // にしておく (= column 自体を表示しない、UI に「未配線」状態を持ち込まない安全装置)。
  useEffect(() => {
    const idToken = auth.tokens?.idToken;
    if (!idToken || !tenants || !config.adminInsightApiUrl) return;
    const tenantIds = tenants.map((t) => t.tenantId);

    let cancelled = false;
    const fetchInsight = async () => {
      try {
        const summary = await fetchTenantsInsightSummary(config, idToken, tenantIds);
        if (cancelled) return;
        // null = 403 forbidden 等 (= SystemAdmin claim 無し)。column hide のため state も null。
        setInsightByTenantId(summary ? indexSummaryByTenantId(summary) : null);
      } catch {
        // tenant 一覧の primary 表示は壊さない。集計列だけ未取得扱いにする (= null)。
        if (!cancelled) setInsightByTenantId(null);
      }
    };
    void fetchInsight();
    const handle = window.setInterval(() => {
      void fetchInsight();
    }, INSIGHT_POLLING_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [auth.tokens?.idToken, tenants, config]);

  // #657: 経過時間の severity を 60 秒周期で再評価。 setInterval は cleanup 必須。
  useEffect(() => {
    const handle = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  const confirmDeprovision = async () => {
    if (!api || !pendingDeprovision) return;
    try {
      await deleteTenant(api, pendingDeprovision.tenantId);
      setPendingDeprovision(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deprovisionedLabel = t("tenant_list.deprovisioned");

  // 削除済 tenant の filter。 default は隠す、 toggle が ON なら全件表示。
  const deprovisionedCount = useMemo(
    () => (tenants ?? []).filter(isDeprovisioned).length,
    [tenants],
  );
  const visibleTenants = useMemo(() => {
    const all = tenants ?? [];
    return showDeprovisioned ? all : all.filter((row) => !isDeprovisioned(row));
  }, [tenants, showDeprovisioned]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button variant="primary" onClick={() => navigate("/tenants/new")}>
            {t("tenant_list.create_button")}
          </Button>
        }
      >
        {t("tenant_list.header")}
      </Header>

      {error && (
        // Issue #1366: 共有 ErrorState wrapper。 Alert 直接配置から DESIGN-SYSTEM 9 章準拠に統一。
        // refresh で再取得できるので retry を提供 (= buyer 視点で「打ち手が無い」 を消す)。
        <ErrorState
          title={t("tenant_list.fetch_error_header")}
          hint={error}
          retry={{ label: t("tenant_list.retry"), onClick: () => void refresh() }}
          onDismiss={() => setError(null)}
        />
      )}

      {deprovisionedCount > 0 && (
        <Toggle
          checked={showDeprovisioned}
          onChange={({ detail }) => setShowDeprovisioned(detail.checked)}
        >
          {interpolate(t("tenant_list.show_deprovisioned_toggle"), {
            count: String(deprovisionedCount),
          })}
        </Toggle>
      )}

      <Table
        variant="container"
        loading={tenants === null && error === null}
        loadingText={t("tenant_list.loading")}
        items={visibleTenants}
        trackBy="tenantId"
        empty={
          // Issue #1366: 空 Box を DESIGN-SYSTEM 8 章 (EmptyState) に置換。 headline + body +
          // primary action (= 「テナント作成」) で次の操作を明示する。
          <EmptyState
            headline={t("tenant_list.empty")}
            body={t("tenant_list.empty_body")}
            primaryAction={{
              label: t("tenant_list.create_button"),
              onClick: () => navigate("/tenants/new"),
            }}
          />
        }
        columnDefinitions={[
          { id: "tenantId", header: t("tenant_list.col_tenant_id"), cell: (row) => row.tenantId },
          {
            id: "tenantName",
            header: t("tenant_list.col_tenant_name"),
            cell: (row) => {
              if (isDeprovisioned(row)) {
                return <Box color="text-status-inactive">{row.tenantName}</Box>;
              }
              // 行クリックは Tenant detail (= Control Plane metadata) に遷移する。
              // tenant 内部の events / deployments への drill-down は plane 分離方針で除去
              // ([[feedback-no-cross-plane-data-leak]])、 tenant admin が application-admin-console
              // で見る。
              const href = `/tenants/${encodeURIComponent(row.tenantId)}`;
              return (
                <Link
                  fontSize="body-m"
                  href={href}
                  onFollow={(e) => {
                    e.preventDefault();
                    navigate(href);
                  }}
                >
                  {row.tenantName}
                </Link>
              );
            },
          },
          { id: "email", header: t("tenant_list.col_email"), cell: (row) => row.email },
          {
            id: "tier",
            header: t("tenant_list.col_tier"),
            cell: (row) => <Badge color={tierBadgeColor(row.tier)}>{row.tier}</Badge>,
          },
          {
            id: "status",
            header: t("tenant_list.col_status"),
            cell: (row) => {
              const badge = (
                <Badge color={tenantStatusBadgeColor(row.tenantStatus)}>{row.tenantStatus}</Badge>
              );
              if (!isInProgress(row.tenantStatus)) return badge;
              const progress = computeTenantProgress({ createdAt: row.createdAt, nowMs });
              // createdAt 未取得 (= SBT が field を返さない、 fresh tenant の race) のとき
              // \`progress.label === \"—\"\` が出る。 細い em dash が badge 下に \"_\" のように
              // 見えて誤解を生むので、 そのときは badge のみ表示する。
              if (progress.label === "—") return badge;
              const progressColor =
                progress.severity === "danger"
                  ? "text-status-error"
                  : progress.severity === "warning"
                    ? "text-status-warning"
                    : "text-status-info";
              const suffix =
                progress.severity === "danger"
                  ? ` · ${t("tenant_list.progress_danger_suffix")}`
                  : progress.severity === "warning"
                    ? ` · ${t("tenant_list.progress_warning_suffix")}`
                    : "";
              return (
                <SpaceBetween direction="vertical" size="xxs">
                  {badge}
                  <Box variant="small" color={progressColor}>
                    {progress.label}
                    {suffix}
                  </Box>
                </SpaceBetween>
              );
            },
          },
          // Issue #898: 旧 2 column (activeDeploys / failedDeploys) を 1 column に統合。
          // 旧実装は header が長すぎて画面に収まらず、 \"問題 deploy\" が何を指すか
          // operator から見て不明瞭だった。 短い header + Popover による説明 + 単一 cell
          // (active blue badge と failed red badge を inline 並置) で意味を圧縮する。
          // insightByTenantId が null (= API 未配線 / fetch 失敗 / 403) なら "—" を返し、
          // deprovision 済みは灰色 "(deprovisioned)" にする (旧挙動を維持)。
          {
            id: "problemDeploys",
            header: (
              <Popover
                triggerType="text"
                header={t("tenant_list.col_problem_deploys")}
                content={t("tenant_list.col_problem_deploys_explain")}
                size="medium"
              >
                {t("tenant_list.col_problem_deploys_short")}
              </Popover>
            ),
            cell: (row) => {
              if (isDeprovisioned(row)) return inactiveCell(deprovisionedLabel);
              if (insightByTenantId === null) {
                return <Box color="text-status-inactive">—</Box>;
              }
              const summary = insightByTenantId[row.tenantId];
              const active = summary?.activeDeploys ?? 0;
              const failed = summary?.failedDeploys ?? 0;
              if (active === 0 && failed === 0) {
                return <Badge color="grey">0</Badge>;
              }
              return (
                <SpaceBetween direction="horizontal" size="xs">
                  {active > 0 && (
                    <Badge color="blue">
                      {interpolate(t("tenant_list.deploys_active"), { count: String(active) })}
                    </Badge>
                  )}
                  {failed > 0 && (
                    <Badge color="red">
                      {interpolate(t("tenant_list.deploys_failed"), { count: String(failed) })}
                    </Badge>
                  )}
                </SpaceBetween>
              );
            },
          },
          {
            id: "appConsole",
            header: t("tenant_list.col_app_console"),
            cell: (row) => {
              if (isDeprovisioned(row)) return inactiveCell(deprovisionedLabel);
              const parsed = parseTenantConfig(row.tenantConfig);
              const siloUrl = parsed.applicationAdminConsoleUrl;
              const url = siloUrl || config.pooledApplicationAdminConsoleUrl || undefined;
              if (!url) {
                return inactiveCell(t("tenant_list.not_issued_yet"));
              }
              const isSilo = Boolean(siloUrl);
              return (
                <Button
                  variant="inline-link"
                  href={url}
                  target="_blank"
                  ariaLabel={interpolate(t("tenant_list.open_console_aria"), {
                    tenantName: row.tenantName,
                  })}
                >
                  {isSilo ? t("tenant_list.open_console") : t("tenant_list.open_console_pooled")}
                </Button>
              );
            },
          },
          {
            id: "logs",
            header: t("tenant_list.col_logs"),
            cell: (row) => {
              if (isDeprovisioned(row)) return inactiveCell(deprovisionedLabel);
              const parsed = parseTenantConfig(row.tenantConfig);
              const url = buildCodeBuildBuildUrl({
                buildId: parsed.provisioningBuildId,
                projectName: parsed.provisioningProjectName ?? config.provisioningCodeBuildProject,
                region: parsed.provisioningRegion ?? config.awsRegion,
                accountId: parsed.provisioningAccountId ?? config.awsAccountId,
              });
              if (!url) {
                const isSilo = Boolean(parsed.applicationAdminConsoleUrl);
                return inactiveCell(
                  isSilo ? t("tenant_list.logs_not_issued") : t("tenant_list.logs_pooled"),
                );
              }
              return (
                <Button
                  variant="inline-link"
                  href={url}
                  target="_blank"
                  ariaLabel={interpolate(t("tenant_list.logs_codebuild_aria"), {
                    tenantName: row.tenantName,
                  })}
                >
                  {t("tenant_list.logs_codebuild")}
                </Button>
              );
            },
          },
          {
            id: "actions",
            header: t("tenant_list.col_actions"),
            cell: (row) => {
              if (isDeprovisioned(row)) return inactiveCell(deprovisionedLabel);
              return (
                <Button variant="inline-link" onClick={() => setPendingDeprovision(row)}>
                  {t("tenant_list.deprovision_action")}
                </Button>
              );
            },
          },
        ]}
      />

      <Modal
        visible={pendingDeprovision !== null}
        header={t("tenant_list.deprovision_modal_header")}
        onDismiss={() => setPendingDeprovision(null)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setPendingDeprovision(null)}>
                {t("tenant_list.deprovision_modal_cancel")}
              </Button>
              <Button variant="primary" onClick={confirmDeprovision}>
                {t("tenant_list.deprovision_modal_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {pendingDeprovision && (
          <Box variant="p">
            {interpolate(t("tenant_list.deprovision_modal_body"), {
              tenantName: pendingDeprovision.tenantName,
              tenantId: pendingDeprovision.tenantId,
            })}
          </Box>
        )}
      </Modal>
    </SpaceBetween>
  );
}
