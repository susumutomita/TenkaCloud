import type { DeploymentStatus, ScoreEventRecord } from "./deployments.js";

export const COORDINATION_SCORE_REASONS = [
  "prove",
  "cipher",
  "leak",
  "fhe",
  "mpc",
  "duel",
  "duel-hunt",
  "duel-deadline",
  "hunt",
  "hunted",
  "rotate",
  "hint",
  "deadline",
  "coordination",
  "sync",
] as const;
export type CoordinationScoreReason = (typeof COORDINATION_SCORE_REASONS)[number];
export function publicCoordinationScoreReason(value: unknown): CoordinationScoreReason {
  return typeof value === "string" &&
    (COORDINATION_SCORE_REASONS as readonly string[]).includes(value)
    ? (value as CoordinationScoreReason)
    : "coordination";
}

/** One transition's durable delivery, stored in the existing state envelope. */
export interface CoordinationScoreDelivery {
  readonly occurredAt: string;
  /** Initial scores have not yet contributed to a deployment with no saved subtotal. */
  readonly initializing?: true;
  /** Rotate retries past attempted teams, including failures, so a bad prefix cannot starve peers. */
  readonly resumeAfterTeamId?: string;
  readonly teams: Readonly<
    Record<
      string,
      {
        readonly before: number;
        readonly score: number;
        readonly reason: CoordinationScoreReason;
      }
    >
  >;
}

/** The read score is a CAS precondition, never an ADD derived from an unguarded read. */
export interface CoordinationScoreUpdate {
  readonly jobId: string;
  readonly teamId: string;
  readonly expectedScore: number | undefined;
  readonly expectedStatus: DeploymentStatus;
  readonly score: number;
  readonly coordinationSubtotal: number;
  readonly occurredAt: string;
  readonly events: readonly ScoreEventRecord[];
}
