import { z } from "zod";
import type { Job } from "./model";
import { type BattleDeploymentOwner, battleOwnerKey } from "./simulator-battle-binding";
import { readSimulatorStackOrigin } from "./simulator-stack-origin";
import { digest } from "./store";

const definitionSchema = z.object({
  kind: z.literal("cloudformation"),
  problemId: z.literal("hello-world-battle"),
  scoring: z.object({ kind: z.literal("uptime-flat") }),
});
const unitSchema = z.object({
  kind: z.literal("cloudformation"),
  stackId: z.string().min(1),
  outputs: z.object({ InstanceId: z.string().min(1) }),
});
export interface BattleUptimeTarget {
  readonly kind: "battle-deployment-correlation-only";
  readonly problemId: "hello-world-battle";
  readonly owner: Readonly<BattleDeploymentOwner>;
  readonly ownerKey: string;
  readonly generation: string;
}

/** Correlation only, never proof that an untagged Job owns a Simulator VM.
 * Only trusted orchestration that independently resolves a signed provider
 * receipt may use this value for registration. Participant payloads are not Jobs.
 */
export function battleUptimeTarget(job: Job): BattleUptimeTarget {
  if (
    job.status !== "COMPLETE" ||
    job.operation !== undefined ||
    job.problemId !== "hello-world-battle" ||
    !job.unit ||
    job.deployedAt === undefined
  )
    throw new Error("Battle correlation requires a complete, idle owned job.");
  return retainedBattleTarget(job);
}

/** Cleanup correlation permits failed/deleting retained jobs, never scoring admission. */
export function retainedSimulatorBattleOwner(job: Job): Readonly<BattleDeploymentOwner> {
  if (!readSimulatorStackOrigin(job)) throw new Error("Missing owned Simulator origin.");
  return retainedBattleTarget(job).owner;
}
function retainedBattleTarget(job: Job): BattleUptimeTarget {
  if (job.problemId !== "hello-world-battle" || !job.unit || job.deployedAt === undefined)
    throw new Error("Missing retained Battle deployment.");
  definitionSchema.parse(JSON.parse(job.definition));
  const unit = unitSchema.parse(JSON.parse(job.unit));
  const owner = Object.freeze({
    eventId: job.eventId,
    teamId: job.teamId,
    jobId: job.jobId,
    unitHash: digest(job.unit),
    deployedAt: job.deployedAt,
    stackId: unit.stackId,
    instanceId: unit.outputs.InstanceId,
  });
  const ownerKey = battleOwnerKey(owner);
  return Object.freeze({
    kind: "battle-deployment-correlation-only",
    problemId: "hello-world-battle",
    owner,
    ownerKey,
    generation: `${job.jobId}:${job.deployedAt}:${owner.unitHash}`,
  });
}

/** A deterministic correlation locator, not a network endpoint or credential. */
export function battleRegistrationLocator(target: BattleUptimeTarget, slot: "frontend" | "api") {
  if (slot !== "frontend" && slot !== "api") throw new Error("Invalid Battle registration slot.");
  if (
    target.kind !== "battle-deployment-correlation-only" ||
    battleOwnerKey(target.owner) !== target.ownerKey
  )
    throw new Error("Invalid Battle correlation target.");
  return `simulator://${target.ownerKey}/${slot}`;
}

/** Requires explicit deployment provenance, but still does not confer VM/scoring qualification.
 * Trusted Battle orchestration must additionally authenticate the provider binding.
 */
export function simulatorBattleUptimeTarget(job: Job): BattleUptimeTarget {
  if (!readSimulatorStackOrigin(job))
    throw new Error("Battle runtime requires explicit Simulator deployment origin.");
  return battleUptimeTarget(job);
}
