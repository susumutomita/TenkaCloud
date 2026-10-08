/** Explicit review boundary shared by executable host catalog and browser build.
 * Adding metadata alone never makes a problem's code executable in the host.
 */
export const LOCAL_COORDINATION_STATE_LIMIT = 2 * 1024 * 1024;
export const reviewedCoordinationBattles = [
  { problemId: "ac26-crypto-battle" },
  { problemId: "forensic-casebook" },
  { problemId: "pi-siege", requiredTeams: 2 },
  { problemId: "session-defense", requiredTeams: 2 },
  { problemId: "tenant-boundary-duel", requiredTeams: 2 },
] as const;
export const reviewedCoordinationPaths = reviewedCoordinationBattles.map(
  ({ problemId }) => `battles/${problemId}`,
);
export function isReviewedCoordination(problemId: unknown): boolean {
  return (
    typeof problemId === "string" &&
    reviewedCoordinationBattles.some((entry) => entry.problemId === problemId)
  );
}
export function requiredCoordinationTeams(problemId: string): number | undefined {
  const entry = reviewedCoordinationBattles.find((item) => item.problemId === problemId);
  return entry && "requiredTeams" in entry ? entry.requiredTeams : undefined;
}
