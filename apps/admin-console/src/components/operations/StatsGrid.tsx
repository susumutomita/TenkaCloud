import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import type { ReactNode } from "react";
import { useT } from "../../i18n";
import type { UsageTotals } from "../../lib/usage";

/**
 * Issue #1770: Operations page の運用サマリ 4 カード。 OperationsPage から切り出し、
 * stat 表示を本 module に閉じ込めた (= ページの高結合を解消)。
 *
 * `loaded === false` (= snapshot 未取得) のときは全カードを em dash で表示する。 取得後は
 * 各値を出すが、 insight 未配線時は deploy 系の値が null なので個別に em dash へ落とす。
 */
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

export function StatsGrid({ totals, loaded }: { totals: UsageTotals; loaded: boolean }) {
  const t = useT();
  const statValue = (value: number | null): ReactNode => {
    if (!loaded) return "—";
    return value ?? "—";
  };

  return (
    <Container
      header={
        <Header variant="h2" description={t("operations.snapshot_description")}>
          {t("operations.snapshot_header")}
        </Header>
      }
    >
      <ColumnLayout columns={4} variant="text-grid">
        <Stat
          testId="operations-stat-total-tenants"
          label={t("operations.card_total_tenants")}
          value={statValue(totals.totalTenants)}
        />
        <Stat
          testId="operations-stat-active-tenants"
          label={t("operations.card_active_tenants")}
          value={statValue(totals.activeTenants)}
        />
        <Stat
          testId="operations-stat-active-deploys"
          label={t("operations.card_active_deploys")}
          value={statValue(totals.totalActiveDeploys)}
        />
        <Stat
          testId="operations-stat-failed-deploys"
          label={t("operations.card_failed_deploys")}
          value={statValue(totals.totalFailedDeploys)}
        />
      </ColumnLayout>
    </Container>
  );
}
