import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useMemo } from "react";
import { Navigate, type NavigateFunction, useNavigate, useParams } from "react-router";
import { useApiClient } from "../api/client";
import { type DeploymentSummary, listDeployments } from "../api/deploy-client";
import {
  deploymentStackNameCell,
  deploymentStatusCell,
  deploymentTeamCell,
} from "../components/deployment-columns";
import type { AppConfig } from "../config";
import { findProblem } from "../data/problems";
import { usePollingList } from "../hooks/usePollingList";
import { useT } from "../i18n";
import {
  DEPLOYMENT_LIST_PAGE_SIZE,
  DEPLOYMENT_LIST_POLL_INTERVAL_MS,
  deploymentsChanged,
  EMPTY_DEPLOYMENT_ITEMS,
} from "../utils/deployments";

type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function ProblemDetailPage({ config }: { config: AppConfig }) {
  const { problemId } = useParams<{ problemId: string }>();
  const navigate = useNavigate();
  const t = useT();

  if (!problemId) return <Navigate to="/problems" replace />;
  const problem = findProblem(problemId);
  if (!problem) {
    return (
      <SpaceBetween size="l">
        <Header variant="h1">{t("problem_detail.not_found_header")}</Header>
        <Alert type="error">{t("problem_detail.not_found_body", { problemId })}</Alert>
        <Button onClick={() => navigate("/problems")}>{t("problem_detail.back_to_list")}</Button>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={problem.shortDescription}
        actions={
          <Button onClick={() => navigate("/problems")}>{t("problem_detail.back_short")}</Button>
        }
      >
        {problem.name}
      </Header>

      <Container header={<Header variant="h2">{t("problem_detail.section_overview")}</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Meta label={t("problem_detail.label_category")}>
            <Badge color={problem.category === "Battle" ? "red" : "blue"}>{problem.category}</Badge>
          </Meta>
          <Meta label={t("problem_detail.label_difficulty")}>
            {t(`problem_detail.difficulty_${problem.difficulty}`)}
          </Meta>
          <Meta label={t("problem_detail.label_estimated_duration")}>
            {problem.estimatedDuration}
          </Meta>
          <Meta label={t("problem_detail.label_status")}>
            <Badge color={problem.status === "ready" ? "green" : "blue"}>{problem.status}</Badge>
          </Meta>
        </ColumnLayout>
      </Container>

      <Container header={<Header variant="h2">{t("problem_detail.section_description")}</Header>}>
        <Box variant="p">
          <span style={{ whiteSpace: "pre-wrap" }}>{problem.description}</span>
        </Box>
      </Container>

      <Container
        header={<Header variant="h2">{t("problem_detail.section_learning_goals")}</Header>}
      >
        <ul>
          {problem.learningGoals.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </Container>

      <Container header={<Header variant="h2">{t("problem_detail.section_endpoints")}</Header>}>
        <SpaceBetween size="s">
          <Box variant="p">{t("problem_detail.endpoints_intro")}</Box>
          <ul>
            {problem.exposedPorts.map((p) => (
              <li key={`${p.name}-${p.port}`}>
                {p.name} (port {p.port})
              </li>
            ))}
          </ul>
          <Alert type="info" header={t("problem_detail.endpoints_access_header")}>
            {t("problem_detail.endpoints_access_body_pre")}{" "}
            <strong>{t("problem_detail.endpoints_access_strong")}</strong>{" "}
            {t("problem_detail.endpoints_access_body_post")}
          </Alert>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">{t("problem_detail.section_tags")}</Header>}>
        <SpaceBetween direction="horizontal" size="xs">
          {problem.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </SpaceBetween>
      </Container>

      <ProblemDeploymentsSection config={config} problemId={problem.id} t={t} />
    </SpaceBetween>
  );
}

function buildColumns(
  navigate: NavigateFunction,
  t: TFn,
): TableProps.ColumnDefinition<DeploymentSummary>[] {
  return [
    {
      id: "team",
      header: t("problem_detail.col_team"),
      cell: deploymentTeamCell(navigate),
    },
    {
      id: "status",
      header: t("problem_detail.col_status_header"),
      cell: deploymentStatusCell,
    },
    {
      id: "namePrefix",
      header: t("problem_detail.col_stack_name"),
      cell: deploymentStackNameCell,
    },
    {
      id: "createdAt",
      header: t("problem_detail.col_created_at"),
      cell: (item) => item.createdAt,
    },
  ];
}

function ProblemDeploymentsSection({
  config,
  problemId,
  t,
}: {
  config: AppConfig;
  problemId: string;
  t: TFn;
}) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();

  const fetcher = useMemo(
    () =>
      apiClient
        ? () =>
            listDeployments(apiClient, problemId, { limit: DEPLOYMENT_LIST_PAGE_SIZE }).then(
              (r) => r.items,
            )
        : null,
    [apiClient, problemId],
  );
  const { items, error } = usePollingList(
    fetcher,
    DEPLOYMENT_LIST_POLL_INTERVAL_MS,
    deploymentsChanged,
  );

  const columns = useMemo(() => buildColumns(navigate, t), [navigate, t]);

  return (
    <Container
      header={
        <Header variant="h2" description={t("problem_detail.deployments_description")}>
          {t("problem_detail.deployments_header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Alert type="error" header={t("problem_detail.deployments_fetch_failed_header")}>
            {error}
          </Alert>
        )}
        <Table
          items={items ?? EMPTY_DEPLOYMENT_ITEMS}
          columnDefinitions={columns}
          loading={items === null && !error}
          loadingText={t("problem_detail.deployments_loading_text")}
          empty={
            <Box textAlign="center" color="inherit" padding="xxl">
              {t("problem_detail.deployments_empty")}
            </Box>
          }
        />
      </SpaceBetween>
    </Container>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
