import { CloudFormationClient, DescribeStackResourceCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES, PROBLEM_ID_RE, ULID_RE } from "../shared/constants.js";
import { buildExternalIdParameterName } from "../shared/external-id-store.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { evaluateGate } from "./event-gate.js";
import { type ParticipantSharedResources, resolveDeploymentsRepository } from "./shared.js";

/** Retain the response contract; this implementation only uses participant_viewer. */
export type AssumeRoleStage = "competitor" | "participant_viewer";
type AccessFailure =
  | { kind: "unauthorized" }
  | { kind: "not_ready" }
  | { kind: "invalid_jobid" }
  | { kind: "assume_role_failed"; stage: AssumeRoleStage; reason: string };
export type SsoOutcome =
  | { kind: "ok"; loginUrl: string }
  | AccessFailure
  | { kind: "federation_endpoint_failed"; status: number }
  | { kind: "federation_token_malformed" };

/** Console and CLI both expose only the canonical problem's viewer permissions. */
export interface CliCredentialsView {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: string;
  readonly region: string;
  readonly awsAccountId: string;
}
export type CliCredentialsOutcome = { kind: "ok"; credentials: CliCredentialsView } | AccessFailure;

const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";
const FEDERATION_SESSION_DURATION_SEC = 3600;
const TENKACLOUD_ISSUER = "https://tenkacloud.example/portal";
const AWS_REGION_RE = /^[a-z]{2,3}-[a-z]+-\d{1,2}$/;
const NAME_PREFIX_RE = /^tc-[a-z0-9][a-z0-9-]{1,124}$/;
const IAM_ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]{1,64})$/;
const sts = new STSClient({});

export function buildConsoleDestination(args: { readonly region: string }): string {
  return `https://${args.region}.console.aws.amazon.com/console/home?region=${encodeURIComponent(args.region)}`;
}

/** Composite access may supply a server-resolved, team-bound target loader. */
export type SsoDeploymentLoader = (
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
) => Promise<Partial<DeploymentItem> | undefined>;
export type StsClient = Pick<STSClient, "send">;
export interface SsoDeploymentDeps {
  readonly loadDeployment?: SsoDeploymentLoader;
  /** Operator credentials: canonical viewer roles trust the host account directly. */
  readonly sts?: StsClient;
  /** Independent operator client for the read-only stack-verification session. */
  readonly verificationSts?: StsClient;
  readonly buildVerificationClient?: (
    credentials: SdkCredentials,
    region: string,
  ) => Pick<CloudFormationClient, "send">;
  readonly fetchClient?: typeof fetch;
}
interface SdkCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}
interface ReadySsoDeployment {
  readonly deployment: Partial<DeploymentItem>;
  readonly problemId: string;
  readonly region: string;
  readonly awsAccountId: string;
  readonly stackId: string;
  readonly competitorRoleArn: string;
  readonly tenantId: string;
  readonly participantRoleArn: string;
  readonly accessUntil: number;
}

async function loadSsoDeployment(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
): Promise<Partial<DeploymentItem> | undefined> {
  const repository = await resolveDeploymentsRepository(shared);
  // An eventually consistent GSI can still contain a revoked bearer or deleted row.
  // The SQL adapter matches the bearer hash and restores only this caller-known key.
  const deployment = await repository.getDeployment(jobId, {
    consistentRead: true,
    expectedTeamLoginKey: teamLoginKey,
  });
  // Composite targets remain accessible only through their capability/parent bridge.
  if (deployment && ("parentDeploymentId" in deployment || "runtimeKind" in deployment)) {
    return undefined;
  }
  return deployment;
}

function logSsoNotReady(event: string, detail: Record<string, unknown>): AccessFailure {
  logDeployTrace(event, detail);
  return { kind: "not_ready" };
}

