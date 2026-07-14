import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { StatusCodes } from "http-status-codes";
import { useEffect, useMemo, useState } from "react";
import { ApiError, useApiClient } from "../api/client";
import {
  type EducationGraphResponse,
  type EducationMaterialsResponse,
  getEducationGraph,
  getEducationMaterials,
} from "../api/education-graph-client";
import { EducationDependencyGraph } from "../components/EducationDependencyGraph";
import { EducationMaterials } from "../components/EducationMaterials";
import type { AppConfig } from "../config";
import { useI18n } from "../i18n";

export function EducationGraphPage({ config }: { readonly config: AppConfig }) {
  const apiClient = useApiClient(config);
  const { locale, t } = useI18n();
  const [graph, setGraph] = useState<EducationGraphResponse | null>(null);
  const [graphError, setGraphError] = useState<"forbidden" | "generic" | null>(null);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [materials, setMaterials] = useState<EducationMaterialsResponse | null>(null);
  const [materialsError, setMaterialsError] = useState(false);

  useEffect(() => {
    if (!apiClient) return;
    let cancelled = false;
    setGraph(null);
    setGraphError(null);
    setMaterials(null);
    void getEducationGraph(apiClient, locale)
      .then((response) => {
        if (cancelled) return;
        setGraph(response);
        setSelectedProblemId((current) =>
          current && response.problems.some((problem) => problem.id === current)
            ? current
            : (response.problems[0]?.id ?? null),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGraphError(
            error instanceof ApiError && error.status === StatusCodes.FORBIDDEN
              ? "forbidden"
              : "generic",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, locale]);

  useEffect(() => {
    if (!apiClient || !selectedProblemId) return;
    let cancelled = false;
    setMaterials(null);
    setMaterialsError(false);
    void getEducationMaterials(apiClient, selectedProblemId, locale)
      .then((response) => {
        if (!cancelled) setMaterials(response);
      })
      .catch(() => {
        if (!cancelled) setMaterialsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, locale, selectedProblemId]);

  const problemOptions: readonly SelectProps.Option[] = useMemo(
    () => graph?.problems.map((problem) => ({ value: problem.id, label: problem.name })) ?? [],
    [graph],
  );
  const selectedOption =
    problemOptions.find((option) => option.value === selectedProblemId) ?? null;

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("education_graph.description")}>
        {t("education_graph.header")}
      </Header>

      {!graph && graphError === null && (
        <StatusIndicator type="loading">{t("education_graph.loading_graph")}</StatusIndicator>
      )}
      {graphError === "generic" && (
        <Alert type="error">{t("education_graph.graph_load_error")}</Alert>
      )}
      {graphError === "forbidden" && (
        <Alert type="error">{t("education_graph.admin_only_error")}</Alert>
      )}
      {graph && graph.nodes.length === 0 && (
        <Alert type="info">{t("education_graph.graph_empty")}</Alert>
      )}

      {graph && graph.nodes.length > 0 && (
        <Container
          header={
            <Header variant="h2" description={t("education_graph.graph_description")}>
              {t("education_graph.graph_heading")}
            </Header>
          }
        >
          <SpaceBetween size="l">
            <EducationDependencyGraph graph={graph} t={t} />
            {problemOptions.length > 0 && (
              <Select
                ariaLabel={t("education_graph.problem_select_label")}
                options={problemOptions}
                placeholder={t("education_graph.problem_select_placeholder")}
                selectedOption={selectedOption}
                onChange={({ detail }) =>
                  setSelectedProblemId(detail.selectedOption.value as string)
                }
              />
            )}
          </SpaceBetween>
        </Container>
      )}

      {selectedProblemId && (
        <Container
          header={
            <Header variant="h2" description={t("education_graph.materials_description")}>
              {t("education_graph.materials_heading")}
            </Header>
          }
        >
          {!materials && !materialsError && (
            <StatusIndicator type="loading">
              {t("education_graph.loading_materials")}
            </StatusIndicator>
          )}
          {materialsError && (
            <Alert type="error">{t("education_graph.materials_load_error")}</Alert>
          )}
          {materials && <EducationMaterials response={materials} t={t} />}
        </Container>
      )}

      {graph && graph.nodes.length > 0 && graph.problems.length === 0 && (
        <Box color="text-body-secondary">{t("education_graph.no_problem_projections")}</Box>
      )}
    </SpaceBetween>
  );
}
