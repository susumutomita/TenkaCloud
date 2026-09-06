import type { DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "./constants.js";

/** Shared admission rule for participant operations, resets and last-deployment cleanup. */
export function isCoordinationDeploymentPlayable(item: {
  readonly status?: string;
  readonly teardownRequestedAt?: string;
}): boolean {
  // Teardown failures may return to FAILED, so status alone cannot reopen play.
  // Mid-deploy rows still count; their roster membership must not depend on timing.
  if (item.teardownRequestedAt) return false;
  return !DELETED_LIKE_STATUSES.has((item.status ?? "PENDING") as DeploymentStatus);
}
