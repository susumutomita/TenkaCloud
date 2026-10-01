import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import {
  contentDigest,
  type DeploymentJob,
  deploymentStackName,
  type FlagDefinition,
} from "../../control-data/domain/deployment-work.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import type { DynamoDeploymentWork } from "../../control-data/dynamodb-deployment-work.js";
import { ApiError, type OrganizerAuthConfig, participantKey, requireOrganizer } from "./auth.js";
import { body, identifier } from "./schema.js";

export interface CloudProblem {
  readonly problemId: string;
  readonly problemDir: string;
  readonly artifactDigest: string;
  readonly catalogKey: string;
  readonly scoring: FlagDefinition;
  readonly parameters: Readonly<Record<string, string>>;
}
export interface CloudDeploymentApi {
  readonly work: DynamoDeploymentWork;
  readonly catalog: () => Promise<Readonly<Record<string, CloudProblem>>>;
  readonly controlPlaneAccount: string;
  readonly prepareConnection?: (event: EventRecord, team: TeamRecord, now: number) => Promise<void>;
}
interface RouteOptions extends CloudDeploymentApi {
  readonly repository: CloudRepository;
  readonly organizerAuth: OrganizerAuthConfig;
  readonly now: () => number;
}
const selection = z
  .object({
    teamIds: z.array(identifier).min(1).max(49).optional(),
    problemIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
    retryFailedOnly: z.boolean().optional(),
  })
  .strict();
