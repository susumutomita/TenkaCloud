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
import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import {
  isTenantSuspended,
  listTenants,
  parseTenantConfig,
  type Tenant,
  tenantStatusBadgeColor,
  tierBadgeColor,
} from "../api/tenants";
import type { AppConfig } from "../config";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";
import { useT } from "../i18n";

type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Tenant 詳細 page (= Control Plane の SystemAdmin 視点)。
 *
 * 表示するのは **tenant のメタデータだけ** (= tenant ID / 名前 / tier / status / Cognito IDs /
 * Application Console URL)。 tenant の中身 (= competition events / deployments / teams /
 * scoring 等) は **App Plane data なので Control Plane では一切覗かない**。内部運用は
 * tenant admin が application-admin-console
 * (= App Plane UI) で行う。
 *
 * data fetch は listTenants() を 1 回呼んで該当 tenant を抽出する (= TenantList と同じ source)。
 * 別途 admin-insight に GET /tenants/:id を追加する選択肢もあるが、 Phase 1 は既存 RCU を
 * 共有する design (= 余計な endpoint を増やさない)。
 */

// 製品の正準 tier (tenants.ts の Tier 型 = basic/advanced/platinum)。小文字で保存された
// tier も同じ表示に正規化する。未知の値は raw 表示に fallback (下の `?? tenant.tier`)。
const TIER_LABEL: Record<string, string> = {
  BASIC: "BASIC",
  ADVANCED: "ADVANCED",
  PLATINUM: "PLATINUM",
};

export function TenantDetailPage({ config }: { config: AppConfig }) {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const api = useApiClient(config);
  const t = useT();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!api || !tenantId) return;
    setLoading(true);
    try {
      const all = await listTenants(api);
      const found = all.find((tt) => tt.tenantId === tenantId);
      if (!found) {
        setError(t("tenant_detail.not_found", { tenantId }));
        setTenant(null);
      } else {
        setTenant(found);
        setError(null);
      }
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, tenantId, t]);

  // 初回 fetch + 60s polling + unmount cleanup は usePolling (web-kit) に集約 (#1418 DRY)。
  usePolling(refresh, ADMIN_POLL_INTERVAL_MS);

  const parsedConfig = useMemo(() => parseTenantConfig(tenant?.tenantConfig), [tenant]);

  if (!tenantId) {
    return <Alert type="error">{t("tenant_detail.missing_id")}</Alert>;
  }

  if (loading && !tenant && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("tenant_detail.loading")}
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
            {t("tenant_detail.back_to_list")}
          </Button>
        }
      >
        {tenant?.tenantName ?? tenantId}
      </Header>

      {error && (
        <Alert
          type="error"
          header={t("tenant_detail.fetch_failed_header")}
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      {tenant && <OverviewTab tenant={tenant} parsedConfig={parsedConfig} t={t} />}
    </SpaceBetween>
  );
}

function OverviewTab({
  tenant,
  parsedConfig,
  t,
}: {
  tenant: Tenant;
  parsedConfig: ReturnType<typeof parseTenantConfig>;
  t: TFn;
}) {
  return (
    <Container header={<Header variant="h2">{t("tenant_detail.section_overview")}</Header>}>
      <KeyValuePairs
        columns={2}
        items={[
          {
            label: t("tenant_detail.label_tenant_id"),
            value: (
              <SpaceBetween direction="horizontal" size="xs">
                <code>{tenant.tenantId}</code>
                <CopyToClipboard
                  copyButtonText={t("tenant_detail.copy")}
                  copyErrorText={t("tenant_detail.copy_error")}
                  copySuccessText={t("tenant_detail.copy_success")}
                  textToCopy={tenant.tenantId}
                  variant="icon"
                />
              </SpaceBetween>
            ),
          },
          {
            label: t("tenant_detail.label_tenant_name"),
            value: tenant.tenantName,
          },
          {
            label: t("tenant_detail.label_admin_email"),
            value: tenant.email,
          },
          {
            label: t("tenant_detail.label_tier"),
            value: (
              <Badge color={tierBadgeColor(tenant.tier)}>
                {TIER_LABEL[tenant.tier.toUpperCase()] ?? tenant.tier}
              </Badge>
            ),
          },
          {
            label: t("tenant_detail.label_status"),
            value: (
              <Badge color={tenantStatusBadgeColor(tenant.tenantStatus)}>
                {tenant.tenantStatus}
              </Badge>
            ),
          },
          {
            label: t("tenant_detail.label_active"),
            value:
              tenant.isActive === false
                ? t("tenant_detail.active_no")
                : t("tenant_detail.active_yes"),
          },
          {
            label: t("tenant_detail.label_suspended"),
            value: isTenantSuspended(tenant) ? (
              <Badge color="red">{t("tenant_detail.suspended_yes")}</Badge>
            ) : (
              t("tenant_detail.suspended_no")
            ),
          },
          {
            label: t("tenant_detail.label_created_at"),
            value: tenant.createdAt ?? "-",
          },
          {
            label: t("tenant_detail.label_app_console_url"),
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
                  copyButtonText={t("tenant_detail.copy_url")}
                  copyErrorText={t("tenant_detail.copy_error")}
                  copySuccessText={t("tenant_detail.copy_success")}
                  textToCopy={parsedConfig.applicationAdminConsoleUrl}
                  variant="icon"
                />
              </SpaceBetween>
            ) : (
              <Box variant="small" color="text-status-inactive">
                {t("tenant_detail.app_console_url_pending")}
              </Box>
            ),
          },
          {
            label: t("tenant_detail.label_user_pool_id"),
            value: parsedConfig.userPoolId ?? (
              <Box variant="small" color="text-status-inactive">
                -
              </Box>
            ),
          },
          {
            label: t("tenant_detail.label_app_client_id"),
            value: parsedConfig.appClientId ?? (
              <Box variant="small" color="text-status-inactive">
                -
              </Box>
            ),
          },
          {
            label: t("tenant_detail.label_api_gateway_url"),
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
