import { z } from "zod";
import type { Job } from "./model";

const originSchema = z.strictObject({
  kind: z.literal("simulator"),
  version: z.literal(1),
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  jobId: z.string().min(1),
});
export type SimulatorStackOrigin = z.infer<typeof originSchema>;

/** Deployment provenance only, not a provider receipt or scoring qualification. */
export function simulatorStackOrigin(job: Job): SimulatorStackOrigin {
  return originSchema.parse({
    kind: "simulator",
    version: 1,
    eventId: job.eventId,
    teamId: job.teamId,
    jobId: job.jobId,
  });
}

/** Missing legacy metadata stays unknown; it is never inferred from account or URL. */
export function readSimulatorStackOrigin(job: Job): SimulatorStackOrigin | undefined {
  if (!job.unit) return undefined;
  const unit: unknown = JSON.parse(job.unit);
  if (!unit || typeof unit !== "object" || Array.isArray(unit))
    throw new Error("Invalid retained stack unit.");
  if (!("origin" in unit)) return undefined;
  if (!("kind" in unit) || unit.kind !== "cloudformation")
    throw new Error("Simulator origin requires a CloudFormation stack unit.");
  const origin = originSchema.parse(unit.origin);
  if (origin.eventId !== job.eventId || origin.teamId !== job.teamId || origin.jobId !== job.jobId)
    throw new Error("Simulator stack origin belongs to another deployment.");
  return origin;
}

export function assertStackOriginMode(job: Job, simulator: boolean): void {
  if (readSimulatorStackOrigin(job) && !simulator)
    throw new Error("A Simulator stack cannot be operated by the AWS engine.");
}
