import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import type { CliCredentialsView } from "@tenkacloud/portal-contracts";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { CloudDeploymentWork } from "../../control-data/cloud-data-ports.js";
import type { CloudRepository } from "../../control-data/cloud-repository.js";
import {
  contentDigest,
  type DeploymentJob,
  scoringBlock,
} from "../../control-data/domain/deployment-work.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import {
  type CloudRunnerDependencies,
  deploymentIdentity,
  describeParticipantTarget,
} from "../cloud-runner/index.js";
import {
  type ArtifactResolver,
  buildDeploymentInput,
  sameConnection,
} from "../cloud-runner/workflow.js";
import { ApiError, participantKey } from "./auth.js";

export interface CloudParticipantAccess {
  readonly work: Pick<
    CloudDeploymentWork,
    | "getJob"
    | "getTarget"
    | "getConnection"
    | "getCreation"
    | "acceptingNewDeployments"
    | "assertParticipantAccessCurrent"
  >;
  readonly resolveArtifacts: ArtifactResolver;
  readonly authorizeJob: (job: DeploymentJob) => Promise<void>;
  readonly runner: CloudRunnerDependencies;
  /** Operator credentials, never the competitor deployment credentials. */
  readonly sts: {
    send(
      command: AssumeRoleCommand,
      options: { abortSignal: AbortSignal },
    ): Promise<AssumeRoleCommandOutput>;
  };
  readonly controlPlaneAccount: string;
}
interface Options extends CloudParticipantAccess {
  readonly repository: CloudRepository;
  readonly now: () => number;
}
interface AccessScope {
  readonly team: TeamRecord;
  readonly event: EventRecord;
  readonly job: DeploymentJob;
  readonly identity: string;
  readonly accessUntil: number;
}

function requestedJob(context: Context): string {
  const queries = context.req.queries();
  const ids = queries.jobId;
  if (
    Object.keys(queries).length !== 1 ||
    ids?.length !== 1 ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(ids[0] ?? "")
  )
    throw new ApiError(400, "invalid_jobid");
  return ids[0] ?? "";
}

async function currentScope(key: string, jobId: string, options: Options): Promise<AccessScope> {
  const now = options.now();
  const team = await options.repository.authenticateTeam(key, now);
  if (!team) throw new ApiError(401, "unauthorized");
  const event = await options.repository.getEvent(team.eventId);
  if (!event || event.expiresAt <= now / 1000) throw new ApiError(409, "scoring_ended");
  const blocked = scoringBlock(event, now);
  if (blocked) throw new ApiError(409, blocked);
  const job = await options.work.getJob(jobId);
  if (!job || job.teamId !== team.teamId || job.eventId !== team.eventId)
    throw new ApiError(403, "unauthorized");
  const target = await options.work.getTarget(team.eventId, team.teamId, job.problemId);
  if (
    target?.jobId !== job.jobId ||
    target.attempt !== job.attempt ||
    job.status !== "COMPLETE" ||
    job.teardownStatus ||
    !job.stackId ||
    job.problemId !== "hello-world" ||
    job.problemDir !== "problems/challenges/hello-world" ||
    !event.problems.some((problem) => problem.problemId === job.problemId) ||
    job.expiresAt <= now / 1000 ||
    job.awsAccountId === options.controlPlaneAccount ||
    job.parameters?.TenkaCloudAccountId !== options.controlPlaneAccount ||
    job.parameters.ExternalId !== job.jobId
  )
    throw new ApiError(409, "not_ready");
  const connection = await options.work.getConnection(team.eventId, team.teamId);
  if (
    !connection ||
    !sameConnection(connection, job.connection) ||
    connection.eventId !== team.eventId ||
    connection.teamId !== team.teamId ||
    connection.accountId !== job.awsAccountId ||
    connection.region !== job.region
  )
    throw new ApiError(409, "not_ready");
  try {
    await options.authorizeJob(job);
  } catch {
    throw new ApiError(409, "not_ready");
  }
  if (!(await options.work.acceptingNewDeployments()))
    throw new ApiError(409, "installation_draining");
  const accessUntil = Math.min(
    event.expiresAt * 1000,
    team.expiresAt * 1000,
    job.expiresAt * 1000,
    event.endsAt ? Date.parse(event.endsAt) : Number.POSITIVE_INFINITY,
  );
  return {
    team,
    event,
    job,
    accessUntil,
    identity: contentDigest(
      JSON.stringify({
        authVersion: team.authVersion,
        eventId: event.eventId,
        teamId: team.teamId,
        jobId: job.jobId,
        attempt: job.attempt,
        stackId: job.stackId,
        connection,
        parameters: job.parameters,
        artifactDigest: job.artifactDigest,
        catalogKey: job.catalogKey,
      }),
    ),
  };
}

