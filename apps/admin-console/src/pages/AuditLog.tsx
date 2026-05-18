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
        setError("tenantId を入力してください (scope=tenant の場合)");
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
          setError("読み込みに失敗しました");
        }
      } finally {
        setLoading(false);
      }
    },
    [client, scope, tenantId],
  );

  useEffect(() => {
    // 初期 mount で system scope を 1 回 load。 client が ready になった時点で発火。
    void load(undefined);
  }, [load]);

  if (!client) {
    return (
      <Container header={<Header>Admin Audit Log</Header>}>
        <Alert type="warning" header="AdminInsight stack が未配線">
          \`config.adminInsightApiUrl\` が空のため audit log は読み込めません。 Phase 2 deploy
          を完了して runtime-config.json に <code>adminInsightApiUrl</code> を注入してください。
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
            読み込み
          </Button>
        }
      >
        Admin Audit Log
      </Header>

      <Container>
        <SpaceBetween size="m" direction="horizontal">
          <Select
            selectedOption={{
              value: scope,
              label: scope === "system" ? "SystemAdmin 操作" : "Tenant 操作",
            }}
            options={[
              { value: "system", label: "SystemAdmin 操作" },
              { value: "tenant", label: "Tenant 操作" },
            ]}
            onChange={(e) => setScope(e.detail.selectedOption.value as AuditScope)}
          />
          {scope === "tenant" && (
            <Input
              value={tenantId}
              onChange={(e) => setTenantId(e.detail.value)}
              placeholder="tenantId (例: t-01HX...)"
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
        loadingText="読み込み中…"
        items={items}
        columnDefinitions={[
          {
            id: "occurredAt",
            header: "発生時刻",
            cell: (i) => i.occurredAt,
          },
          {
            id: "actor",
            header: "操作者",
            cell: (i) => i.actorUsername ?? i.actor,
          },
          {
            id: "action",
            header: "操作",
            cell: (i) => i.action,
          },
          {
            id: "outcome",
            header: "結果",
            cell: (i) => outcomeIndicator(i.outcome),
          },
          {
            id: "target",
            header: "対象",
            cell: (i) => i.target ?? "-",
          },
          {
            id: "tenantId",
            header: "Tenant",
            cell: (i) => i.tenantId,
          },
          {
            id: "ipAddress",
            header: "IP",
            cell: (i) => i.ipAddress ?? "-",
          },
        ]}
        empty={
          <Box textAlign="center" padding="m">
            <SpaceBetween size="s">
              <b>監査ログがありません</b>
              <span>scope / tenantId を確認してください。</span>
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
          続きを読み込む
        </Button>
      )}
    </SpaceBetween>
  );
}
