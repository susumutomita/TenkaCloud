import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { BudgetConsumptionPanel } from "../components/BudgetConsumptionPanel";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

/**
 * Issue #1080: 主催者向け運用ダッシュボードのランディングページ。
 * CloudWatch Dashboard / AWS Budgets / Cost Explorer など、 deploy 後の運用観測点へ
 * AWS Console deep link で誘導する。 SPA 側は URL builder に専念し、 token / IAM を
 * 経由しない (= AWS Console の federated login に委譲)。
 */
export function OperationsPage({ config }: { config: AppConfig }) {
  const t = useT();
  const region = config.awsRegion || "ap-northeast-1";
  const dashboardName = config.cloudWatchDashboardName;
  const dashboardUrl = dashboardName
    ? `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${dashboardName}`
    : "";
  const budgetsUrl = "https://console.aws.amazon.com/billing/home#/budgets";
  const costExplorerUrl = "https://console.aws.amazon.com/cost-management/home#/cost-explorer";
  const cloudWatchAlarmsUrl = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:`;

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("operations.description")}>
        {t("operations.title")}
      </Header>

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
    </SpaceBetween>
  );
}
