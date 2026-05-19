import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
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

/**
 * Issue #950 (ADR-020 Phase D): SystemAdmin Console 側の admin 操作監査ログ view。
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

  const load = useCallback(
    async (cursor: string | undefined) => {
      if (!client) return;
      if (scope === "tenant" && tenantId.trim().length === 0) {
        setError(t("audit_log.tenant_id_required"));
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const page = await client.list({
          scope,
          ...(scope === "tenant" ? { tenantId: tenantId.trim() } : {}),
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        if (cursor) {
          // 続きを append
          setItems((prev) => [...prev, ...page.items]);
        } else {
          setItems([...page.items]);
        }
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (err instanceof AuditApiError) {
          setError(describeAuditError(err));
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(t("audit_log.fetch_failed"));
        }
      } finally {
        setLoading(false);
      }
    },
    [client, scope, tenantId, t],
  );

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

  function outcomeIndicator(outcome: string) {
    if (outcome === "success") return <StatusIndicator type="success">success</StatusIndicator>;
    if (outcome === "forbidden") return <StatusIndicator type="error">forbidden</StatusIndicator>;
    if (outcome === "not_found") return <StatusIndicator type="warning">not_found</StatusIndicator>;
    if (outcome === "conflict") return <StatusIndicator type="warning">conflict</StatusIndicator>;
    if (outcome === "error") return <StatusIndicator type="error">error</StatusIndicator>;
    return <span>{outcome}</span>;
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
          <Button
            variant="primary"
            onClick={() => {
              setNextCursor(undefined);
              void load(undefined);
            }}
            loading={loading}
            disabled={loading}
          >
            {t("audit_log.load_button")}
          </Button>
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
        </SpaceBetween>
      </Container>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table
        loading={loading}
        loadingText={t("audit_log.loading_text")}
        items={items}
        columnDefinitions={[
          {
            id: "occurredAt",
            header: t("audit_log.col_occurred_at"),
            cell: (i) => i.occurredAt,
          },
          {
            id: "actor",
            header: t("audit_log.col_actor"),
            cell: (i) => i.actorUsername ?? i.actor,
          },
          {
            id: "action",
            header: t("audit_log.col_action"),
            cell: (i) => i.action,
          },
          {
            id: "outcome",
            header: t("audit_log.col_result"),
            cell: (i) => outcomeIndicator(i.outcome),
          },
          {
            id: "target",
            header: t("audit_log.col_target"),
            cell: (i) => i.target ?? "-",
          },
          {
            id: "tenantId",
            header: t("audit_log.col_tenant"),
            cell: (i) => i.tenantId,
          },
          {
            id: "ipAddress",
            header: t("audit_log.col_ip"),
            cell: (i) => i.ipAddress ?? "-",
          },
        ]}
        empty={
          <Box textAlign="center" padding="m">
            <SpaceBetween size="s">
              <b>{t("audit_log.empty_header")}</b>
              <span>{t("audit_log.empty_hint_filter")}</span>
            </SpaceBetween>
          </Box>
        }
      />

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
