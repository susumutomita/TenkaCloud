import type { DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "./constants.js";

/** Teardown intent is permanent, including when cleanup later reports FAILED. */
export function isFlagSubmissionLive(record: {
  readonly status?: string;
  readonly teardownRequestedAt?: unknown;
}): boolean {
  return (
    record.teardownRequestedAt === undefined &&
    !DELETED_LIKE_STATUSES.has((record.status ?? "PENDING") as DeploymentStatus)
  );
}
