import type {
  ProblemDisruptionEntry,
  ProblemEndpointSlot,
  ProblemPhaseEntry,
  UptimeFlatScoringMetadata,
} from "@tenkacloud/problem-sdk/internal";
import type { ProblemAuthor } from "../../packages/portal-contracts/src/problem-authors";
import type { ContainerVerifyScoring } from "../lib/problem-presentation";
import type { Job } from "./model";

/** A problem deployed as one CloudFormation stack in each team's own AWS account. */
export interface StackDefinitionBase {
  readonly authors?: readonly ProblemAuthor[];
  kind: "cloudformation";
  problemId: string;
  templateBody: string;
  cfnParameters: Record<string, string>;
  name: string;
  instructions: string;
  /** English overlay without the author-only description. */
  english?: { name?: string; instructions?: string };
  disruptions?: ProblemDisruptionEntry[];
  phases?: ProblemPhaseEntry[];
  /** Explicit per-problem projection policy, pinned when the event is created. */
  scoreFloor?: number;
}

export interface FlagStackDefinition extends StackDefinitionBase {
  /** The stack output holding the flag. Participants never see it through the host. */
  flagOutputKey: string;
  scoring: Omit<ContainerVerifyScoring, "kind"> & { kind: "flag" };
}

export interface UptimeStackDefinition extends StackDefinitionBase {
  endpoints: readonly ProblemEndpointSlot[];
  scoring: UptimeFlatScoringMetadata & { kind: "uptime-flat" };
  hostHintOutputKey: "Ec2HostHint";
}

export type StackDefinition = FlagStackDefinition | UptimeStackDefinition;

/** Recorded before CreateStack, so an interrupted create can still be cleaned up. */
export interface StackUnit {
  kind: "cloudformation";
  accountId: string;
  roleArn: string;
  region: string;
  stackName: string;
  stackId?: string;
  outputs?: Record<string, string>;
}

export function unitOf(job: Job): StackUnit {
  if (!job.unit) throw new Error(`Job ${job.jobId} owns no stack.`);
  return JSON.parse(job.unit) as StackUnit;
}
