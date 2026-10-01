import type { Hono } from "hono";
import { z } from "zod";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import type { InstallationCompetitorConfig } from "../../control-data/domain/competitor-accounts.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import type { DynamoDbCompetitorAccountsRepository } from "../../control-data/dynamodb-competitor-accounts-repository.js";
import type { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import { ApiError, type OrganizerAuthConfig, requireOrganizer } from "./auth.js";
import type { CloudProblem } from "./deployment-routes.js";
import { type RunnerBinding, registeredRunnerBinding } from "./execution-config.js";
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

interface RegisteredConnectionOptions {
  readonly accounts: DynamoDbCompetitorAccountsRepository;
  readonly work: DynamoDeploymentWork;
  readonly config: InstallationCompetitorConfig;
  readonly catalog: () => Promise<Readonly<Record<string, CloudProblem>>>;
  readonly legacyBindings: readonly RunnerBinding[];
}
function bindingMatches(
  connection: Awaited<ReturnType<DynamoDeploymentWork["getConnection"]>>,
  binding: RunnerBinding,
  registrationId?: string,
): boolean {
  return (
    !!connection &&
    connection.registrationId === registrationId &&
    connection.bindingId === binding.id &&
    connection.accountId === binding.accountId &&
    connection.region === binding.region &&
    connection.roleArn === binding.roleArn &&
    connection.externalIdParameter === binding.externalIdParameterArn
  );
}
function selectedTarget(event: EventRecord, team: TeamRecord) {
  const accountIds = new Set(event.problems.map((problem) => problem.defaultAwsAccountId));
  const regions = new Set(event.problems.map((problem) => problem.defaultRegion));
  const accountId =
    team.awsAccountId ?? (accountIds.size === 1 ? accountIds.values().next().value : undefined);
  const region = team.region ?? (regions.size === 1 ? regions.values().next().value : undefined);
  if (!accountId || !region) throw new ApiError(409, "connection_target_mismatch");
  return { accountId, region };
}
function retainedLegacyConnection(
  previous: Awaited<ReturnType<DynamoDeploymentWork["getConnection"]>>,
  bindings: readonly RunnerBinding[],
) {
  if (!previous || previous.registrationId !== undefined) return false;
  if (!bindings.some((binding) => bindingMatches(previous, binding)))
    throw new ApiError(409, "connection_registration_changed");
  return true;
}
async function registerConnection(
  options: RegisteredConnectionOptions,
  event: EventRecord,
  team: TeamRecord,
  now: number,
) {
  const previous = await options.work.getConnection(event.eventId, team.teamId);
  if (retainedLegacyConnection(previous, options.legacyBindings)) return;
  const target = selectedTarget(event, team);
  const catalog = await options.catalog();
  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await options.accounts.getAccount(target.accountId);
    if (!record?.verified || record.region !== target.region)
      throw new ApiError(409, "unverified_competitor_account");
    const binding = registeredRunnerBinding(record, options.config, Object.keys(catalog));
    if (previous) {
      if (bindingMatches(previous, binding, record.registrationId)) return;
      throw new ApiError(409, "connection_registration_changed");
    }
    const connection = {
      eventId: event.eventId,
      teamId: team.teamId,
      accountId: binding.accountId,
      region: binding.region,
      roleArn: binding.roleArn,
      externalIdParameter: binding.externalIdParameterArn,
      reviewedProblemIds: binding.reviewedProblemIds,
      bindingId: binding.id,
      registrationId: record.registrationId,
      version: 1,
      verifiedAt: record.verifiedAt ?? new Date(now).toISOString(),
    };
    if (
      (await options.accounts.saveConnection({ record, event, team, connection, now })) === "saved"
    )
      return;
    // A concurrent request may have created the same connection. Never overwrite it blindly.
    if (
      bindingMatches(
        await options.work.getConnection(event.eventId, team.teamId),
        binding,
        record.registrationId,
      )
    )
      return;
  }
  throw new ApiError(409, "competitor_account_changed");
}
/** Existing EventCreate account selection provisions the server-side connection; no second binding UI is needed. */
export function createRegisteredConnectionPreparer(options: RegisteredConnectionOptions) {
  return (event: EventRecord, team: TeamRecord, now: number) =>
    registerConnection(options, event, team, now);
}
