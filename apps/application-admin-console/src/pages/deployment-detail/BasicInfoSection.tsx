import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import type { DeploymentSummary } from "../../api/deploy-client";
import type { TFn } from "./types";

/** 基本情報 (problem / team / aws account / stack prefix etc) を 2 カラムで表示する。 */
export function BasicInfoSection({
  item,
  t,
}: {
  readonly item: DeploymentSummary;
  readonly t: TFn;
}) {
  return (
    <Container header={<Header variant="h2">{t("deployment_detail.basic_info_header")}</Header>}>
      <ColumnLayout columns={2} variant="text-grid">
        <KeyValuePairs
          items={[
            {
              label: t("deployment_detail.label_problem_id"),
              value: <code>{item.problemId}</code>,
            },
            {
              label: t("deployment_detail.label_display_name"),
              value: item.displayTeamName ?? t("deployment_detail.value_unset"),
            },
            {
              label: t("deployment_detail.label_internal_slug"),
              value: <code>{item.teamName}</code>,
            },
            {
              label: t("deployment_detail.label_aws_account"),
              value: <code>{item.awsAccountId}</code>,
            },
            { label: t("deployment_detail.label_region"), value: item.region },
          ]}
        />
        <KeyValuePairs
          items={[
            {
              label: t("deployment_detail.label_stack_prefix"),
              value: <code>{item.namePrefix}</code>,
            },
            {
              label: t("deployment_detail.label_stack_id"),
              value: item.stackId ? (
                <code>{item.stackId}</code>
              ) : (
                t("deployment_detail.value_unassigned")
              ),
            },
            { label: t("deployment_detail.label_created_at"), value: item.createdAt },
            { label: t("deployment_detail.label_updated_at"), value: item.updatedAt },
          ]}
        />
      </ColumnLayout>
    </Container>
  );
}
