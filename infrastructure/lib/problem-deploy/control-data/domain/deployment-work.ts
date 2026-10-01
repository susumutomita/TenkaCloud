import { createHash, timingSafeEqual } from "node:crypto";
import type { DeploymentRecord } from "./deployments.js";
import type { EventRecord } from "./events.js";
import type { TeamRecord } from "./teams.js";

/** Explicit verified connection scope; account-sharing policy is not inferred from an account ID. */
export interface DeploymentConnection {
  readonly eventId: string;
  readonly teamId: string;
  readonly accountId: string;
  readonly region: string;
  readonly roleArn: string;
  readonly externalIdParameter: string;
  readonly version: number;
  readonly verifiedAt: string;
  readonly bindingId?: string;
  readonly reviewedProblemIds?: readonly string[];
}
export interface FlagDefinition {
  readonly kind: "flag";
  readonly points: number;
  readonly flagOutputKey: string;
  readonly wrongPenalty: number;
}
export interface DeploymentJob extends DeploymentRecord {
  readonly attempt: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stackName: string;
  readonly problemDir: string;
  readonly artifactDigest: string;
  readonly catalogKey?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly completionDigest?: string;
  readonly connection: DeploymentConnection;
  readonly scoring: FlagDefinition;
  readonly owner?: string;
  readonly stackId?: string;
  readonly flagDigest?: string;
  readonly flagSubmitted?: boolean;
  readonly completedAt?: string;
  readonly failureReason?: string;
  readonly teardownStatus?: "PENDING" | "IN_PROGRESS" | "FAILED" | "DELETED";
  readonly teardownFailureReason?: string;
  readonly publicOutputs?: Readonly<Record<string, string>>;
}
export interface TeamScoreProjection {
  readonly eventId: string;
  readonly teamId: string;
  readonly score: number;
  readonly completedProblems: number;
}
export interface AcceptDeployment {
  readonly event: EventRecord;
  readonly team: TeamRecord;
  readonly job: DeploymentJob;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly retryOf?: number;
  readonly now: number;
}
export interface DeploymentIdentity {
  readonly eventId: string;
  readonly teamId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly operation?: "delete";
  readonly generation?: number;
}
export interface CreationReservation extends DeploymentIdentity {
  readonly state: "NOT_STARTED" | "REQUESTED" | "ACKNOWLEDGED";
  readonly owner?: string;
  readonly leaseUntil: number;
  readonly stackId?: string;
  readonly fingerprint?: string;
}
export interface TeardownRecord extends DeploymentIdentity {
  readonly generation: number;
  readonly status: "PENDING" | "IN_PROGRESS" | "FAILED" | "DELETED";
  readonly owner?: string;
  readonly fingerprint?: string;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly failureReason?: string;
  readonly stackId?: string;
}
export interface DispatchIntent extends DeploymentIdentity {
  readonly createdAt: string;
}
export type FlagOutcome =
  | { readonly kind: "ok" | "wrong"; readonly scoreDelta: number; readonly totalScore: number }
  | { readonly kind: "already_scored"; readonly totalScore: number };
export interface FlagRequest {
  readonly team: TeamRecord;
  readonly event: EventRecord;
  readonly jobId: string;
  readonly attempt: number;
  readonly requestKey: string;
  readonly flag: string;
  readonly now: number;
}
export class DeploymentConflict extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeploymentConflict";
  }
}
export function contentDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Reused from historical generic-scoring-handler/kinds/flag.ts: trimmed, case-sensitive, constant time. */
export function flagDigest(flag: string): string {
  return contentDigest(flag.trim());
}
export function flagMatchesDigest(flag: string, expectedDigest: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error("Invalid expected flag digest.");
  return timingSafeEqual(Buffer.from(flagDigest(flag), "hex"), Buffer.from(expectedDigest, "hex"));
}
/** Slugs alone collided across events in the historical worker. This name binds immutable ownership. */
export function deploymentStackName(eventId: string, teamId: string, problemId: string): string {
  return `tc-cloud-${contentDigest(JSON.stringify([eventId, teamId, problemId])).slice(0, 40)}`;
}

/** Historical participant event gate: absent or invalid start times fail closed. */
export function scoringBlock(
  event: EventRecord,
  now: number,
): "scoring_not_started" | "scoring_ended" | "scoring_locked" | undefined {
  if (["ENDED", "ARCHIVED", "TEARDOWN"].includes(event.status)) return "scoring_ended";
  const start = Date.parse(event.startsAt ?? "");
  if (!Number.isFinite(start) || now < start) return "scoring_not_started";
  if (event.endsAt) {
    const end = Date.parse(event.endsAt);
    if (!Number.isFinite(end) || now >= end) return "scoring_ended";
  }
  return event.scoringLocked ? "scoring_locked" : undefined;
}
