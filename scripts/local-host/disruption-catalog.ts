import {
  buildDisruptionDispatch,
  buildRevertDispatch,
  type ProblemDisruptionEntry,
  parseDisruptionEntry,
  parsePhaseEntry,
} from "@tenkacloud/problem-sdk/internal";
import { z } from "zod";
import { compareCodePoints } from "../lib/code-point-order";
import type { DisruptionTarget } from "./disruption-model";
import { HostError, type Job, type Problem, type Team } from "./model";
import { digest } from "./store";

const definitionSchema = z.object({
  disruptions: z.array(z.unknown()).default([]),
  phases: z.array(z.unknown()).default([]),
});
const unitSchema = z.object({
  kind: z.literal("cloudformation"),
  accountId: z.string().regex(/^\d{12}$/u),
  roleArn: z.string(),
  region: z.string().regex(/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d{1,2}$/u),
  stackId: z.string().min(1),
  outputs: z.record(z.string()),
});

export function declaredDisruptions(problem: Problem) {
  const definition = definitionSchema.parse(JSON.parse(problem.definition));
  const disruptions = definition.disruptions.map((raw) => {
    const entry = parseDisruptionEntry(raw);
    if (!entry)
      throw new HostError(422, "Pinned disruption metadata is invalid.", "invalid_disruption");
    return entry;
  });
  const phases = definition.phases.map((raw) => {
    const phase = parsePhaseEntry(raw);
    if (!phase) throw new HostError(422, "Pinned phase metadata is invalid.", "invalid_disruption");
    return phase;
  });
  return { disruptions, phases };
}

export function unsupportedDisruption(disruption: ProblemDisruptionEntry): string | undefined {
  if (!disruption.action) return "no_action";
  if (disruption.action.kind !== "ssm-run-command") return "unsupported_action";
  if (disruption.effect) return "unsupported_scoring_effect";
  if (disruption.action.revert.afterSeconds > 3600) return "unsupported_revert_interval";
  return undefined;
}

export function disruptionParameters(
  declaration: ProblemDisruptionEntry,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const values = { ...declaration.parameters };
  for (const [key, value] of Object.entries(overrides)) {
    const prior = values[key];
    if (JSON.stringify(prior) === JSON.stringify(value)) continue;
    if (!declaration.operatorEditable?.includes(key))
      throw new HostError(400, `Parameter ${key} is not operator-editable.`, "invalid_parameters");
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (prior !== undefined && typeof prior !== "number")
    )
      throw new HostError(
        400,
        "Host disruption overrides must be nonnegative numeric parameters.",
        "invalid_parameters",
      );
    values[key] = value;
  }
  return values;
}

export function pinDisruption(args: {
  problem: Problem;
  declaration: ProblemDisruptionEntry;
  parameters: Record<string, unknown>;
  job: Job;
  team: Team;
}): DisruptionTarget {
  const { job, team, declaration } = args;
  const unavailable = unsupportedDisruption(declaration);
  if (unavailable || !declaration.action)
    throw new HostError(
      422,
      "This declaration cannot inject a recoverable host disruption.",
      unavailable ?? "no_action",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(job.unit ?? "null");
  } catch {
    throw new HostError(409, "The retained deployment is invalid.", "invalid_target");
  }
  const parsed = unitSchema.safeParse(raw);
  if (
    !parsed.success ||
    job.status !== "COMPLETE" ||
    job.operation ||
    !job.deployedAt ||
    job.definition !== args.problem.definition ||
    job.teamId !== team.teamId ||
    job.eventId !== team.eventId ||
    job.problemId !== args.problem.problemId
  )
    throw new HostError(409, "The team's pinned cloud environment is not ready.", "no_deployment");
  const unit = parsed.data;
  if (
    unit.accountId !== team.aws?.accountId ||
    unit.roleArn !== `arn:aws:iam::${unit.accountId}:role/${team.aws?.roleName}` ||
    !unit.stackId.startsWith(`arn:aws:cloudformation:${unit.region}:${unit.accountId}:stack/`)
  )
    throw new HostError(
      409,
      "The cloud environment does not match the team's account.",
      "invalid_target",
    );
  const inject = buildDisruptionDispatch(declaration.action, args.parameters, unit.outputs);
  const revert = buildRevertDispatch(declaration.action, args.parameters, unit.outputs);
  const ids = inject.target.split(",").map((each) => each.trim());
  if (
    !ids.length ||
    ids.length > 50 ||
    ids.some((each) => !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/u.test(each))
  )
    throw new HostError(
      422,
      "The declared output must name concrete EC2 instance IDs.",
      "invalid_target",
    );
  return {
    jobId: job.jobId,
    eventId: job.eventId,
    teamId: job.teamId,
    stackId: unit.stackId,
    unitHash: digest(job.unit ?? ""),
    deployedAt: job.deployedAt,
    accountId: unit.accountId,
    region: unit.region,
    roleArn: unit.roleArn,
    resources: [...new Set(ids)]
      .sort(compareCodePoints)
      .map((each) => `${unit.accountId}:${unit.region}:${each}`),
    inject,
    revert,
    afterSeconds: declaration.action.revert.afterSeconds,
  };
}
