import Box from "@cloudscape-design/components/box";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import type { DeploymentSummary, StackProgress } from "../../api/deploy-client";
import type { DeployPhase, PhaseStatus } from "../../lib/deploy-phases";
import { StackProgressBody } from "./StackProgressBody";
import type { StackProgressErrorState, TFn } from "./types";

/** Phase status を Cloudscape StatusIndicator にマップ。Netlify と意味的に揃える。 */
const PHASE_STATUS_INDICATOR: Record<PhaseStatus, StatusIndicatorProps.Type> = {
  complete: "success",
  "in-progress": "in-progress",
  failed: "error",
  skipped: "stopped",
  pending: "pending",
};

const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  complete: "Complete",
  "in-progress": "In Progress",
  failed: "Failed",
  skipped: "Skipped",
  pending: "Pending",
};

/**
 * 1 phase 行。ExpandableSection で `>` chevron + 展開を Cloudscape に任せる。
 * Header に phase 名 + StatusIndicator を並べる。Body は phase ごとに切替。
 */
export function PhaseRow(props: {
  readonly phase: DeployPhase;
  readonly deployment: DeploymentSummary;
  readonly stackProgress: StackProgress | null;
  readonly stackProgressError: StackProgressErrorState | null;
  readonly stackProgressPending: boolean;
  readonly t: TFn;
}) {
  const { phase, deployment, stackProgress, stackProgressError, stackProgressPending, t } = props;

  return (
    <ExpandableSection
      variant="default"
      headerText={
        <span className="tc-phase-header" data-testid={`phase-${phase.id}`}>
          <span className="tc-phase-name">{phase.name}</span>
          <span className="tc-phase-status">
            <StatusIndicator type={PHASE_STATUS_INDICATOR[phase.status]}>
              {PHASE_STATUS_LABEL[phase.status]}
            </StatusIndicator>
          </span>
        </span>
      }
    >
      <PhaseBody
        phase={phase}
        deployment={deployment}
        stackProgress={stackProgress}
        stackProgressError={stackProgressError}
        stackProgressPending={stackProgressPending}
        t={t}
      />
    </ExpandableSection>
  );
}

function PhaseBody(props: {
  readonly phase: DeployPhase;
  readonly deployment: DeploymentSummary;
  readonly stackProgress: StackProgress | null;
  readonly stackProgressError: StackProgressErrorState | null;
  readonly stackProgressPending: boolean;
  readonly t: TFn;
}) {
  const { phase, deployment, stackProgress, stackProgressError, stackProgressPending, t } = props;

  switch (phase.id) {
    case "enqueued":
      return (
        <KeyValuePairs
          items={[
            { label: t("deployment_detail.label_enqueued_at"), value: deployment.createdAt },
            {
              label: t("deployment_detail.label_tenant_id"),
              value: <code>{deployment.tenantId}</code>,
            },
            {
              label: t("deployment_detail.label_problem_id"),
              value: <code>{deployment.problemId}</code>,
            },
            {
              label: t("deployment_detail.label_team"),
              value: deployment.displayTeamName ?? deployment.teamName,
            },
          ]}
        />
      );
    case "building":
      return (
        <SpaceBetween size="s">
          <Box variant="p">{t("deployment_detail.phase_building_description")}</Box>
          {stackProgress?.consoleUrl ? (
            <Link href={stackProgress.consoleUrl} external>
              {t("deployment_detail.phase_building_link")}
            </Link>
          ) : (
            <Box variant="small" color="text-status-info">
              {t("deployment_detail.phase_building_url_unavailable")}
            </Box>
          )}
        </SpaceBetween>
      );
    case "cfn-deploy":
      return (
        <StackProgressBody
          progress={stackProgress}
          error={stackProgressError}
          pending={stackProgressPending}
          t={t}
        />
      );
    case "complete":
      return (
        <KeyValuePairs
          items={[
            {
              label: t("deployment_detail.label_final_status"),
              value: <code>{deployment.status}</code>,
            },
            { label: t("deployment_detail.label_last_updated"), value: deployment.updatedAt },
            ...(deployment.failureReason
              ? [
                  {
                    label: t("deployment_detail.label_failure_reason"),
                    value: deployment.failureReason,
                  },
                ]
              : []),
          ]}
        />
      );
  }
}
