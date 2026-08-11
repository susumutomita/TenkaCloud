import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AuditApiError,
  type AuditClient,
  type AuditItem,
  type AuditScope,
  createAuditClient,
  describeAuditError,
} from "../api/audit-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { AuditLogTable } from "./AuditLogTable";

const AUDIT_PAGE_LIMIT = 50;

type AuditListInput = Parameters<AuditClient["list"]>[0];
type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function validateAuditLoadInput(scope: AuditScope, tenantId: string, t: TFn): string | null {
  if (scope === "tenant" && tenantId.trim().length === 0) {
    return t("audit_log.tenant_id_required");
  }
  return null;
}

export interface AuditFilterState {
  readonly from: string;
  readonly to: string;
  readonly principal: string;
  readonly action: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterState = {
  from: "",
  to: "",
  principal: "",
  action: "",
};

export function buildAuditListInput(
  scope: AuditScope,
  tenantId: string,
  cursor: string | undefined,
  filters: AuditFilterState = EMPTY_AUDIT_FILTERS,
): AuditListInput {
  return {
    scope,
    ...(scope === "tenant" ? { tenantId: tenantId.trim() } : {}),
    limit: AUDIT_PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
    ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
    ...(filters.to.trim() ? { to: filters.to.trim() } : {}),
    ...(filters.principal.trim() ? { principal: filters.principal.trim() } : {}),
    ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
  };
}

export function mergeAuditItems(
  previousItems: readonly AuditItem[],
  pageItems: readonly AuditItem[],
  cursor: string | undefined,
): AuditItem[] {
  return cursor ? [...previousItems, ...pageItems] : [...pageItems];
}

export function describeAuditLoadError(err: unknown, t: TFn): string {
  if (err instanceof AuditApiError) return describeAuditError(err);
  if (err instanceof Error) return err.message;
  return t("audit_log.fetch_failed");
}

export function buildAuditExportInput(
  scope: AuditScope,
  tenantId: string,
  filters: AuditFilterState,
): Parameters<AuditClient["exportCsv"]>[0] {
  return {
    scope,
    ...(scope === "tenant" ? { tenantId: tenantId.trim() } : {}),
    ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
    ...(filters.to.trim() ? { to: filters.to.trim() } : {}),
    ...(filters.principal.trim() ? { principal: filters.principal.trim() } : {}),
    ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
  };
}

function triggerCsvDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Issue #950: SystemAdmin Console 側の admin 操作監査ログ view。
 *
 * 表示: scope (= tenant or system) + tenantId を入力 → 1 ページ 50 件、 cursor で次ページ。
 * outcome は success / forbidden / not_found / conflict / error で badge 色分け。
 *
 * 未配線時 (= `adminInsightApiUrl` 空 / table 配線無し): alert で誘導。
 */
export function AuditLogPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const client: AuditClient | null = useMemo(
    () => (auth.tokens ? createAuditClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
  );
  const [scope, setScope] = useState<AuditScope>("system");
  const [tenantId, setTenantId] = useState("");
  const [items, setItems] = useState<AuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterPrincipal, setFilterPrincipal] = useState("");
  const [filterAction, setFilterAction] = useState("");

  const filters: AuditFilterState = useMemo(
    () => ({
      from: filterFrom,
      to: filterTo,
      principal: filterPrincipal,
      action: filterAction,
    }),
    [filterFrom, filterTo, filterPrincipal, filterAction],
  );

  const load = useCallback(
    async (cursor: string | undefined) => {
      if (!client) return;
      const validationError = validateAuditLoadInput(scope, tenantId, t);
      if (validationError) {
        setError(validationError);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const page = await client.list(buildAuditListInput(scope, tenantId, cursor, filters));
        setItems((prev) => mergeAuditItems(prev, page.items, cursor));
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(describeAuditLoadError(err, t));
      } finally {
        setLoading(false);
      }
    },
    [client, scope, tenantId, t, filters],
  );

  const onExport = useCallback(async () => {
    // export button は client 存在時のみ render されるので true 分岐は不到達 (= 防御的)。
    /* v8 ignore next */
    if (!client) return;
    const validationError = validateAuditLoadInput(scope, tenantId, t);
    if (validationError) {
      setError(validationError);
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const blob = await client.exportCsv(buildAuditExportInput(scope, tenantId, filters));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      triggerCsvDownload(blob, `audit-${scope}-${stamp}.csv`);
    } catch (err) {
      setError(describeAuditLoadError(err, t));
    } finally {
      setExporting(false);
    }
  }, [client, scope, tenantId, t, filters]);

  useEffect(() => {
    // 初期 mount で system scope を 1 回 load。 client が ready になった時点で発火。
    void load(undefined);
  }, [load]);

  if (!client) {
    return (
      <Container header={<Header>{t("audit_log.page_title")}</Header>}>
        <Alert type="warning" header={t("audit_log.not_wired_header")}>
          {t("audit_log.not_wired_body")}
        </Alert>
      </Container>
    );
  }

  const scopeOptions = [
    { value: "system", label: t("audit_log.scope_system") },
    { value: "tenant", label: t("audit_log.scope_tenant_action") },
  ];

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween size="xs" direction="horizontal">
            <Button
              variant="normal"
              onClick={() => {
                setNextCursor(undefined);
                void load(undefined);
              }}
              loading={loading}
              disabled={loading || exporting}
            >
              {t("audit_log.load_button")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void onExport()}
              loading={exporting}
              disabled={loading || exporting}
            >
              {t("audit_log.export_csv")}
            </Button>
          </SpaceBetween>
        }
      >
        {t("audit_log.page_title")}
      </Header>

      <Container>
        <SpaceBetween size="m" direction="horizontal">
          <Select
            selectedOption={{
              value: scope,
              label:
                scope === "system"
                  ? t("audit_log.scope_system")
                  : t("audit_log.scope_tenant_action"),
            }}
            options={scopeOptions}
            onChange={(e) => setScope(e.detail.selectedOption.value as AuditScope)}
          />
          {scope === "tenant" && (
            <Input
              value={tenantId}
              onChange={(e) => setTenantId(e.detail.value)}
              placeholder={t("audit_log.tenant_id_placeholder")}
            />
          )}
          <Input
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.detail.value)}
            placeholder={t("audit_log.filter_from")}
          />
          <Input
            value={filterTo}
            onChange={(e) => setFilterTo(e.detail.value)}
            placeholder={t("audit_log.filter_to")}
          />
          <Input
            value={filterPrincipal}
            onChange={(e) => setFilterPrincipal(e.detail.value)}
            placeholder={t("audit_log.filter_principal")}
          />
          <Input
            value={filterAction}
            onChange={(e) => setFilterAction(e.detail.value)}
            placeholder={t("audit_log.filter_action")}
          />
        </SpaceBetween>
      </Container>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <AuditLogTable items={items} loading={loading} />

      {nextCursor && (
        <Button
          variant="normal"
          onClick={() => void load(nextCursor)}
          loading={loading}
          disabled={loading}
        >
          {t("audit_log.load_more")}
        </Button>
      )}
    </SpaceBetween>
  );
}
