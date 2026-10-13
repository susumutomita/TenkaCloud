/** Application command boundary; each adapter owns its atomic mutation and existing response. */
export interface ScoringLockCommandPort<Request, Response> {
  readonly setLock: (request: Request) => Promise<Response>;
}

/** Classify inside the adapter's existing consistency boundary, never as a write precondition. */
export function scoringLockDecision(
  status: string,
  currentLock: boolean | undefined,
  targetLock: boolean,
): "not_lockable" | "already" | "change" {
  if (status !== "READY" && status !== "ENDED") return "not_lockable";
  return currentLock === targetLock ? "already" : "change";
}