async function loadReadyDeployment(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
  deps: SsoDeploymentDeps,
): Promise<ReadySsoDeployment | AccessFailure> {
  if (!ULID_RE.test(jobId)) return { kind: "invalid_jobid" };
  const deployment = await (deps.loadDeployment ?? loadSsoDeployment)(shared, teamLoginKey, jobId);
  if (!deployment || deployment.jobId !== jobId || deployment.teamLoginKey !== teamLoginKey) {
    return { kind: "unauthorized" };
  }
  if (DELETED_LIKE_STATUSES.has(deployment.status ?? "PENDING") || deployment.teardownRequestedAt) {
    return { kind: "unauthorized" };
  }
  const identifiers = validateSsoIdentifiers(deployment);
  if ("kind" in identifiers) return identifiers;
  const { problemId, region, tenantId, awsAccountId, stackId, competitorRoleArn } = identifiers;
  const parsedOutputs = parseStackOutputs(deployment.stackOutputs);
  const participantRoleArn = parsedOutputs.ParticipantViewerRoleArn;
  const role = participantRoleArn?.match(IAM_ROLE_ARN_RE);
  if (
    !participantRoleArn ||
    !role ||
    role[1] !== awsAccountId ||
    !role[2]?.startsWith("tc-") ||
    participantRoleArn === competitorRoleArn
  ) {
    return logSsoNotReady("portal.sso.not_ready.participantViewerRole_missing", {
      jobId,
      problemId,
      tenantId,
      outputKeys: Object.keys(parsedOutputs),
    });
  }
  const deadline = await accessDeadline(shared, deployment, tenantId);
  if (typeof deadline !== "number") return deadline;
  return {
    deployment,
    problemId,
    region,
    awsAccountId,
    participantRoleArn,
    stackId,
    competitorRoleArn,
    tenantId,
    accessUntil: deadline,
  };
}

function validateSsoIdentifiers(deployment: Partial<DeploymentItem>):
  | {
      problemId: string;
      namePrefix: string;
      region: string;
      tenantId: string;
      awsAccountId: string;
      stackId: string;
      competitorRoleArn: string;
    }
  | AccessFailure {
  const { jobId, status, problemId, namePrefix, region, tenantId, awsAccountId } = deployment;
  if (status !== "COMPLETE") {
    return logSsoNotReady("portal.sso.not_ready.in_progress", { jobId, problemId, status });
  }
  if (typeof namePrefix !== "string" || !NAME_PREFIX_RE.test(namePrefix)) {
    return logSsoNotReady("portal.sso.not_ready.namePrefix_missing", { jobId, problemId });
  }
  if (typeof region !== "string" || !AWS_REGION_RE.test(region)) {
    return logSsoNotReady("portal.sso.not_ready.region_missing", { jobId, problemId });
  }
  if (!tenantId)
    return logSsoNotReady("portal.sso.not_ready.tenantId_missing", { jobId, problemId });
  if (!problemId || !PROBLEM_ID_RE.test(problemId)) return { kind: "not_ready" };
  const competitorAccount = deployment.competitorRoleArn?.match(IAM_ROLE_ARN_RE)?.[1];
  if (!awsAccountId || !/^\d{12}$/.test(awsAccountId) || competitorAccount !== awsAccountId) {
    return logSsoNotReady("portal.sso.not_ready.competitorRoleArn_missing", {
      jobId,
      problemId,
      tenantId,
    });
  }
  if (awsAccountId === process.env.PARTICIPANT_OPERATOR_ACCOUNT_ID) return { kind: "not_ready" };
  const { stackId, competitorRoleArn } = deployment;
  if (!competitorRoleArn || !isOwnedStackId(stackId, region, awsAccountId, namePrefix)) {
    return { kind: "not_ready" };
  }
  return { problemId, namePrefix, region, tenantId, awsAccountId, stackId, competitorRoleArn };
}

