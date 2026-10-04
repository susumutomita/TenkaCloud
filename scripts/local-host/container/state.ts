import type { ContainerProblem } from "./manifest";
import type { ProblemLifecycle } from "./problem-lifecycle";
import type { VerifyContext, VerifyResult } from "./verify-client";

export const LOCAL_CONTEXT = {
  eventId: "local",
  teamId: "local",
} as const;

export type VerifyFn = (
  verifyUrl: string,
  submission: string,
  context: VerifyContext,
  options?: { readonly checkpointId?: string },
) => Promise<VerifyResult>;

export interface LocalPlayScoreEvent {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "flag" | "flag-wrong" | "hint" | "uptime" | "attack-detected";
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

/**
 * Per-problem runtime state. `solved` / `wrongCounts` keys are the submission
 * target (problemId for `verify`, check id for `multi-verify`); `revealedHints`
 * keys are hint ids (unique within a problem). `score` is this problem's running
 * score including hint / wrong-answer penalties.
 */
export interface ProblemRuntime {
  /**
   * [#2392 Phase 2] The currently-active problem: the catalog original while
   * stopped, the offset-remapped copy while running. The offset moves every
   * loopback URL the problem mentions — `challengeEndpoints`, `verifyUrl`, and
   * the instructions / hints prose that quote them — onto the assigned port
   * block; points and answers never change.
   */
  problem: ContainerProblem;
  readonly solved: Set<string>;
  readonly revealedHints: Map<string, string>;
  readonly wrongCounts: Map<string, number>;
  score: number;
}

export interface LocalPlayRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorization?: string;
}

export interface LocalPlayResponse {
  readonly status: number;
  readonly body: unknown;
  /** Non-JSON response metadata used only for explicit browser handoffs. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const jobIdOf = (problemId: string) => `local-${problemId}`;

/** Session total = sum of every problem's running score. */
export function sessionScore(state: ContainerState): number {
  let total = 0;
  for (const rt of state.runtimes.values()) total += rt.score;
  for (const rt of state.simulatedRuntimes?.values() ?? []) total += rt.score;
  return total;
}

/** Scoring and projection state shared by host matches and individual practice. */
export interface ContainerState {
  readonly runtimes: Map<string, ProblemRuntime>;
  readonly simulatedRuntimes?: ReadonlyMap<string, { readonly score: number }>;
  readonly scoreEvents: LocalPlayScoreEvent[];
  readonly verify: VerifyFn;
  readonly browserText: (text: string) => string;
  readonly lifecycle: Pick<ProblemLifecycle, "statusOf" | "touch" | "cleanupRequired" | "errorOf">;
  teamName: string;
}
export function createProblemRuntimes(
  problems: readonly ContainerProblem[],
): Map<string, ProblemRuntime> {
  return new Map(
    problems.map((problem) => [
      problem.problemId,
      {
        problem,
        solved: new Set<string>(),
        revealedHints: new Map<string, string>(),
        wrongCounts: new Map<string, number>(),
        score: 0,
      },
    ]),
  );
}
