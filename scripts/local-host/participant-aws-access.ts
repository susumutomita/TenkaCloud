import { AssumeRoleCommand, type AssumeRoleCommandOutput, STSClient } from "@aws-sdk/client-sts";
import type { CliCredentialsView } from "@tenkacloud/portal-contracts";
import { z } from "zod";
import { HostError, type Job, type Team } from "./model";

const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";
const SESSION_SECONDS = 3600;
const unitSchema = z.object({
  kind: z.literal("cloudformation"),
  accountId: z.string().regex(/^\d{12}$/u),
  region: z.string().regex(/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d{1,2}$/u),
  roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/u),
  outputs: z.object({
    ParticipantViewerRoleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/u),
  }),
});
const credentialsSchema = z.object({
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1),
  Expiration: z.date(),
});

interface ConsoleTarget {
  readonly jobId: string;
  readonly sessionName: string;
  readonly accountId: string;
  readonly region: string;
  readonly deployRoleArn: string;
  readonly viewerRoleArn: string;
}

interface SessionCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

interface AccessStsClient {
  destroy?(): void;
  send(
    command: AssumeRoleCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<AssumeRoleCommandOutput>;
}

export interface ParticipantAwsClients {
  readonly sts: AccessStsClient;
  readonly participantSts?: (credentials: SessionCredentials, region: string) => AccessStsClient;
  readonly federationFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export type ParticipantAwsAccess =
  | { readonly kind: "console"; readonly loginUrl: string }
  | { readonly kind: "cli"; readonly credentials: CliCredentialsView };

export class ParticipantAssumeRoleError extends HostError {
  constructor(readonly stage: "competitor" | "participant_viewer") {
    super(
      500,
      "AWS access could not be issued. Ask the organizer to check the role trust.",
      "assume_role_failed",
    );
  }
}

function consoleTarget(job: Job, team: Team): ConsoleTarget {
  let raw: unknown;
  try {
    raw = JSON.parse(job.unit ?? "null");
  } catch {
    throw new HostError(409, "This environment has no valid AWS access target.", "not_ready");
  }
  const parsed = unitSchema.safeParse(raw);
  if (!parsed.success)
    throw new HostError(409, "This environment has no participant viewer role.", "not_ready");
  const unit = parsed.data;
  const viewerRoleArn = unit.outputs.ParticipantViewerRoleArn;
  const deployRoleArn = `arn:aws:iam::${team.aws?.accountId}:role/${team.aws?.roleName}`;
  if (
    job.teamId !== team.teamId ||
    job.eventId !== team.eventId ||
    unit.accountId !== team.aws?.accountId ||
    unit.roleArn !== deployRoleArn ||
    !viewerRoleArn.startsWith(`arn:aws:iam::${unit.accountId}:role/`) ||
    viewerRoleArn === deployRoleArn
  )
    throw new HostError(
      409,
      "This environment's AWS access target does not match its team.",
      "not_ready",
    );
  return {
    jobId: job.jobId,
    sessionName: `tc-${team.teamId.slice(-10)}-${job.jobId}`,
    accountId: unit.accountId,
    region: unit.region,
    deployRoleArn,
    viewerRoleArn,
  };
}

async function assume(
  client: AccessStsClient,
  target: ConsoleTarget,
  roleArn: string,
  externalId: string,
  stage: ParticipantAssumeRoleError["stage"],
  assertCurrent: () => void,
): Promise<SessionCredentials> {
  assertCurrent();
  let response: AssumeRoleCommandOutput;
  try {
    response = await client.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: target.sessionName,
        ExternalId: externalId,
        DurationSeconds: SESSION_SECONDS,
      }),
      { abortSignal: AbortSignal.timeout(4000) },
    );
  } catch {
    throw new ParticipantAssumeRoleError(stage);
  }
  assertCurrent();
  const parsed = credentialsSchema.safeParse(response.Credentials);
  if (!parsed.success || parsed.data.Expiration.getTime() <= Date.now())
    throw new ParticipantAssumeRoleError(stage);
  return {
    accessKeyId: parsed.data.AccessKeyId,
    secretAccessKey: parsed.data.SecretAccessKey,
    sessionToken: parsed.data.SessionToken,
    expiration: parsed.data.Expiration,
  };
}

async function consoleUrl(
  credentials: SessionCredentials,
  target: ConsoleTarget,
  httpFetch: NonNullable<ParticipantAwsClients["federationFetch"]>,
  assertCurrent: () => void,
): Promise<string> {
  const tokenBody = new URLSearchParams({
    Action: "getSigninToken",
    Session: JSON.stringify({
      sessionId: credentials.accessKeyId,
      sessionKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    }),
  });
  let response: Response;
  try {
    response = await httpFetch(FEDERATION_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    throw new HostError(502, "AWS console sign-in is unavailable.", "federation_endpoint_failed");
  }
  assertCurrent();
  if (!response.ok)
    throw new HostError(502, "AWS console sign-in is unavailable.", "federation_endpoint_failed");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new HostError(
      502,
      "AWS returned an invalid sign-in token.",
      "federation_token_malformed",
    );
  }
  assertCurrent();
  const token = z.object({ SigninToken: z.string().min(1).max(16384) }).safeParse(raw);
  if (!token.success)
    throw new HostError(
      502,
      "AWS returned an invalid sign-in token.",
      "federation_token_malformed",
    );
  const loginUrl = new URL(FEDERATION_ENDPOINT);
  loginUrl.search = new URLSearchParams({
    Action: "login",
    Destination: `https://${target.region}.console.aws.amazon.com/console/home?region=${encodeURIComponent(target.region)}`,
    SigninToken: token.data.SigninToken,
  }).toString();
  return loginUrl.href;
}

/** Both entry points issue only the job's viewer credentials; deploy credentials stay here. */
export async function participantAwsAccess(args: {
  readonly kind: ParticipantAwsAccess["kind"];
  readonly job: Job;
  readonly team: Team;
  readonly externalId: string;
  readonly clients: ParticipantAwsClients;
  readonly assertCurrent: () => void;
}): Promise<ParticipantAwsAccess> {
  const target = consoleTarget(args.job, args.team);
  args.assertCurrent();
  const deploy = await assume(
    args.clients.sts,
    target,
    target.deployRoleArn,
    args.externalId,
    "competitor",
    args.assertCurrent,
  );
  const client = args.clients.participantSts
    ? args.clients.participantSts(deploy, target.region)
    : new STSClient({ region: target.region, credentials: deploy });
  let viewer: SessionCredentials;
  try {
    viewer = await assume(
      client,
      target,
      target.viewerRoleArn,
      target.jobId,
      "participant_viewer",
      args.assertCurrent,
    );
  } finally {
    client.destroy?.();
  }
  if (args.kind === "cli") {
    return {
      kind: "cli",
      credentials: {
        ...viewer,
        expiration: viewer.expiration.toISOString(),
        region: target.region,
        awsAccountId: target.accountId,
      },
    };
  }
  const loginUrl = await consoleUrl(
    viewer,
    target,
    args.clients.federationFetch ?? fetch,
    args.assertCurrent,
  );
  return { kind: "console", loginUrl };
}
