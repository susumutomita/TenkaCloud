import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { ProblemCostEstimateSummary } from "../data/problems";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function ProblemCostSummary({
  estimate,
  showResourceTypes = true,
  t,
}: {
  readonly estimate: ProblemCostEstimateSummary | undefined;
  readonly showResourceTypes?: boolean;
  readonly t: Translate;
}) {
  if (!estimate) {
    return (
      <Box variant="small" color="text-body-secondary">
        {t("problem_cost.unavailable")}
      </Box>
    );
  }

  return (
    <SpaceBetween size="xs">
      <SpaceBetween direction="horizontal" size="xs">
        <Badge color={estimate.alwaysOnResources.length > 0 ? "red" : "green"}>
          {estimate.alwaysOnResources.length > 0
            ? t("problem_cost.always_on_count", {
                count: estimate.alwaysOnResources.length,
              })
            : t("problem_cost.no_always_on")}
        </Badge>
      </SpaceBetween>
      <ProblemAlwaysOnSummary estimate={estimate} t={t} />
      {showResourceTypes && estimate.resourceTypes.length > 0 && (
        <Box variant="small" color="text-body-secondary">
          {t("problem_cost.resources", { resources: estimate.resourceTypes.join(", ") })}
        </Box>
      )}
      {estimate.unclassifiedResourceTypes.length > 0 && (
        <Box variant="small" color="text-status-warning">
          {t("problem_cost.manual_review", {
            resources: estimate.unclassifiedResourceTypes.join(", "),
          })}
        </Box>
      )}
    </SpaceBetween>
  );
}

export function ProblemAlwaysOnSummary({
  estimate,
  t,
}: {
  readonly estimate: ProblemCostEstimateSummary | undefined;
  readonly t: Translate;
}) {
  if (!estimate) {
    return (
      <Box variant="small" color="text-body-secondary">
        {t("problem_cost.unavailable")}
      </Box>
    );
  }
  if (estimate.alwaysOnResources.length === 0) {
    return (
      <Box variant="small" color="text-body-secondary">
        {t("problem_cost.no_always_on")}
      </Box>
    );
  }

  return (
    <Box variant="small">
      {t("problem_cost.always_on_resources", {
        resources: estimate.alwaysOnResources
          .map((resource) => `${resource.logicalId} (${resource.resourceType})`)
          .join(", "),
      })}
    </Box>
  );
}
