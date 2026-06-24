import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { BudgetConsumptionPanel } from "../BudgetConsumptionPanel";

const DEFAULT_REGION = "ap-northeast-1";

/**
 * Issue #1080 / #1431: AWS Console への deep link 3 パネル (CloudWatch Dashboard / Budgets +
 * Cost Explorer / CloudWatch Alarms)。 OperationsPage から切り出し、 deep link の URL 組み立てと
 * no-dashboard alert を本 module に閉じ込めた。
 *
 * CloudWatch Metrics API 連携は後続 issue。 ここは既存の外部リンク誘導 + コスト消化パネルに留める。
 */
export function AwsConsoleLinks({ config }: { config: AppConfig }) {
  const t = useT();
  const region = config.awsRegion || DEFAULT_REGION;
  const dashboardName = config.cloudWatchDashboardName;
  const dashboardUrl = dashboardName
    ? `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${dashboardName}`
    : "";
  const budgetsUrl = "https://console.aws.amazon.com/billing/home#/budgets";
  const costExplorerUrl = "https://console.aws.amazon.com/cost-management/home#/cost-explorer";
  const cloudWatchAlarmsUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:`;

  return (
    <>
      {!dashboardName && <Alert type="info">{t("operations.no_dashboard_dev_alert")}</Alert>}

      <Container header={<Header variant="h2">{t("operations.dashboard_header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("operations.dashboard_body")}</Box>
          <KeyValuePairs
            columns={2}
            items={[
              {
                label: t("operations.dashboard_name_label"),
                value: dashboardName ? <code>{dashboardName}</code> : "—",
              },
              { label: t("operations.region_label"), value: region },
            ]}
          />
          <Button
            variant="primary"
            iconName="external"
            disabled={!dashboardUrl}
            href={dashboardUrl}
            target="_blank"
          >
            {t("operations.open_dashboard_button")}
          </Button>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">{t("operations.budget_header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("operations.budget_body")}</Box>
          {/* Issue #1431: 現在のコスト予算消化を in-console で表示 (= AWS Budgets DescribeBudget、無料)。 */}
          <BudgetConsumptionPanel config={config} />
          <SpaceBetween direction="horizontal" size="xs">
            <Button iconName="external" href={budgetsUrl} target="_blank">
              {t("operations.open_budgets_button")}
            </Button>
            <Button iconName="external" href={costExplorerUrl} target="_blank">
              {t("operations.open_cost_explorer_button")}
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">{t("operations.alarms_header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("operations.alarms_body")}</Box>
          <Button iconName="external" href={cloudWatchAlarmsUrl} target="_blank">
            {t("operations.open_alarms_button")}
          </Button>
        </SpaceBetween>
      </Container>
    </>
  );
}
