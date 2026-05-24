import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTenantAuditClient,
  describeTenantAuditError,
  TenantAuditApiError,
  type TenantAuditClient,
  type TenantAuditItem,
} from "../api/audit-log-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

const PAGE_LIMIT = 50;

type AuditFilters = {
  readonly from: string;
  readonly to: string;
  readonly principal: string;
  readonly action: string;
};

const EMPTY_FILTERS: AuditFilters = { from: "", to: "", principal: "", action: "" };

export function buildListInput(
  filters: AuditFilters,
  cursor: string | undefined,
): Parameters<TenantAuditClient["list"]>[0] {
  return {
    limit: PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
    ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
    ...(filters.to.trim() ? { to: filters.to.trim() } : {}),
    ...(filters.principal.trim() ? { principal: filters.principal.trim() } : {}),
    ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
  };
}

export function mergeItems(
  prev: readonly TenantAuditItem[],
  next: readonly TenantAuditItem[],
  cursor: string | undefined,
): TenantAuditItem[] {
  return cursor ? [...prev, ...next] : [...next];
}

export function describeError(err: unknown): string {
  if (err instanceof TenantAuditApiError) return describeTenantAuditError(err);
  if (err instanceof Error) return err.message;
  return "audit log の取得に失敗しました";
}

/**
 * Issue #1292: Tenant Admin Console 側の audit log view。 自テナントの操作 (= deploy /
 * event 編集 / competitor account 追加 等) を時系列に並べる + CSV export。 cross-tenant
 * 越境は backend で物理的に不能 (= PK 固定)、 UI には scope 切替も tenantId 入力欄もない。
 */
export function AuditLogPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const client: TenantAuditClient | null = useMemo(
    () => (auth.tokens ? createTenantAuditClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
  );
  const [items, setItems] = useState<TenantAuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(
    async (cursor: string | undefined) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const page = await client.list(buildListInput(filters, cursor));
        setItems((prev) => mergeItems(prev, page.items, cursor));
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [client, filters],
  );

  // 初期 load: client が ready になったら 1 回呼ぶ。 filter 変更時は明示 reload ボタン経由
  // (= keypress 毎に reload する UX は DDB RCU 圧迫源になる)。 `load` を deps に含めると
  // filter の typing 中も毎キー reload が走るので、 意図的に `client` のみを依存にする。
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter 編集中の連続 query 抑制 (#1292)
  useEffect(() => {
    void load(undefined);
  }, [client]);

  const onExport = useCallback(async () => {
    if (!client) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await client.exportCsv({
        ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
        ...(filters.to.trim() ? { to: filters.to.trim() } : {}),
        ...(filters.principal.trim() ? { principal: filters.principal.trim() } : {}),
        ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExporting(false);
    }
  }, [client, filters]);

  if (!client) {
    return (
      <Container header={<Header>監査ログ</Header>}>
        <Alert type="warning" header="未配線">
          audit log API は配線されていません。 deploy chain の更新後にアクセスしてください。
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
        description="自テナントの操作監査ログ (= 365 日保持、 admin 操作のみ記録)"
        actions={
          <SpaceBetween size="xs" direction="horizontal">
            <Button
              variant="normal"
              onClick={() => {
                setItems([]);
                setNextCursor(undefined);
                void load(undefined);
              }}
              loading={loading}
              disabled={loading || exporting}
            >
              再読み込み
            </Button>
            <Button
              variant="primary"
              onClick={() => void onExport()}
              loading={exporting}
              disabled={loading || exporting}
            >
              CSV エクスポート
            </Button>
          </SpaceBetween>
        }
      >
        監査ログ
      </Header>

      <Container header={<Header variant="h2">フィルター</Header>}>
        <SpaceBetween size="m" direction="horizontal">
          <Input
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.detail.value }))}
            placeholder="from (ISO8601)"
          />
          <Input
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.detail.value }))}
            placeholder="to (ISO8601)"
          />
          <Input
            value={filters.principal}
            onChange={(e) => setFilters((f) => ({ ...f, principal: e.detail.value }))}
            placeholder="principal (sub / username)"
          />
          <Input
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.detail.value }))}
            placeholder="action"
          />
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
          { id: "occurredAt", header: "発生日時", cell: (i) => i.occurredAt },
          { id: "actor", header: "実行者", cell: (i) => i.actorUsername ?? i.actor },
          { id: "action", header: "操作", cell: (i) => i.action },
          { id: "outcome", header: "結果", cell: (i) => outcomeIndicator(i.outcome) },
          { id: "target", header: "対象", cell: (i) => i.target ?? "-" },
          { id: "ipAddress", header: "IP", cell: (i) => i.ipAddress ?? "-" },
        ]}
        empty={
          <Box textAlign="center" padding="m">
            <SpaceBetween size="s">
              <b>該当する監査ログはありません</b>
              <span>フィルターを変更するか、 再読み込みしてください。</span>
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
