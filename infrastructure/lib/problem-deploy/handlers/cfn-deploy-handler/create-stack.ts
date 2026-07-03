/**
 * Issue #2291 (ADR-049 §9): Lambda-based problem deploy — the create path.
 *
 * TypeScript port of the core of `scripts/deploy-battles.sh` + `scripts/lib/battles-common.sh`
 * so the deploy can run inside a Lambda (Step Functions invokes it, then polls DescribeStacks)
 * instead of a CodeBuild build. This coexists with the CodeBuild path behind the
 * `deployViaLambda` feature flag (default OFF), which keeps the existing CodeBuild behavior and
 * the default CloudFormation template byte-identical.
 *
 * What this module preserves 1:1 from the shell path:
 *   - ExternalId is ALWAYS required for a cross-account AssumeRole (reuses the shared
 *     {@link assumeCompetitorRole}; ExternalId is never optional — CLAUDE.md security invariant).
 *   - Parameter overrides: always inject `NamePrefix` / `TenkaCloudAccountId` / `ExternalId`,
 *     then the problem's `metadata.json` `cfnParameters`, with the `__RANDOM_PASSWORD__` token
 *     replaced by a fresh 32-char alphanumeric secret (mirrors `build_parameter_overrides`).
 *   - A stack left in an un-updatable state (ROLLBACK_COMPLETE / CREATE_FAILED / …) is deleted
 *     before re-create (mirrors `delete_unrecoverable_stack_if_present`).
 *   - `tc-{problemSlug}-{teamSlug}` stack name + `TenkaCloud:*` tags.
 *
 * NON-blocking: this returns right after CreateStack; the Step Functions poll loop watches
 * DescribeStacks until terminal and writes the DDB status transitions.
 */

import { randomInt } from "node:crypto";
import {
  Capability,
  CloudFormationClient,
  CreateStackCommand,
  type CreateStackCommandOutput,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { type Credentials, STSClient } from "@aws-sdk/client-sts";
import {
  type AssumeCompetitorRoleDeps,
  assumeCompetitorRole,
} from "../shared/assume-competitor-role.js";
import {
  type DeployCreateRequestedDetail,
  DeployCreateRequestedDetailSchema,
} from "../shared/events.js";
import { logDeployTrace, warnDeployTrace } from "../shared/trace-log.js";
import {
  type JobProgressLogger,
  makeJobProgressLogger,
  NOOP_JOB_PROGRESS_LOGGER,
  safeProgressInfo,
} from "./job-progress-log.js";

// ---------------------------------------------------------------------------
// Pure helpers (fully unit-tested, no AWS SDK calls)
// ---------------------------------------------------------------------------

/**
 * `metadata.json` `cfnParameters` value token that means "generate a fresh 32-char secret at
 * deploy time" (mirrors `deploy-battles.sh`). Used for DbPassword-style parameters so no secret
 * is committed to the repo.
 */
export const RANDOM_PASSWORD_TOKEN = "__RANDOM_PASSWORD__" as const;

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 32-char `[A-Za-z0-9]` (mirrors `tr -dc 'A-Za-z0-9' | head -c 32`).
 *
 * Uses `crypto.randomInt(max)` (rejection sampling internally) rather than
 * `randomBytes(n) % 62` — the latter is biased because 256 is not a multiple of
 * 62, so indices 0-7 would be drawn slightly more often (CodeQL: "biased random
 * numbers from a cryptographically secure source"). `randomInt` is uniform.
 */
export function generateRandomAlphanumeric(length = 32): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(ALPHANUMERIC.charAt(randomInt(ALPHANUMERIC.length)));
  }
  return chars.join("");
}

export interface CfnParameter {
  readonly ParameterKey: string;
  readonly ParameterValue: string;
}

