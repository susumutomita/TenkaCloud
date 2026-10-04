import { z } from "zod";
import type { ContainerLimits } from "./container-budget";
import { definitionKind, HostError, type HostedEvent, type Job, type RuntimeEngine } from "./model";
import type { ApiRequest } from "./service";

export const MAX_EVENT_JOBS = 512;
export function onDemandContainer(event: HostedEvent, definition: string): boolean {
  return event.containerMode === "on-demand" && definitionKind(definition) === "compose";
}
export function activeContainer(job: Job): boolean {
  return (
    definitionKind(job.definition) === "compose" &&
    (job.status === "IN_PROGRESS" ||
      job.status === "COMPLETE" ||
      (job.unit !== null && job.status !== "STOPPED" && job.status !== "DELETED"))
  );
}
export function parseContainerRequest(request: ApiRequest): {
  problemId: string;
  action: "start" | "stop";
} {
  const match =
    /^\/portal\/me\/problems\/([a-z0-9][a-z0-9-]{0,127})\/container\/(start|stop)$/u.exec(
      request.path,
    );
  if (!match || request.method !== "POST") throw new HostError(404, "Unknown container operation.");
  if (
    request.query.size ||
    !z
      .object({})
      .strict()
      .safeParse(request.body ?? {}).success
  )
    throw new HostError(400, "Container operations accept no target selectors or options.");
  return { problemId: match[1] ?? "", action: match[2] === "start" ? "start" : "stop" };
}
export function assertContainerBudget(
  jobs: readonly Job[],
  target: Job,
  engine: RuntimeEngine,
  limits: ContainerLimits,
): void {
  const active = jobs.filter((job) => job.jobId !== target.jobId && activeContainer(job));
  if (active.filter((job) => job.teamId === target.teamId).length >= limits.perTeam)
    throw new HostError(
      409,
      `Your team can run ${limits.perTeam} local environments at once. Stop one to preserve its state before starting another.`,
      "team_container_limit",
    );
  if (active.length >= limits.global)
    throw new HostError(
      409,
      "The host's active local environment limit has been reached. Try again after an environment is stopped.",
      "host_container_limit",
    );
  if (active.some((job) => job.runtimePorts === undefined))
    throw new HostError(
      409,
      "An older unbounded local environment is running. Ask the organizer to stop it before using the resource budget.",
      "host_container_limit",
    );
  if (!engine.containerCost)
    throw new HostError(503, "Container resource accounting is unavailable.");
  const memory = [...active, target].reduce(
    (sum, job) =>
      sum + (engine.containerCost?.(job.definition).memoryMiB ?? Number.POSITIVE_INFINITY),
    0,
  );
  if (memory > limits.memoryMiB)
    throw new HostError(
      409,
      `Starting this problem would exceed the host's ${limits.memoryMiB} MiB container memory budget. Stop an environment or ask the organizer to review the budget.`,
      "host_container_memory_limit",
    );
}
export function containerSession(job: Job): {
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  error?: string;
} {
  if (job.operation === "stop") return { status: "stopping" };
  if (job.operation === "restart" || job.status === "IN_PROGRESS") return { status: "starting" };
  if (job.status === "COMPLETE") return { status: "running" };
  if (job.status === "FAILED")
    return {
      status: "error",
      error:
        "The environment operation failed. Its retained data was not reset; retry or ask the organizer to inspect it.",
    };
  return { status: "stopped" };
}