/** Fixed hello-world permission intersection. No list, path traversal, AssumeRole or console services. */
export function helloWorldSessionPolicy(parameterArn: string, until: string): string {
  if (
    !/^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/tc-cloud-[a-f0-9]{40}\/hello$/u.test(
      parameterArn,
    ) ||
    !Number.isFinite(Date.parse(until))
  )
    throw new Error("Invalid participant permission scope.");
  const actions = ["ssm:GetParameter", "ssm:GetParameters"];
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: actions, Resource: parameterArn },
      // Explicit denies also bound resource-based grants made to a session principal.
      { Effect: "Deny", NotAction: actions, Resource: "*" },
      { Effect: "Deny", Action: actions, NotResource: parameterArn },
      {
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: { DateGreaterThanEquals: { "aws:CurrentTime": until } },
      },
    ],
  });
}

async function issue(key: string, jobId: string, options: Options): Promise<CliCredentialsView> {
  const initial = await currentScope(key, jobId, options);
  const assertCurrent = async () => {
    const current = await currentScope(key, jobId, options);
    if (current.identity !== initial.identity || current.accessUntil !== initial.accessUntil)
      throw new ApiError(409, "not_ready");
  };
  const { input } = buildDeploymentInput(initial.job, await options.resolveArtifacts(initial.job));
  const creation = await options.work.getCreation(initial.job);
  const fingerprint = deploymentIdentity(input).fingerprint;
  if (
    creation?.state !== "ACKNOWLEDGED" ||
    !creation.stackId ||
    creation.stackId !== initial.job.stackId ||
    creation.fingerprint !== fingerprint
  )
    throw new ApiError(409, "not_ready");
  await assertCurrent();
  const target = await describeParticipantTarget(
    input,
    { stackId: creation.stackId, fingerprint },
    options.runner,
  );
  await assertCurrent();
  const until = Math.min(initial.accessUntil, options.now() + 900_000);
  let response: AssumeRoleCommandOutput;
  try {
    response = await options.sts.send(
      new AssumeRoleCommand({
        RoleArn: target.roleArn,
        RoleSessionName: `tc-view-${jobId}`,
        ExternalId: jobId,
        DurationSeconds: 900,
        Policy: helloWorldSessionPolicy(target.parameterArn, new Date(until).toISOString()),
      }),
      { abortSignal: AbortSignal.timeout(4000) },
    );
  } catch {
    throw new ParticipantAccessError("participant_viewer");
  }
  await assertCurrent();
  const credentials = z
    .object({
      AccessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/u),
      SecretAccessKey: z.string().regex(/^[A-Za-z0-9/+=]{16,256}$/u),
      SessionToken: z.string().regex(/^[A-Za-z0-9/+=]{16,16384}$/u),
      Expiration: z.date(),
    })
    .safeParse(response.Credentials);
  if (
    !credentials.success ||
    response.AssumedRoleUser?.Arn !==
      `arn:aws:sts::${initial.job.awsAccountId}:assumed-role/${target.roleArn.split("/").at(-1)}/tc-view-${jobId}` ||
    credentials.data.Expiration.getTime() <= options.now() ||
    credentials.data.Expiration.getTime() > options.now() + 905_000
  )
    throw new ParticipantAccessError("participant_viewer");
  try {
    await options.work.assertParticipantAccessCurrent({
      ...initial,
      fingerprint,
      now: options.now(),
    });
  } catch {
    throw new ApiError(409, "not_ready");
  }
  return {
    accessKeyId: credentials.data.AccessKeyId,
    secretAccessKey: credentials.data.SecretAccessKey,
    sessionToken: credentials.data.SessionToken,
    expiration: new Date(Math.min(until, credentials.data.Expiration.getTime())).toISOString(),
    region: initial.job.region,
    awsAccountId: initial.job.awsAccountId,
  };
}
class ParticipantAccessError extends Error {
  constructor(readonly stage: "competitor" | "participant_viewer") {
    super("AWS participant access unavailable");
  }
}
export function registerParticipantAccessRoutes(app: Hono, options: Options): void {
  app.get("/portal/me/cli-credentials", async (context) => {
    const jobId = requestedJob(context);
    const key = participantKey(context.req.header("Authorization"));
    try {
      return context.json({ credentials: await issue(key, jobId, options) });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return context.json(
        {
          error: "assume_role_failed",
          stage: error instanceof ParticipantAccessError ? error.stage : "competitor",
          reason: "Role access denied or temporary credentials unavailable.",
        },
        500,
      );
    }
  });
  app.get("/portal/me/console-signin-url", async (context) => {
    const jobId = requestedJob(context);
    await currentScope(participantKey(context.req.header("Authorization")), jobId, options);
    throw new ApiError(409, "aws_console_unavailable");
  });
}
