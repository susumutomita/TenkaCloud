import Alert from "@cloudscape-design/components/alert";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { ErrorState } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { AwsConsoleLinks } from "../components/operations/AwsConsoleLinks";
import { RecentFailuresTable } from "../components/operations/RecentFailuresTable";
import { StatsGrid } from "../components/operations/StatsGrid";
import type { AppConfig } from "../config";
import { useOperationsSnapshot } from "../hooks/useOperationsSnapshot";
import { useT } from "../i18n";
import { computeUsageTotals } from "../lib/usage";

// `buildRecentFailures` の所在は useOperationsSnapshot hook へ移動した。 既存 import 経路を
// 壊さないよう再 export で維持する (= pure helper の unit test はこの経路を使う)。
export { buildRecentFailures } from "../hooks/useOperationsSnapshot";

/**
 * Issue #1770: System Admin 向け Operations page。
 *
 * データ取得 + polling + error 分類は `useOperationsSnapshot` hook に、 4 stat カードは
 * `<StatsGrid>`、 失敗テーブルは `<RecentFailuresTable>`、 AWS Console deep link 3 パネルは
 * `<AwsConsoleLinks>` に分割済み。 本 page は状態を組み立てて配置するだけの thin orchestrator。
 *
 * SSE/WebSocket は使わず `usePolling` の 60 秒 polling に統一する (= hook 側で実装)。
 */
export function OperationsPage({ config }: { config: AppConfig }) {
  const t = useT();
  const { snapshot, error, forbidden, refresh } = useOperationsSnapshot(config);

  const totals = useMemo(
    () => computeUsageTotals(snapshot?.tenants ?? [], snapshot?.insight ?? null),
    [snapshot],
  );
  const loaded = snapshot !== null;

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
          retry={{ label: t("operations.retry"), onClick: () => void refresh() }}
        />
      )}

      {snapshot?.insightUnavailable && !error && !forbidden && (
        <Alert type="info" header={t("operations.insight_not_available_header")}>
          {t("operations.insight_not_available_body")}
        </Alert>
      )}

      <StatsGrid totals={totals} loaded={loaded} />

      <RecentFailuresTable
        failures={snapshot?.recentFailures ?? []}
        loaded={loaded}
        error={Boolean(error)}
        forbidden={forbidden}
      />

      <AwsConsoleLinks config={config} />
    </SpaceBetween>
  );
}