export interface BuildParameterOverridesArgs {
  /** `metadata.json` `cfnParameters` (problem-author declared). */
  readonly cfnParameters: Readonly<Record<string, string>>;
  readonly namePrefix: string;
  /** Platform (TenkaCloud) account id — the competitor template trusts it for cross-account. */
  readonly tenkaCloudAccountId: string;
  /**
   * The CFn `ExternalId` **parameter** value (distinct from the AssumeRole ExternalId). Mirrors
   * `PROBLEM_EXTERNAL_ID` in the shell path, which the state machine sets to the deploy jobId.
   * Must be >= 16 chars (competitor-bootstrap.yaml `MinLength`).
   */
  readonly externalId: string;
  /** Token generator for `__RANDOM_PASSWORD__` (injected for deterministic tests). */
  readonly generateToken: () => string;
}

/**
 * Build the CloudFormation `Parameters` array. Order + content mirror `build_parameter_overrides`
 * in `deploy-battles.sh`: the three always-injected params first, then the problem's declared
 * `cfnParameters` with `__RANDOM_PASSWORD__` resolved.
 */
export function buildParameterOverrides(args: BuildParameterOverridesArgs): CfnParameter[] {
  if (args.externalId.length < 16) {
    throw new Error("problem ExternalId (CFn parameter) must be at least 16 characters");
  }
  const overrides: CfnParameter[] = [
    { ParameterKey: "NamePrefix", ParameterValue: args.namePrefix },
    { ParameterKey: "TenkaCloudAccountId", ParameterValue: args.tenkaCloudAccountId },
    { ParameterKey: "ExternalId", ParameterValue: args.externalId },
  ];
  for (const [key, value] of Object.entries(args.cfnParameters)) {
    if (!key) continue;
    const resolved = value === RANDOM_PASSWORD_TOKEN ? args.generateToken() : value;
    overrides.push({ ParameterKey: key, ParameterValue: resolved });
  }
  return overrides;
}

export interface CfnTag {
  readonly Key: string;
  readonly Value: string;
}

export interface BuildStackTagsArgs {
  readonly namePrefix: string;
  readonly problemSlug: string;
  readonly teamSlug: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly batchId?: string;
}

/**
 * `TenkaCloud:*` stack tags (mirrors the `--tags` list in `deploy-battles.sh`). `BatchId`
 * defaults to `JobId` for single-shot deploys. `DeployedBy` records the Lambda provenance so
 * operators can tell the CodeBuild path from the Lambda path.
 */
export function buildStackTags(args: BuildStackTagsArgs): CfnTag[] {
  const batchId = args.batchId ?? args.jobId;
  return [
    { Key: "TenkaCloud:NamePrefix", Value: args.namePrefix },
    { Key: "TenkaCloud:Problem", Value: args.problemSlug },
    { Key: "TenkaCloud:ProblemId", Value: args.problemSlug },
    { Key: "TenkaCloud:TeamSlug", Value: args.teamSlug },
    { Key: "TenkaCloud:TenantId", Value: args.tenantId },
    { Key: "TenkaCloud:JobId", Value: args.jobId },
    { Key: "TenkaCloud:BatchId", Value: batchId },
    { Key: "TenkaCloud:DeployedBy", Value: "cfn-deploy-lambda" },
  ];
}

const UNRECOVERABLE_STACK_STATUSES: ReadonlySet<string> = new Set([
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
  "CREATE_FAILED",
  "DELETE_FAILED",
  "REVIEW_IN_PROGRESS",
]);

/**
 * A stack in one of these states cannot be updated by a re-create; it must be deleted first
 * (mirrors the `case` list in `delete_unrecoverable_stack_if_present`). A healthy
 * CREATE_COMPLETE / UPDATE_COMPLETE stack is left alone (normal update), and an absent stack is a
 * plain create.
 */
export function isUnrecoverableStackStatus(status: string | undefined): boolean {
  return status !== undefined && UNRECOVERABLE_STACK_STATUSES.has(status);
}

