import type { DeploymentRecord } from "../../control-data/deployments-repository.js";
import { generateTeamLoginKey } from "../deploy-handler/team-key.js";
import {
  type EventSharedResources,
  resolveDeploymentsRepository,
  resolveTeamsRepository,
} from "./shared.js";

const NON_RESOLVABLE_STATUSES = new Set<DeploymentRecord["status"]>([
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

export type RotateTeamLoginKeyOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "ok";
      readonly teamId: string;
      readonly teamLoginKey: string;
      readonly rotatedAt: string;
    };

/**
 * Reissues one team's participant bearer and updates every live deployment
 * index through the backend-specific atomic repository operation. Plaintext is
 * returned only from this call; SQL persists only its SHA-256 digest.
 */
export async function rotateTeamLoginKey(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  teamId: string,
  nowMs: number,
  generateLoginKey: () => string = generateTeamLoginKey,
): Promise<RotateTeamLoginKeyOutcome> {
  const teams = await resolveTeamsRepository(shared);
  const team = await teams.getTeam(tenantId, eventId, teamId);
  if (!team) return { kind: "not_found" };

  const deploymentsRepository = await resolveDeploymentsRepository(shared);
  const deployments = (await deploymentsRepository.listByTenantAndEvent(tenantId, eventId))
    .filter(
      (deployment) =>
        deployment.teamId === teamId && !NON_RESOLVABLE_STATUSES.has(deployment.status),
    )
    .map((deployment) => ({ jobId: deployment.jobId, createdAt: deployment.createdAt }));
  const teamLoginKey = generateLoginKey();
  const rotatedAt = new Date(nowMs).toISOString();
  const outcome = await teams.rotateLoginKey({
    tenantId,
    eventId,
    teamId,
    newLoginKey: teamLoginKey,
    updatedAt: rotatedAt,
    deployments,
  });
  if (outcome.outcome !== "updated") {
    return { kind: "conflict" };
  }
  return { kind: "ok", teamId, teamLoginKey, rotatedAt };
}
