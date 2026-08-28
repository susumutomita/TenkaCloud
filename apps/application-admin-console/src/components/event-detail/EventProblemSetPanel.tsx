import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Table from "@cloudscape-design/components/table";
import { useNavigate } from "react-router";
import type { EventDetail } from "../../api/events-client";
import { ProblemCostSummary } from "../../components/ProblemCostSummary";
import { findProblem } from "../../data/problems";
import { renderProblemDeployStatus, renderProblemJobLinks } from "./shared";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventProblemSetPanel({
  detail,
  t,
}: {
  readonly detail: EventDetail;
  readonly t: Translate;
}) {
  const navigate = useNavigate();
  return (
    <Container
      header={
        <Header variant="h2" description={t("event_detail.problemset_description")}>
          {t("event_detail.problemset_header", { count: detail.problems.length })}
        </Header>
      }
    >
      <Table
        variant="embedded"
        items={[...detail.problems]}
        columnDefinitions={[
          {
            id: "id",
            header: t("event_detail.problemset_col_id"),
            cell: (p) => <code>{p.problemId}</code>,
          },
          {
            id: "account",
            header: t("event_detail.problemset_col_account"),
            cell: (p) => p.defaultAwsAccountId,
          },
          {
            id: "region",
            header: t("event_detail.problemset_col_region"),
            cell: (p) => p.defaultRegion,
          },
          {
            id: "estimatedCost",
            header: t("event_detail.problemset_col_estimated_cost"),
            cell: (p) => (
              <ProblemCostSummary
                estimate={findProblem(p.problemId)?.costEstimate}
                showResourceTypes={false}
                t={t}
              />
            ),
          },
          {
            id: "status",
            header: t("event_detail.problemset_col_status"),
            cell: (p) => renderProblemDeployStatus(detail.deploymentsByProblem[p.problemId], t),
          },
          {
            id: "jobs",
            header: t("event_detail.problemset_col_jobs"),
            cell: (p) => renderProblemJobLinks(detail.deploymentsByProblem[p.problemId], navigate),
          },
        ]}
        empty={<Box>{t("event_detail.problemset_empty")}</Box>}
      />
    </Container>
  );
}