/** CloudFormation reports an absent stack as an error whose message contains "does not exist". */
export function isStackNotFoundError(err: unknown): boolean {
  return err instanceof Error && /does not exist/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Deploy artifacts (template.yaml + metadata.json cfnParameters)
// ---------------------------------------------------------------------------

export interface DeployArtifacts {
  readonly templateBody: string;
  readonly cfnParameters: Readonly<Record<string, string>>;
}

/** Parse the `cfnParameters` object out of a problem `metadata.json` body (string values only). */
export function parseCfnParameters(metadataJson: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    throw new Error("metadata.json is not valid JSON");
  }
  const raw = (parsed as { cfnParameters?: unknown } | null)?.cfnParameters;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("metadata.json cfnParameters must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`metadata.json cfnParameters["${key}"] must be a string`);
    }
    out[key] = value;
  }
  return out;
}

async function getS3Text(s3: Pick<S3Client, "send">, bucket: string, key: string): Promise<string> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body;
  if (!body || typeof (body as { transformToString?: unknown }).transformToString !== "function") {
    throw new Error(`empty or unreadable S3 object: s3://${bucket}/${key}`);
  }
  return (body as { transformToString: () => Promise<string> }).transformToString();
}

/**
 * Production artifacts resolver: read the problem's `template.yaml` + `metadata.json` from the
 * source bucket.
 *
 * TODO(#2291 follow-up): this assumes the `problems/` tree is materialized (un-zipped) in the
 * source bucket under the same layout `deploy-battles.sh` reads on disk. The artifact-publishing
 * step (materializing `problems/` into S3 at deploy time) and the private-problem presigned
 * `challengePayloadUrl` fetch are finalized in a later slice of #2291. This path is dormant in
 * production because the `deployViaLambda` flag is OFF by default.
 */