const planned = z.object({
  createdAt: z.string(),
  catalogKey: z.string(),
  targets: z.array(
    z.object({
      jobId: identifier,
      teamId: identifier,
      problemId: z.string(),
      attempt: z.number().int().positive(),
      retryOf: z.number().int().positive().optional(),
    }),
  ),
  skipped: z.number().int().nonnegative(),
});
function requestKey(context: Context): string {
  // Legacy clients omit the header; target uniqueness and one-time flag awards still hold.
  const key = z
    .string()
    .min(1)
    .max(255)
    .parse(context.req.header("Idempotency-Key") ?? ulid());
  context.header("Idempotency-Key", key);
  return key;
}
async function currentEvent(options: RouteOptions, id: string): Promise<EventRecord> {
  const event = await options.repository.getEvent(identifier.parse(id));
  if (!event) throw new ApiError(404, "not_found");
  return event;
}
function validateSelection(
  input: z.infer<typeof selection>,
  selectedTeams: readonly TeamRecord[],
  ids: readonly string[],
  event: EventRecord,
): void {
  if (
    new Set(ids).size !== ids.length ||
    (input.teamIds &&
      (new Set(input.teamIds).size !== input.teamIds.length ||
        selectedTeams.length !== input.teamIds.length)) ||
    ids.some((id) => !event.problems.some((problem) => problem.problemId === id))
  )
    throw new ApiError(400, "invalid_deployment_selection");
}
async function boundedMap<T>(
  items: readonly T[],
  action: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await action(item);
      }
    }),
  );
}
async function deploy(context: Context, options: RouteOptions) {
  const now = options.now();
  const actor = requireOrganizer(context, ["Admin", "Operator"], options.organizerAuth, now);
  if (!(await options.work.acceptingNewDeployments()))
    throw new ApiError(409, "installation_draining");
  const event = await currentEvent(options, context.req.param("eventId") ?? "");
  if (!["DRAFT", "DEPLOYING", "READY"].includes(event.status))
    throw new ApiError(409, "event_closed");
  const text = await context.req.text();
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new ApiError(400, "request_too_large");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "invalid_request");
  }
  const input = selection.parse(json);
  const teams = await options.repository.listTeamsByEvent(event.eventId);
  const selectedTeams = input.teamIds
    ? teams.filter((team) => input.teamIds?.includes(team.teamId))
    : teams;
  const ids = input.problemIds ?? event.problems.map((problem) => problem.problemId);
  validateSelection(input, selectedTeams, ids, event);
  const catalog = await options.catalog();
  if (ids.some((id) => !Object.hasOwn(catalog, id)))
    throw new ApiError(409, "unsupported_runtime_problem");
  const key = requestKey(context);
  const hash = contentDigest(
    JSON.stringify([
      actor.sub,
      [...selectedTeams.map((team) => team.teamId)].sort(),
      [...ids].sort(),
      input.retryFailedOnly ?? false,
    ]),
  );
  const proposal = await planTargets(
    options,
    event,
    selectedTeams,
    ids,
    catalog,
    input.retryFailedOnly ?? false,
    now,
  );
  const plan = planned.parse(await options.work.pinRequest(event.eventId, key, hash, proposal));
  if (plan.catalogKey !== proposal.catalogKey) throw new ApiError(409, "catalog_revision_changed");
  await boundedMap(plan.targets, async (target) => {
    const team = selectedTeams.find((item) => item.teamId === target.teamId);
    const problem = catalog[target.problemId];
    if (!team || !problem) throw new ApiError(409, "deployment_plan_changed");
    const connection = await options.work.getConnection(event.eventId, team.teamId);
    if (!connection) throw new ApiError(409, "unverified_competitor_account");
    const job = buildJob(
      target,
      event,
      team,
      problem,
      connection,
      options.controlPlaneAccount,
      plan.createdAt,
    );
    await options.work.accept({
      event,
      team,
      job,
      requestKey: contentDigest(JSON.stringify([key, team.teamId, target.problemId])),
      requestHash: hash,
      now,
      ...(target.retryOf === undefined ? {} : { retryOf: target.retryOf }),
    });
  });
  return context.json(
    { eventId: event.eventId, enqueued: plan.targets.length, skipped: plan.skipped },
    202,
  );
}
async function planTargets(
  options: RouteOptions,
  event: EventRecord,
  teams: readonly TeamRecord[],
  ids: readonly string[],
  catalog: Readonly<Record<string, CloudProblem>>,
  retry: boolean,
  now: number,
) {
  const existingJobs = await options.repository.listDeploymentsByEvent(event.eventId);
  const existingIndex = new Map(existingJobs.map((job) => [`${job.teamId}/${job.problemId}`, job]));
  const targets: z.infer<typeof planned>["targets"] = [];
  let skipped = 0;
  for (const team of teams) {
    await options.prepareConnection?.(event, team, now);
    const connection = await options.work.getConnection(event.eventId, team.teamId);
    assertConnection(connection, team, ids, event);
    for (const problemId of ids) {
      const known = existingIndex.get(`${team.teamId}/${problemId}`);
      if ((known && !(retry && known.status === "FAILED")) || (!known && retry)) {
        skipped++;
        continue;
      }
      const target = await planTarget(
        options.work,
        event.eventId,
        team.teamId,
        problemId,
        known !== undefined,
      );
      targets.push(target);
    }
  }
  const catalogKeys = new Set(ids.map((id) => catalog[id]?.catalogKey));
  if (catalogKeys.size !== 1) throw new ApiError(409, "catalog_revision_changed");
  return {
    createdAt: new Date(now).toISOString(),
    catalogKey: catalogKeys.values().next().value,
    targets,
    skipped,
  };
}
function assertConnection(
  connection: Awaited<ReturnType<DynamoDeploymentWork["getConnection"]>>,
  team: TeamRecord,
  ids: readonly string[],
  event: EventRecord,
): void {
  if (
    !connection ||
    (team.awsAccountId && connection.accountId !== team.awsAccountId) ||
    (team.region && connection.region !== team.region)
  )
    throw new ApiError(409, "unverified_competitor_account");
  for (const problemId of ids) {
    const target = event.problems.find((problem) => problem.problemId === problemId);
    if (
      !target ||
      connection.region !== (team.region ?? target.defaultRegion) ||
      (target.defaultAwsAccountId &&
        !team.awsAccountId &&
        target.defaultAwsAccountId !== connection.accountId)
    )
      throw new ApiError(409, "connection_target_mismatch");
  }
  if (
    connection.reviewedProblemIds &&
    ids.some((id) => !connection.reviewedProblemIds?.includes(id))
  )
    throw new ApiError(409, "problem_connection_not_reviewed");
}
async function planTarget(
  work: DynamoDeploymentWork,
  eventId: string,
  teamId: string,
  problemId: string,
  retry: boolean,
) {
  const previous = retry ? await work.getTarget(eventId, teamId, problemId) : undefined;
  if (retry && previous?.status !== "FAILED") throw new ApiError(409, "deployment_plan_changed");
  return {
    jobId: previous?.jobId ?? ulid(),
    teamId,
    problemId,
    attempt: previous ? previous.attempt + 1 : 1,
    ...(previous ? { retryOf: previous.attempt } : {}),
  };
}
function buildJob(
  target: z.infer<typeof planned>["targets"][number],
  event: EventRecord,
  team: TeamRecord,
  problem: CloudProblem,
  connection: NonNullable<Awaited<ReturnType<DynamoDeploymentWork["getConnection"]>>>,
  account: string,
  createdAt: string,
): DeploymentJob {
  const stackName = deploymentStackName(event.eventId, team.teamId, problem.problemId);
  const parameters = Object.fromEntries(
    Object.entries(problem.parameters).map(([key, value]) => [
      key,
      value === "__RANDOM_PASSWORD__" ? randomBytes(24).toString("hex") : value,
    ]),
  );
  return {
    ...target,
    eventId: event.eventId,
    problemId: problem.problemId,
    region: connection.region,
    awsAccountId: connection.accountId,
    status: "PENDING",
    expiresAt: event.expiresAt,
    score: 0,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    stackName,
    problemDir: problem.problemDir,
    artifactDigest: problem.artifactDigest,
    catalogKey: problem.catalogKey,
    scoring: problem.scoring,
    connection,
    parameters: {
      ...parameters,
      NamePrefix: stackName,
      TenkaCloudAccountId: account,
      ExternalId: target.jobId,
    },
  };
}
async function submit(context: Context, options: RouteOptions) {
  const now = options.now();
  const team = await options.repository.authenticateTeam(
    participantKey(context.req.header("Authorization")),
    now,
  );
  if (!team) throw new ApiError(401, "unauthorized");
  const input = z
    .object({
      problemId: z.string().min(1).max(128),
      flag: z.string().min(1).max(4096),
      flagId: z.string().optional(),
    })
    .strict()
    .parse(await body(context));
  const event = await currentEvent(options, team.eventId);
  const job = await options.work.getTarget(team.eventId, team.teamId, input.problemId);
  if (!job) throw new ApiError(404, "not_found");
  const outcome = await options.work.submitFlag({
    team,
    event,
    jobId: job.jobId,
    attempt: job.attempt,
    requestKey: requestKey(context),
    flag: input.flag,
    now,
  });
  return context.json(outcome);
}
async function teardown(context: Context, options: RouteOptions) {
  const now = options.now();
  requireOrganizer(context, ["Admin", "Operator"], options.organizerAuth, now);
  const result = await requestEventTeardown({
    repository: options.repository,
    work: options.work,
    eventId: identifier.parse(context.req.param("eventId")),
    now,
  });
  return context.json(result.body, result.status);
}
/** Shared by the authenticated organizer route and the ownership-checked operator CLI. */
export async function requestEventTeardown(options: {
  readonly repository: CloudRepository;
  readonly work: DynamoDeploymentWork;
  readonly eventId: string;
  readonly now: number;
}) {
  const now = options.now;
  const event = await options.repository.getEvent(identifier.parse(options.eventId));
  if (!event) throw new ApiError(404, "not_found");
  const at = new Date(Math.max(now, Date.parse(event.updatedAt) + 1)).toISOString();
  if ((await options.work.closeEvent(event, at)) === "archived")
    return {
      status: 200 as const,
      body: {
        eventId: event.eventId,
        enqueued: 0,
        skipped: event.teardownExpected ?? 0,
        failed: 0,
      },
    };
  const teams = await options.repository.listTeamsByEvent(event.eventId);
  const jobs: DeploymentJob[] = [];
  await boundedMap(teams, async (team) => {
    jobs.push(...(await options.work.listTargetJobs(event.eventId, team.teamId)));
  });
  await options.work.setTeardownExpected(event.eventId, jobs.length);
  const result = { eventId: event.eventId, enqueued: 0, skipped: 0, failed: 0 };
  await boundedMap(jobs, async (job) => {
    try {
      result[await options.work.requestTeardown(job, at)]++;
    } catch {
      result.failed++;
    }
  });
  await options.work.archiveTeardown(event.eventId);
  return { body: result, status: 202 as const };
}
/** Existing event-deploy/participant-flag wire paths; no tenant claims or process-local locks. */
export function registerCloudDeploymentRoutes(app: Hono, options: RouteOptions): void {
  app.post("/events/:eventId/deploy", (context) => deploy(context, options));
  app.delete("/events/:eventId", (context) => teardown(context, options));
  app.post("/portal/me/submit-flag", (context) => submit(context, options));
  app.get("/portal/me/score-events", async (context) => {
    const team = await options.repository.authenticateTeam(
      participantKey(context.req.header("Authorization")),
      options.now(),
    );
    if (!team) throw new ApiError(401, "unauthorized");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(context.req.query("limit") ?? 100);
    return context.json({
      entries: await options.work.listScoreEvents(team.eventId, team.teamId, limit),
    });
  });
}
