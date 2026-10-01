import type { Hono } from "hono";
import { z } from "zod";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import type { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import { ApiError, type OrganizerAuthConfig, requireOrganizer } from "./auth.js";
import type { RunnerBinding } from "./execution-config.js";
import { body, identifier } from "./schema.js";

export interface CloudConnectionApi {
  readonly bindings: readonly RunnerBinding[];
  readonly verify: (binding: RunnerBinding) => Promise<void>;
}
export function registerCloudConnectionRoutes(
  app: Hono,
  options: CloudConnectionApi & {
    readonly repository: CloudRepository;
    readonly work: DynamoDeploymentWork;
    readonly organizerAuth: OrganizerAuthConfig;
    readonly now: () => number;
  },
): void {
  app.post("/events/:eventId/teams/:teamId/connection", async (context) => {
    const now = options.now();
    requireOrganizer(context, ["Admin"], options.organizerAuth, now);
    const eventId = identifier.parse(context.req.param("eventId"));
    const teamId = identifier.parse(context.req.param("teamId"));
    const input = z
      .object({ bindingId: z.string().min(1).max(64) })
      .strict()
      .parse(await body(context));
    const binding = options.bindings.find((item) => item.id === input.bindingId);
    if (!binding) throw new ApiError(403, "connection_not_allowlisted");
    const [event, team] = await Promise.all([
      options.repository.getEvent(eventId),
      options.repository.getTeam(eventId, teamId),
    ]);
    if (!event || !team) throw new ApiError(404, "not_found");
    if (
      (team.awsAccountId && team.awsAccountId !== binding.accountId) ||
      (team.region && team.region !== binding.region)
    )
      throw new ApiError(409, "connection_target_mismatch");
    if (event.expiresAt <= now / 1000 || team.expiresAt <= now / 1000 || team.accessRevoked)
      throw new ApiError(409, "connection_scope_inactive");
    const previous = await options.work.getConnection(eventId, teamId);
    await options.verify(binding);
    const connection = {
      eventId,
      teamId,
      accountId: binding.accountId,
      region: binding.region,
      roleArn: binding.roleArn,
      externalIdParameter: binding.externalIdParameterArn,
      reviewedProblemIds: binding.reviewedProblemIds,
      bindingId: binding.id,
      version: (previous?.version ?? 0) + 1,
      verifiedAt: new Date(now).toISOString(),
    };
    await options.work.saveVerifiedConnection(connection, previous?.version);
    return context.json({
      kind: "ok",
      eventId,
      teamId,
      accountId: binding.accountId,
      region: binding.region,
      verified: true,
      version: connection.version,
    });
  });
}
