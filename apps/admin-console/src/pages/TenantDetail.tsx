import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Tabs from "@cloudscape-design/components/tabs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import {
  listTenants,
  parseTenantConfig,
  type Tenant,
  tenantStatusBadgeColor,
  tierBadgeColor,
} from "../api/tenants";
import type { AppConfig } from "../config";
import { TenantEventsPage } from "./TenantEvents";

/**
 * Issue #994: Tenant 詳細 hub page。 旧来は Tenants 一覧から行クリックで TenantEvents page に
 * 直接遷移していて、 tenant の identity / 状態 / Application Console URL / Cognito 等が
 * まとめて見える場所が無かった (= drill-down が 1 軸だけ)。
 *
 * 本 page は header + Tabs (Overview / Events) の hub にして、 Overview tab で tenant の
 * 主要 metadata を一覧、 Events tab で既存の TenantEventsPage を sub-tab 化する。
 *
 * Tabs の URL anchor:
 *   - `#overview` (default)
 *   - `#events`
 *
 * data fetch は listTenants() を 1 回呼んで該当 tenant を抽出する (= TenantList と同じ source)。
 * 別途 admin-insight に GET /tenants/:id を追加する選択肢もあるが、 Phase 1 は既存 RCU を
 * 共有する design (= 余計な endpoint を増やさない)。
 */
const POLL_INTERVAL_MS = 60_000;

const TIER_LABEL: Record<string, string> = {
  BASIC: "BASIC",
  STANDARD: "STANDARD",
  PREMIUM: "PREMIUM",
  PLATINUM: "PLATINUM",
};

export function TenantDetailPage({ config }: { config: AppConfig }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const api = useApiClient(config);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!api || !tenantId) return;
    setLoading(true);
    try {
      const all = await listTenants(api);
      const found = all.find((t) => t.tenantId === tenantId);
      if (!found) {
        setError(`Tenant ${tenantId} が見つかりませんでした。 削除済みの可能性があります。`);
        setTenant(null);
      } else {
        setTenant(found);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api, tenantId]);

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const parsedConfig = useMemo(() => parseTenantConfig(tenant?.tenantConfig), [tenant]);

  // hash で tab を切り替える。 default は overview。
  const initialTab =
    typeof window !== "undefined" && window.location.hash === "#events" ? "events" : "overview";
  const [activeTabId, setActiveTabId] = useState<string>(initialTab);

  if (!tenantId) {
    return <Alert type="error">Tenant ID が URL に指定されていません</Alert>;
  }

  if (loading && !tenant && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> Tenant 情報を取得中…
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Tenant ID: ${tenantId}`}
        actions={
          <Button variant="normal" onClick={() => navigate("/tenants")}>
            一覧へ戻る
          </Button>
        }
      >
        {tenant?.tenantName ?? tenantId}
      </Header>

      {error && (
        <Alert type="error" header="Tenant 取得に失敗" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Tabs
        activeTabId={activeTabId}
        onChange={({ detail }) => {
          setActiveTabId(detail.activeTabId);
          if (typeof window !== "undefined") {
            window.location.hash = detail.activeTabId === "overview" ? "" : detail.activeTabId;
          }
        }}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: tenant ? <OverviewTab tenant={tenant} parsedConfig={parsedConfig} /> : null,
          },
          {
            id: "events",
            label: "Events",
            content: <TenantEventsPage config={config} />,
          },
        ]}
      />
    </SpaceBetween>
  );
}

function OverviewTab({
  tenant,
  parsedConfig,
}: {
  tenant: Tenant;
  parsedConfig: ReturnType<typeof parseTenantConfig>;
}) {
  return (
    <Container header={<Header variant="h2">Tenant 概要</Header>}>
      <KeyValuePairs
        columns={2}
        items={[
          {
            label: "Tenant ID",
            value: (
              <SpaceBetween direction="horizontal" size="xs">
                <code>{tenant.tenantId}</code>
                <CopyToClipboard
                  copyButtonText="Copy"
                  copyErrorText="コピー失敗"
                  copySuccessText="コピーしました"
                  textToCopy={tenant.tenantId}
                  variant="icon"
                />
              </SpaceBetween>
            ),
          },
          {
            label: "Tenant 名",
            value: tenant.tenantName,
          },
          {
            label: "Admin email",
            value: tenant.email,
          },
          {
            label: "Tier",
            value: (
              <Badge color={tierBadgeColor(tenant.tier)}>
                {TIER_LABEL[tenant.tier] ?? tenant.tier}
              </Badge>
            ),
          },
          {
            label: "Status",
            value: (
              <Badge color={tenantStatusBadgeColor(tenant.tenantStatus)}>
                {tenant.tenantStatus}
              </Badge>
            ),
          },
          {
            label: "Active",
            value: tenant.isActive === false ? "no" : "yes",
          },
          {
            label: "作成日時",
            value: tenant.createdAt ?? "-",
          },
          {
            label: "Application Console URL",
            value: parsedConfig.applicationAdminConsoleUrl ? (
              <SpaceBetween direction="horizontal" size="xs">
                <Link
                  external
                  href={parsedConfig.applicationAdminConsoleUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open
                </Link>
                <CopyToClipboard
                  copyButtonText="Copy URL"
                  copyErrorText="コピー失敗"
                  copySuccessText="コピーしました"
                  textToCopy={parsedConfig.applicationAdminConsoleUrl}
                  variant="icon"
                />
              </SpaceBetween>
            ) : (
              <Box variant="small" color="text-status-inactive">
                未配信 (= deploy 完了待ち)
              </Box>
            ),
          },
          {
            label: "Cognito UserPool ID",
            value: parsedConfig.userPoolId ?? (
              <Box variant="small" color="text-status-inactive">
                -
              </Box>
            ),
          },
          {
            label: "Cognito Client ID",
            value: parsedConfig.appClientId ?? (
              <Box variant="small" color="text-status-inactive">
                -
              </Box>
            ),
          },
          {
            label: "API Gateway URL",
            value: parsedConfig.apiGatewayUrl ?? (
              <Box variant="small" color="text-status-inactive">
                -
              </Box>
            ),
          },
        ]}
      />
    </Container>
  );
}
