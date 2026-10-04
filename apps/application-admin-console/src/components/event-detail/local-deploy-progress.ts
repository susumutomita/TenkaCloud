import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import type { EventDetail } from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/** A local STOPPED environment is prepared for on-demand use, not a running container. */
export function localDeployProgress(detail: EventDetail, ended: boolean, t: Translate) {
  // Count the expected team/problem pairs, so missing environments cannot imply readiness.
  const environments = detail.problems.flatMap((problem) =>
    detail.teams.map((team) =>
      detail.deploymentsByProblem[problem.problemId]?.find((job) => job.teamId === team.teamId),
    ),
  );
  const settled = environments.filter((job) => job && !job.operation);
  const running = settled.filter((job) => job?.status === "COMPLETE").length;
  const stopped = settled.filter((job) => job?.status === "STOPPED").length;
  const prepared = running + stopped;
  const total = environments.length;
  const failed = settled.filter((job) => job && ["FAILED", "EXPIRED"].includes(job.status)).length;
  const inFlight = environments.filter(
    (job) => job && (job.operation || ["PENDING", "IN_PROGRESS", "DELETING"].includes(job.status)),
  ).length;
  const state = preparationState({ detail, ended, prepared, total, failed, inFlight });
  return {
    type: state.type,
    label: t(`local_host.progress_${state.label}`, { failed, inFlight }),
    description: t(`local_host.progress_${state.description}`),
    summary: t("local_host.progress_counts", { prepared, total, running, stopped }),
    inFlight: inFlight > 0,
  };
}

function preparationState({
  detail,
  ended,
  prepared,
  total,
  failed,
  inFlight,
}: {
  readonly detail: EventDetail;
  readonly ended: boolean;
  readonly prepared: number;
  readonly total: number;
  readonly failed: number;
  readonly inFlight: number;
}): { type: StatusIndicatorProps.Type; label: string; description: string } {
  if (ended) return { type: "stopped", label: "ended", description: "ended_hint" };
  if (failed > 0) return { type: "error", label: "failed", description: "check_hint" };
  if (inFlight > 0 || detail.status === "DEPLOYING") {
    return { type: "in-progress", label: "preparing", description: "preparing_hint" };
  }
  if (detail.status === "READY" && total > 0 && prepared === total) {
    return {
      type: "success",
      label: "ready",
      description: detail.startsAt ? "scheduled_hint" : "ready_hint",
    };
  }
  return {
    type: "pending",
    label: "incomplete",
    description: detail.status === "DRAFT" ? "prepare_hint" : "check_hint",
  };
}
