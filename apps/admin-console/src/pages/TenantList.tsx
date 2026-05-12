import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
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

function inactiveCell(label = "(deprovisioned)") {
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
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeprovision, setPendingDeprovision] = useState<Tenant | null>(null);
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

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button variant="primary" onClick={() => navigate("/tenants/new")}>
            新規テナント作成
          </Button>
        }
      >
        テナント一覧
      </Header>

      {error && (
        <Alert
          type="error"
          header="取得に失敗しました"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      <Table
        variant="container"
        loading={tenants === null && error === null}
        loadingText="読み込み中..."
        items={tenants ?? []}
        trackBy="tenantId"
        empty={
          <Box textAlign="center" color="inherit">
            テナントがまだ登録されていません。
          </Box>
        }
        columnDefinitions={[
          { id: "tenantId", header: "テナント ID", cell: (t) => t.tenantId },
          {
            id: "tenantName",
            header: "名称",
            // Phase 1.B drill-down (#598): 名称 cell を Link 化し、tenant の Event 一覧へ
            // ナビゲートする。deprovisioned tenant は link を出さず灰色テキスト表示。
            cell: (t) => {
              if (isDeprovisioned(t)) {
                return <Box color="text-status-inactive">{t.tenantName}</Box>;
              }
              const href = `/tenants/${encodeURIComponent(t.tenantId)}/events`;
              return (
                <Link
                  fontSize="body-m"
                  href={href}
                  onFollow={(e) => {
                    e.preventDefault();
                    navigate(href);
                  }}
                >
                  {t.tenantName}
                </Link>
              );
            },
          },
          { id: "email", header: "管理者メール", cell: (t) => t.email },
          {
            id: "tier",
            header: "Tier",
            cell: (t) => <Badge color={tierBadgeColor(t.tier)}>{t.tier}</Badge>,
          },
          {
            id: "status",
            header: "状態",
            cell: (t) => (
              <Badge color={tenantStatusBadgeColor(t.tenantStatus)}>{t.tenantStatus}</Badge>
            ),
          },
          // ADR-011 #590 Phase 1.A: AdminInsight 集計 column。insightByTenantId が null
          // (= API 未配線 / fetch 失敗 / 403) なら cell は "—" を返し、deprovision 済みは
          // 灰色 "(deprovisioned)" にする。背景色 / badge で異常 (failed > 0) を識別可能。
          {
            id: "activeDeploys",
            header: "稼働中 deploy",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              if (insightByTenantId === null) {
                return <Box color="text-status-inactive">—</Box>;
              }
              const summary = insightByTenantId[t.tenantId];
              const count = summary?.activeDeploys ?? 0;
              return <Badge color={count > 0 ? "blue" : "grey"}>{count}</Badge>;
            },
          },
          {
            id: "failedDeploys",
            header: "失敗 deploy",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              if (insightByTenantId === null) {
                return <Box color="text-status-inactive">—</Box>;
              }
              const summary = insightByTenantId[t.tenantId];
              const count = summary?.failedDeploys ?? 0;
              // 0 件は灰色 (= 正常)、>0 は赤 badge (= 運営要対応のシグナル)。
              return <Badge color={count > 0 ? "red" : "grey"}>{count}</Badge>;
            },
          },
          {
            id: "appConsole",
            header: "Application Console",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              const parsed = parseTenantConfig(t.tenantConfig);
              // silo 判定は tier label ではなく URL の実存で行う (旧 premium tier との
              // 後方互換も同時に解決される)。tenantConfig に applicationAdminConsoleUrl
              // が乗っていれば silo deploy 済み。無ければ pooled stack の共有 URL を使う。
              const siloUrl = parsed.applicationAdminConsoleUrl;
              const url = siloUrl || config.pooledApplicationAdminConsoleUrl || undefined;
              if (!url) {
                return inactiveCell("未発行 (deploy 完了後に表示)");
              }
              const isSilo = Boolean(siloUrl);
              return (
                <Button
                  variant="inline-link"
                  href={url}
                  target="_blank"
                  ariaLabel={`${t.tenantName} の Application Admin Console を新規タブで開く`}
                >
                  開く ↗{isSilo ? "" : " (pooled 共有)"}
                </Button>
              );
            },
          },
          {
            id: "logs",
            header: "ログ",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              const parsed = parseTenantConfig(t.tenantConfig);
              const url = buildCodeBuildBuildUrl({
                buildId: parsed.provisioningBuildId,
                projectName: parsed.provisioningProjectName ?? config.provisioningCodeBuildProject,
                region: parsed.provisioningRegion ?? config.awsRegion,
                accountId: parsed.provisioningAccountId ?? config.awsAccountId,
              });
              if (!url) {
                // silo (= tenantConfig に build 情報あり) でないと build deep link 出せない
                const isSilo = Boolean(parsed.applicationAdminConsoleUrl);
                return inactiveCell(isSilo ? "未発行" : "(pooled)");
              }
              return (
                <Button
                  variant="inline-link"
                  href={url}
                  target="_blank"
                  ariaLabel={`${t.tenantName} の provisioning build を AWS Console で開く`}
                >
                  CodeBuild ↗
                </Button>
              );
            },
          },
          {
            id: "actions",
            header: "操作",
            cell: (t) => {
              if (isDeprovisioned(t)) return inactiveCell();
              return (
                <Button variant="inline-link" onClick={() => setPendingDeprovision(t)}>
                  deprovision
                </Button>
              );
            },
          },
        ]}
      />

      <Modal
        visible={pendingDeprovision !== null}
        header={`テナントを deprovision しますか？`}
        onDismiss={() => setPendingDeprovision(null)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setPendingDeprovision(null)}>
                キャンセル
              </Button>
              <Button variant="primary" onClick={confirmDeprovision}>
                実行
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {pendingDeprovision && (
          <Box variant="p">
            {pendingDeprovision.tenantName} ({pendingDeprovision.tenantId}) を deprovision します。
            関連する CloudFormation スタックと DynamoDB レコードが削除されます。
          </Box>
        )}
      </Modal>
    </SpaceBetween>
  );
}