export function buildS3ArtifactsResolver(
  s3: Pick<S3Client, "send">,
  opts: { readonly sourceBucket: string },
): (detail: DeployCreateRequestedDetail) => Promise<DeployArtifacts> {
  return async (detail) => {
    const templateBody = await getS3Text(
      s3,
      opts.sourceBucket,
      `${detail.problemDir}/template.yaml`,
    );
    const metadataText = await getS3Text(
      s3,
      opts.sourceBucket,
      `${detail.problemDir}/metadata.json`,
    );
    return { templateBody, cfnParameters: parseCfnParameters(metadataText) };
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface CreateStackDeps extends AssumeCompetitorRoleDeps {
  /** CloudFormation client factory (competitor account creds for cross-account deploy). */
  readonly cfnClient: (params: {
    readonly region: string;
    readonly credentials?: Credentials;
  }) => Pick<CloudFormationClient, "send">;
  /** Resolve the problem's template body + cfnParameters (S3 in production, stubbed in tests). */
  readonly resolveArtifacts: (detail: DeployCreateRequestedDetail) => Promise<DeployArtifacts>;
  /** Platform (TenkaCloud) account id — injected via Lambda env `TENKACLOUD_ACCOUNT_ID`. */
  readonly tenkaCloudAccountId: string;
  /** Same-account CFn execution role ARN (`--role-arn` equivalent). Omitted for cross-account. */
  readonly cfnExecRoleArn?: string;
  /** `__RANDOM_PASSWORD__` / random-secret generator (injected for deterministic tests). */
  readonly generateToken?: () => string;
  /** Bounded wait for a delete to finish before re-create (injected for tests). */
  readonly waitForStackDelete?: (
    cfn: Pick<CloudFormationClient, "send">,
    stackName: string,
  ) => Promise<void>;
  /**
   * Issue #2291: factory for the per-job progress logger (keyed by `jobId`). Present only when the
   * deploy Lambda has a job log group wired (`DEPLOY_JOB_LOG_GROUP` env, `deployViaLambda` ON).
   * Absent → {@link NOOP_JOB_PROGRESS_LOGGER} (default-safe, no CloudWatch writes).
   */
  readonly progressFactory?: (jobId: string) => JobProgressLogger;
}

export interface CreateStackInput {
  readonly detail?: unknown;
}

async function describeStackStatus(
  cfn: Pick<CloudFormationClient, "send">,
  stackName: string,
): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return out.Stacks?.[0]?.StackStatus;
  } catch (err) {
    if (isStackNotFoundError(err)) return undefined;
    throw err;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll interval + overall timeout for {@link defaultWaitForStackDelete} (pre-create delete drain). */
const DELETE_POLL_INTERVAL_MS = 5_000;
const DELETE_WAIT_TIMEOUT_MS = 4 * 60_000;

/**
 * Bounded poll until the stack is gone. TODO(#2291 follow-up): a very long delete can exceed the
 * Lambda timeout; the hardened path (SFN-driven delete + re-drive) is deferred. For the common
 * case this keeps CreateStack from racing an in-flight delete.
 */
async function defaultWaitForStackDelete(
  cfn: Pick<CloudFormationClient, "send">,
  stackName: string,
): Promise<void> {
  const deadline = Date.now() + DELETE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await describeStackStatus(cfn, stackName);
    if (status === undefined) return;
    if (status === "DELETE_FAILED") {
      throw new Error(`unrecoverable stack ${stackName} could not be deleted (DELETE_FAILED)`);
    }
    await sleep(DELETE_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for stack ${stackName} to delete before re-create`);
}

/**
 * Perform the create path for one `DeployCreateRequested` event. Returns after CreateStack
 * (non-blocking); the Step Functions poll loop drives the status → DDB transitions.
 */
export async function createStackForDeployment(
  input: CreateStackInput,
  deps: CreateStackDeps,
): Promise<{ readonly stackId?: string }> {
  const detail = DeployCreateRequestedDetailSchema.parse(input.detail);
  const correlationId = detail.correlationId ?? detail.jobId;
  const generateToken = deps.generateToken ?? (() => generateRandomAlphanumeric(32));
  // #2291: competitor-visible deploy progress. NOOP when no job log group is wired (flag OFF).
  // All lines are secret-free (no ExternalId / credentials / random password).
  const progress = deps.progressFactory?.(detail.jobId) ?? NOOP_JOB_PROGRESS_LOGGER;

  logDeployTrace("deploy.cfn-lambda.start", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.namePrefix,
    region: detail.region,
    hasCompetitorRole: Boolean(detail.competitorRoleArn),
  });

  const artifacts = await deps.resolveArtifacts(detail);

  // ExternalId is ALWAYS required for cross-account AssumeRole (never optional). Same-account
  // (dev) returns undefined credentials — the shared helper enforces the invariant.
  const credentials = await assumeCompetitorRole(deps, {
    region: detail.region,
    jobId: detail.jobId,
    competitorRoleArn: detail.competitorRoleArn,
    externalIdParameterName: detail.externalIdParameterName,
    sessionNamePrefix: "tenkacloud-cfn-deploy-",
    graceFallbackTraceEvent: "deploy.cfn-lambda.assume-role.grace-fallback",
  });

  const parameters = buildParameterOverrides({
    cfnParameters: artifacts.cfnParameters,
    namePrefix: detail.namePrefix,
    tenkaCloudAccountId: deps.tenkaCloudAccountId,
    // Mirror the shell path: PROBLEM_EXTERNAL_ID = $.detail.jobId (a ULID, >= 16 chars).
    externalId: detail.jobId,
    generateToken,
  });
  const tags = buildStackTags({
    namePrefix: detail.namePrefix,
    problemSlug: detail.problemId,
    teamSlug: detail.teamSlug,
    tenantId: detail.tenantId,
    jobId: detail.jobId,
  });

  const cfn = deps.cfnClient({ region: detail.region, credentials });
  await safeProgressInfo(progress, `Deploying stack ${detail.namePrefix} ...`);

  // Delete an un-updatable stack (ROLLBACK_COMPLETE / CREATE_FAILED / …) before re-create.
  const existingStatus = await describeStackStatus(cfn, detail.namePrefix);
  if (isUnrecoverableStackStatus(existingStatus)) {
    warnDeployTrace("deploy.cfn-lambda.delete-unrecoverable", {
      jobId: detail.jobId,
      correlationId,
      stackName: detail.namePrefix,
      status: existingStatus,
    });
    await safeProgressInfo(
      progress,
      `Deleting unrecoverable stack (${existingStatus}) before re-create ...`,
    );
    await cfn.send(new DeleteStackCommand({ StackName: detail.namePrefix }));
    const waitForStackDelete = deps.waitForStackDelete ?? defaultWaitForStackDelete;
    await waitForStackDelete(cfn, detail.namePrefix);
  }

  // Same-account deploy passes the dedicated CFn execution role (`--role-arn`); cross-account
  // deploys run under the assumed competitor credentials, so no RoleARN is passed.
  const roleArn = credentials === undefined ? deps.cfnExecRoleArn : undefined;

  // TODO(#2291 follow-up): this is the CREATE path only. `deploy-battles.sh` uses
  // `aws cloudformation deploy` (create-or-update idempotent); re-deploying a *healthy*
  // CREATE_COMPLETE / UPDATE_COMPLETE stack here would fail with AlreadyExists. The
  // create-or-update collapse (UpdateStack + no-op on empty changeset) is deferred to a later
  // slice. Dormant in production because the `deployViaLambda` flag is OFF by default.

  let out: CreateStackCommandOutput;
  try {
    out = await cfn.send(
      new CreateStackCommand({
        StackName: detail.namePrefix,
        TemplateBody: artifacts.templateBody,
        Parameters: parameters,
        Capabilities: [Capability.CAPABILITY_NAMED_IAM],
        Tags: tags,
        ...(roleArn ? { RoleARN: roleArn } : {}),
        // OnFailure defaults to ROLLBACK: a failed CREATE lands in ROLLBACK_COMPLETE (unrecoverable),
        // which the next run's pre-delete cleans — matches `aws cloudformation deploy` semantics.
      }),
    );
  } catch (err) {
    // Best-effort failure line for the participant; the throw still drives the SM → DDB FAILED.
    await safeProgressInfo(
      progress,
      `Deploy failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  await safeProgressInfo(progress, `CreateStack submitted (stackId ${out.StackId ?? "-"})`);

  logDeployTrace("deploy.cfn-lambda.create-stack.submitted", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.namePrefix,
    region: detail.region,
    stackId: out.StackId,
  });
  return { stackId: out.StackId };
}

// ---------------------------------------------------------------------------
// Lambda entry (real SDK clients). index.ts re-exports `handler` (keeps the routing
// file free of direct @aws-sdk imports — handler-no-direct-sdk-import harness rule).
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

const ssm = new SSMClient({});
const sts = new STSClient({});
const s3 = new S3Client({});
const cwLogs = new CloudWatchLogsClient({});

export async function handler(input: CreateStackInput): Promise<{ readonly stackId?: string }> {
  const sourceBucket = requireEnv("SOURCE_BUCKET_NAME");
  const tenkaCloudAccountId = requireEnv("TENKACLOUD_ACCOUNT_ID");
  const cfnExecRoleArn = process.env.CFN_EXEC_ROLE_ARN || undefined;
  // #2291: only wire a real progress logger when the dedicated job log group is present
  // (deployViaLambda ON). Absent → NOOP inside createStackForDeployment (default-safe).
  const jobLogGroup = process.env.DEPLOY_JOB_LOG_GROUP || undefined;
  return createStackForDeployment(input, {
    ssm,
    sts,
    cfnClient: ({ region, credentials }) =>
      new CloudFormationClient({
        region,
        ...(credentials
          ? {
              credentials: {
                accessKeyId: credentials.AccessKeyId ?? "",
                secretAccessKey: credentials.SecretAccessKey ?? "",
                sessionToken: credentials.SessionToken,
              },
            }
          : {}),
      }),
    resolveArtifacts: buildS3ArtifactsResolver(s3, { sourceBucket }),
    tenkaCloudAccountId,
    cfnExecRoleArn,
    ...(jobLogGroup
      ? {
          progressFactory: (jobId: string) =>
            makeJobProgressLogger({ logs: cwLogs, logGroupName: jobLogGroup, jobId }),
        }
      : {}),
  });
}