function isOwnedStackId(
  stackId: string | undefined,
  region: string,
  account: string,
  name: string,
): stackId is string {
  return (
    typeof stackId === "string" &&
    stackId.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${name}/`) &&
    /^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[a-z0-9-]+\/[A-Za-z0-9-]+$/.test(stackId)
  );
}

async function accessDeadline(
  shared: ParticipantSharedResources,
  deployment: Partial<DeploymentItem>,
  tenantId: string,
): Promise<number | AccessFailure> {
  const expiresAt = (deployment.expiresAt ?? Number.NaN) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { kind: "unauthorized" };
  if (!deployment.eventId) return expiresAt;
  const events = await shared.runtime.resolveEventsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
  const event = await events.getEvent(tenantId, deployment.eventId, true);
  if (
    event?.status !== "READY" ||
    !event.problems?.some((problem) => problem.problemId === deployment.problemId) ||
    evaluateGate(
      {
        ...event,
        scoringLocked: event.scoringLocked === true,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        scoreboardFreezeMinutes: event.scoreboardFreezeMinutes,
        progressionGate: undefined,
      },
      Date.now(),
    )
  )
    return { kind: "not_ready" };
  const accessUntil = Math.min(
    expiresAt,
    event.expiresAt * 1000,
    event.endsAt ? Date.parse(event.endsAt) : Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(accessUntil) && accessUntil > Date.now()
    ? accessUntil
    : { kind: "unauthorized" };
}

/** Resolve the exact logical resource; CloudFormation's physical-name format is not an API contract. */
async function verifyParticipantRole(
  shared: ParticipantSharedResources,
  ready: ReadySsoDeployment,
  jobId: string,
  deps: SsoDeploymentDeps,
): Promise<AccessFailure | undefined> {
  try {
    if (!shared.ssm || !shared.env) throw new Error("ExternalId store not configured");
    const secret = await shared.ssm.send(
      new GetParameterCommand({
        Name: buildExternalIdParameterName(shared.env, ready.tenantId),
        WithDecryption: true,
      }),
    );
    if (secret.Parameter?.Type !== "SecureString" || !secret.Parameter.Value) {
      throw new Error("ExternalId SecureString missing");
    }
    const verified = await (deps.verificationSts ?? sts).send(
      new AssumeRoleCommand({
        RoleArn: ready.competitorRoleArn,
        RoleSessionName: `tc-view-proof-${jobId}`,
        ExternalId: secret.Parameter.Value,
        DurationSeconds: 900,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "cloudformation:DescribeStackResource",
              Resource: ready.stackId,
            },
            { Effect: "Deny", NotAction: "cloudformation:DescribeStackResource", Resource: "*" },
            {
              Effect: "Deny",
              Action: "cloudformation:DescribeStackResource",
              NotResource: ready.stackId,
            },
          ],
        }),
      }),
    );
    const credentials = verified.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      !credentials.Expiration ||
      credentials.Expiration.getTime() <= Date.now()
    ) {
      throw new Error("Verification credentials missing");
    }
    const config = {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration,
    };
    const cfn =
      deps.buildVerificationClient?.(config, ready.region) ??
      new CloudFormationClient({ region: ready.region, credentials: config });
    const response = await cfn.send(
      new DescribeStackResourceCommand({
        StackName: ready.stackId,
        LogicalResourceId: "ParticipantViewerRole",
      }),
    );
    const role = response.StackResourceDetail;
    if (
      role?.StackId !== ready.stackId ||
      role.LogicalResourceId !== "ParticipantViewerRole" ||
      role.ResourceType !== "AWS::IAM::Role" ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(role.ResourceStatus ?? "") ||
      `arn:aws:iam::${ready.awsAccountId}:role/${role.PhysicalResourceId}` !==
        ready.participantRoleArn
    ) {
      return { kind: "not_ready" };
    }
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.name : "Unknown";
    console.error("[sso] Viewer ownership verification failed", { jobId, reason });
    return { kind: "assume_role_failed", stage: "competitor", reason };
  }
}

/** No new permissions: session Allow is intersected with the canonical viewer-role policy. */
function sessionDeadlinePolicy(accessUntil: number): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "*", Resource: "*" },
      {
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: {
          DateGreaterThanEquals: { "aws:CurrentTime": new Date(accessUntil).toISOString() },
        },
      },
    ],
  });
}

async function assumeParticipantCredentials(
  shared: ParticipantSharedResources,
  ready: ReadySsoDeployment,
  jobId: string,
  deps: SsoDeploymentDeps,
): Promise<{ kind: "ok"; credentials: SdkCredentials } | AccessFailure> {
  const unverified = await verifyParticipantRole(shared, ready, jobId, deps);
  if (unverified) return unverified;
  try {
    const result = await (deps.sts ?? sts).send(
      new AssumeRoleCommand({
        RoleArn: ready.participantRoleArn,
        RoleSessionName: `${ready.problemId.slice(0, 37)}-${jobId}`,
        ExternalId: jobId,
        DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
        Policy: sessionDeadlinePolicy(ready.accessUntil),
      }),
    );
    const credentials = result.Credentials;
    const expiration = credentials?.Expiration?.getTime();
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      expiration === undefined ||
      !Number.isFinite(expiration) ||
      expiration <= Date.now() ||
      expiration > Date.now() + (FEDERATION_SESSION_DURATION_SEC + 5) * 1000
    ) {
      return {
        kind: "assume_role_failed",
        stage: "participant_viewer",
        reason: "Invalid credentials",
      };
    }
    return {
      kind: "ok",
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
        expiration: new Date(Math.min(expiration, ready.accessUntil)),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "Unknown";
    console.error("[sso] AssumeRole failed", { jobId, stage: "participant_viewer", reason });
    return { kind: "assume_role_failed", stage: "participant_viewer", reason };
  }
}

async function stillCurrent(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
  deps: SsoDeploymentDeps,
  initial: ReadySsoDeployment,
): Promise<AccessFailure | undefined> {
  const current = await loadReadyDeployment(shared, teamLoginKey, jobId, deps);
  if ("kind" in current) return current;
  const identity = (ready: ReadySsoDeployment) =>
    JSON.stringify([
      ready.deployment.tenantId,
      ready.deployment.eventId,
      ready.deployment.teamId,
      ready.deployment.stackId,
      ready.deployment.namePrefix,
      ready.problemId,
      ready.region,
      ready.awsAccountId,
      ready.participantRoleArn,
      ready.accessUntil,
    ]);
  return identity(current) === identity(initial) ? undefined : { kind: "not_ready" };
}

export async function getConsoleSigninUrl(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
  deps: SsoDeploymentDeps = {},
): Promise<SsoOutcome> {
  const ready = await loadReadyDeployment(shared, teamLoginKey, jobId, deps);
  if ("kind" in ready) return ready;
  const session = await assumeParticipantCredentials(shared, ready, jobId, deps);
  if (session.kind !== "ok") return session;
  const sessionJson = JSON.stringify({
    sessionId: session.credentials.accessKeyId,
    sessionKey: session.credentials.secretAccessKey,
    sessionToken: session.credentials.sessionToken,
  });
  const tokenUrl = `${FEDERATION_ENDPOINT}?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
  const response = await (deps.fetchClient ?? fetch)(tokenUrl, { method: "GET" });
  if (!response.ok) return { kind: "federation_endpoint_failed", status: response.status };
  let token: unknown;
  try {
    token = ((await response.json()) as { SigninToken?: unknown }).SigninToken;
  } catch {
    return { kind: "federation_token_malformed" };
  }
  if (typeof token !== "string" || !token) return { kind: "federation_token_malformed" };
  const changed = await stillCurrent(shared, teamLoginKey, jobId, deps, ready);
  if (changed) return changed;
  const loginUrl = `${FEDERATION_ENDPOINT}?Action=login&Issuer=${encodeURIComponent(TENKACLOUD_ISSUER)}&Destination=${encodeURIComponent(buildConsoleDestination(ready))}&SigninToken=${encodeURIComponent(token)}`;
  logDeployTrace("portal.sso.ok", { jobId, problemId: ready.problemId, total: loginUrl.length });
  return { kind: "ok", loginUrl };
}

export async function getCliCredentials(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
  deps: SsoDeploymentDeps = {},
): Promise<CliCredentialsOutcome> {
  const ready = await loadReadyDeployment(shared, teamLoginKey, jobId, deps);
  if ("kind" in ready) return ready;
  const session = await assumeParticipantCredentials(shared, ready, jobId, deps);
  if (session.kind !== "ok") return session;
  const changed = await stillCurrent(shared, teamLoginKey, jobId, deps, ready);
  if (changed) return changed;
  const credentials = {
    ...session.credentials,
    expiration: session.credentials.expiration.toISOString(),
    region: ready.region,
    awsAccountId: ready.awsAccountId,
  };
  logDeployTrace("portal.cli.ok", {
    jobId,
    problemId: ready.problemId,
    expiration: credentials.expiration,
  });
  return { kind: "ok", credentials };
}
