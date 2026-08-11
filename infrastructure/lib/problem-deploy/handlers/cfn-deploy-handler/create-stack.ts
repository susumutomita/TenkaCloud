/**
 * Issue #2291: Lambda-based problem deploy — the create path.
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
 *   - Create-or-update collapse: a healthy existing stack (CREATE_COMPLETE / UPDATE_COMPLETE / …)
 *     is updated in place via UpdateStack, and an unchanged template ("No updates are to be
 *     performed.") is a successful no-op — mirrors idempotent `aws cloudformation deploy` so a
 *     re-deploy over a live stack no longer fails with `AlreadyExists`.
 *   - `tc-{problemSlug}-{teamSlug}` stack name + `TenkaCloud:*` tags.
 *
 * NON-blocking: this returns right after CreateStack/UpdateStack; the Step Functions poll loop
 * watches DescribeStacks until terminal and writes the DDB status transitions.
 */

import {
  Capability,
  CloudFormationClient,
  CreateStackCommand,
  type CreateStackCommandOutput,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type UpdateStackCommandOutput,
} from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { type Credentials, STSClient } from "@aws-sdk/client-sts";
import {
  type ChallengePayloadArtifacts,
  fetchChallengePayloadArtifacts,
} from "../../challenge-payload-artifacts.js";
import {
  type AllowedCidrOverrideDecision,
  parseDeployAllowedCidrs,
  resolveAllowedCidrOverride,
} from "../../deploy-allowed-cidrs.js";
import { getS3ObjectText } from "../../s3-artifact-text.js";
import {
  type AssumeCompetitorRoleDeps,
  assumeCompetitorRole,
} from "../shared/assume-competitor-role.js";
import {
  type DeploymentProgressWriter,
  writeDeploymentProgress,
} from "../shared/deployment-progress-log.js";
import {
  type DeployCreateRequestedDetail,
  DeployCreateRequestedDetailSchema,
} from "../shared/events.js";
import { logDeployTrace, warnDeployTrace } from "../shared/trace-log.js";
import {
  type JobProgressLogger,
  NOOP_JOB_PROGRESS_LOGGER,
  safeProgressInfo,
} from "./job-progress-log.js";

// [Issue #986 SOLID split] Parameter-override building lives in its own module; re-exported here
// so this file's public API (and the existing test import path) stay unchanged.
export {
  buildParameterOverrides,
  generateRandomAlphanumeric,
  RANDOM_PASSWORD_TOKEN,
} from "./parameter-overrides.js";

import {
  buildParameterOverrides,
  type CfnParameter,
  generateRandomAlphanumeric,
} from "./parameter-overrides.js";

// ---------------------------------------------------------------------------
// Pure helpers (fully unit-tested, no AWS SDK calls)
// ---------------------------------------------------------------------------

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

/**
 * A stack in one of these states already deployed cleanly; a re-deploy is an in-place UpdateStack
 * (create-or-update collapse — mirrors what idempotent `aws cloudformation deploy` does for an
 * existing stack). `UPDATE_ROLLBACK_COMPLETE` and the two `IMPORT_*_COMPLETE` states are also
 * updatable, so they belong here rather than in the unrecoverable (pre-delete) set.
 */
const HEALTHY_STACK_STATUSES: ReadonlySet<string> = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
]);

/** The deploy action a live stack status implies (create-or-update collapse decision). */
export type DeployAction = "create" | "update" | "delete-recreate" | "in-progress";

/**
 * Decide how to deploy over an existing stack, given its current status:
 *   - `undefined` (absent) → `"create"` (plain CreateStack).
 *   - unrecoverable ({@link isUnrecoverableStackStatus}: ROLLBACK_COMPLETE / CREATE_FAILED / …) →
 *     `"delete-recreate"` (DeleteStack, wait, then CreateStack).
 *   - healthy ({@link HEALTHY_STACK_STATUSES}) → `"update"` (in-place UpdateStack).
 *   - anything else (a transitional `*_IN_PROGRESS`) → `"in-progress"` (caller must fail loud; we
 *     never silently skip a deploy over a stack that is still settling).
 */
export function classifyDeployAction(status: string | undefined): DeployAction {
  if (status === undefined) return "create";
  if (isUnrecoverableStackStatus(status)) return "delete-recreate";
  if (HEALTHY_STACK_STATUSES.has(status)) return "update";
  return "in-progress";
}

/** CloudFormation reports an absent stack as an error whose message contains "does not exist". */
export function isStackNotFoundError(err: unknown): boolean {
  return err instanceof Error && /does not exist/i.test(err.message);
}

/**
 * UpdateStack against a stack whose template + parameters are unchanged fails with
 * "No updates are to be performed." — an idempotent re-deploy, not a real failure. Treated as a
 * successful no-op (mirrors `aws cloudformation deploy --no-fail-on-empty-changeset`).
 */
export function isNoUpdatesError(err: unknown): boolean {
  return err instanceof Error && /no updates are to be performed/i.test(err.message);
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

/**
 * Public-problem artifacts resolver: read the problem's `template.yaml` + `metadata.json` from the
 * materialized `problems/` tree in the source bucket (published by #2347). Private problems do not
 * materialize their tree — they flow through {@link buildArtifactsResolver} + the presigned
 * `challengePayloadUrl` instead. This path is dormant in production because the `deployViaLambda`
 * flag is OFF by default.
 */
export function buildS3ArtifactsResolver(
  s3: Pick<S3Client, "send">,
  opts: { readonly sourceBucket: string },
): (detail: DeployCreateRequestedDetail) => Promise<DeployArtifacts> {
  return async (detail) => {
    const templateBody = await getS3ObjectText(
      s3,
      opts.sourceBucket,
      `${detail.problemDir}/template.yaml`,
    );
    const metadataText = await getS3ObjectText(
      s3,
      opts.sourceBucket,
      `${detail.problemDir}/metadata.json`,
    );
    return { templateBody, cfnParameters: parseCfnParameters(metadataText) };
  };
}

export interface ArtifactsResolverDeps {
  /** Public-problem path: read the materialized tree from the source bucket (slice 6, #2347). */
  readonly resolveFromS3: (detail: DeployCreateRequestedDetail) => Promise<DeployArtifacts>;
  /**
   * Private-problem path: download + unzip the presigned `challengePayloadUrl`. Defaults to the
   * real {@link fetchChallengePayloadArtifacts} (injected as a fake in tests). Kept as an injected
   * dep so no raw `fetch(` appears under `lib/handlers/` (handler-must-not-call-fetch rule) — the
   * HTTP+unzip primitive lives in `challenge-payload-artifacts.ts`.
   */
  readonly fetchPayloadArtifacts?: (url: string) => Promise<ChallengePayloadArtifacts>;
}

/**
 * Issue #2291: the deploy path resolver. Mirrors the `resolve_problem_dir()` branch in
 * `deploy-battles.sh`:
 *   - `detail.challengePayloadUrl` is a non-empty string (a **private** problem) → download + unzip
 *     the presigned payload and parse its `metadata.json` `cfnParameters`.
 *   - otherwise (a **public** problem) → the existing source-bucket read, byte-for-byte unchanged.
 */
export function buildArtifactsResolver(
  deps: ArtifactsResolverDeps,
): (detail: DeployCreateRequestedDetail) => Promise<DeployArtifacts> {
  const fetchPayloadArtifacts = deps.fetchPayloadArtifacts ?? fetchChallengePayloadArtifacts;
  return async (detail) => {
    const payloadUrl = detail.challengePayloadUrl;
    if (typeof payloadUrl === "string" && payloadUrl.length > 0) {
      const { templateBody, metadataText } = await fetchPayloadArtifacts(payloadUrl);
      return { templateBody, cfnParameters: parseCfnParameters(metadataText) };
    }
    return deps.resolveFromS3(detail);
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
  readonly progress?: DeploymentProgressWriter;
  readonly progressFactory?: (jobId: string) => JobProgressLogger;
  /** Score-engine / operator-attacker egress CIDRs for templates that declare `AllowedCidr`. */
  readonly deployAllowedCidrs?: readonly string[];
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

/**
 * Resolve the physical StackId for the no-update no-op return value (UpdateStack does not report a
 * StackId when it raises "No updates are to be performed."). An absent stack yields `undefined`; any
 * other DescribeStacks error is rethrown (fail loud — matches {@link describeStackStatus}).
 */
async function describeStackId(
  cfn: Pick<CloudFormationClient, "send">,
  stackName: string,
): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return out.Stacks?.[0]?.StackId;
  } catch (err) {
    if (isStackNotFoundError(err)) return undefined;
    throw err;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded poll until the stack is gone. TODO(#2291 follow-up): a very long delete can exceed the
 * Lambda timeout; the hardened path (SFN-driven delete + re-drive) is deferred. For the common
 * case this keeps CreateStack from racing an in-flight delete.
 */
async function defaultWaitForStackDelete(
  cfn: Pick<CloudFormationClient, "send">,
  stackName: string,
): Promise<void> {
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await describeStackStatus(cfn, stackName);
    if (status === undefined) return;
    if (status === "DELETE_FAILED") {
      throw new Error(`unrecoverable stack ${stackName} could not be deleted (DELETE_FAILED)`);
    }
    await sleep(5000);
  }
  throw new Error(`timed out waiting for stack ${stackName} to delete before re-create`);
}

function warnAllowedCidrDecision(args: {
  readonly decision: AllowedCidrOverrideDecision;
  readonly detail: DeployCreateRequestedDetail;
  readonly correlationId: string;
}): void {
  const { decision, detail, correlationId } = args;
  if (decision.kind === "unconfigured") {
    warnDeployTrace("deploy.cfn-lambda.allowed-cidr.unconfigured", {
      jobId: detail.jobId,
      correlationId,
      tenantId: detail.tenantId,
      stackName: detail.namePrefix,
      problemId: detail.problemId,
      parameterType: decision.parameterType,
      multiTeamGriefingRisk: true,
      message:
        "Template declares AllowedCidr but DEPLOY_ALLOWED_CIDRS is not configured; CloudFormation default may expose app ingress.",
    });
    return;
  }
  if (
    decision.kind !== "configured" ||
    decision.configuredCidrCount <= decision.injectedCidrCount
  ) {
    return;
  }
  warnDeployTrace("deploy.cfn-lambda.allowed-cidr.primary-only", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.namePrefix,
    problemId: detail.problemId,
    parameterType: decision.parameterType,
    configuredCidrCount: decision.configuredCidrCount,
    injectedCidrCount: decision.injectedCidrCount,
    primaryAllowedCidr: decision.parameterValue,
    message: "AllowedCidr is a single-value parameter; using the first configured CIDR only.",
  });
}

interface DeployCommandArgs {
  readonly detail: DeployCreateRequestedDetail;
  readonly correlationId: string;
  readonly templateBody: string;
  readonly parameters: readonly CfnParameter[];
  readonly tags: readonly CfnTag[];
  /** Same-account CFn exec role; undefined for cross-account (runs under assumed creds). */
  readonly roleArn: string | undefined;
  readonly reportProgress: (message: string) => Promise<void>;
}

/**
 * In-place UpdateStack over a healthy existing stack (create-or-update collapse). An unchanged
 * template raises "No updates are to be performed." — treated as a successful no-op that resolves
 * its StackId from DescribeStacks (mirrors `aws cloudformation deploy --no-fail-on-empty-changeset`).
 * A non-no-op failure emits a best-effort progress line and re-throws (fail loud → SM → DDB FAILED).
 */
async function updateHealthyStack(
  cfn: Pick<CloudFormationClient, "send">,
  args: DeployCommandArgs,
): Promise<{
  readonly stackId?: string;
  readonly operation: "update" | "noop";
}> {
  const { detail, correlationId, reportProgress } = args;
  await reportProgress(`Updating stack ${detail.namePrefix} ...`);
  let updated: UpdateStackCommandOutput;
  try {
    updated = await cfn.send(
      new UpdateStackCommand({
        StackName: detail.namePrefix,
        TemplateBody: args.templateBody,
        Parameters: [...args.parameters],
        Capabilities: [Capability.CAPABILITY_NAMED_IAM],
        Tags: [...args.tags],
        ...(args.roleArn ? { RoleARN: args.roleArn } : {}),
      }),
    );
  } catch (err) {
    if (isNoUpdatesError(err)) {
      logDeployTrace("deploy.cfn-lambda.update-stack.no-op", {
        jobId: detail.jobId,
        correlationId,
        tenantId: detail.tenantId,
        stackName: detail.namePrefix,
        region: detail.region,
      });
      await reportProgress("No changes to apply");
      const stackId = await describeStackId(cfn, detail.namePrefix);
      return stackId ? { stackId, operation: "noop" } : { operation: "noop" };
    }
    // Best-effort failure line for the participant; the throw still drives the SM → DDB FAILED.
    await reportProgress(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  const updateStackId = updated.StackId;
  await reportProgress(`UpdateStack submitted (stackId ${updateStackId ?? "-"})`);
  logDeployTrace("deploy.cfn-lambda.update-stack.submitted", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.namePrefix,
    region: detail.region,
    stackId: updateStackId,
  });
  return { stackId: updateStackId, operation: "update" };
}

/**
 * Perform the create path for one `DeployCreateRequested` event. Returns after CreateStack
 * (non-blocking); the Step Functions poll loop drives the status → DDB transitions.
 */
export async function createStackForDeployment(
  input: CreateStackInput,
  deps: CreateStackDeps,
): Promise<{ readonly stackId?: string; readonly operation: "create" | "update" | "noop" }> {
  const detail = DeployCreateRequestedDetailSchema.parse(input.detail);
  const correlationId = detail.correlationId ?? detail.jobId;
  const generateToken = deps.generateToken ?? (() => generateRandomAlphanumeric(32));
  const jobProgress = deps.progressFactory?.(detail.jobId) ?? NOOP_JOB_PROGRESS_LOGGER;
  const reportProgress = async (message: string): Promise<void> => {
    await safeProgressInfo(jobProgress, message);
    await deps.progress?.(detail.jobId, message);
  };

  logDeployTrace("deploy.cfn-lambda.start", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.namePrefix,
    region: detail.region,
    hasCompetitorRole: Boolean(detail.competitorRoleArn),
  });
  await reportProgress(`Preparing CloudFormation deployment for ${detail.problemId}`);

  const artifacts = await deps.resolveArtifacts(detail);
  const allowedCidrOverride = resolveAllowedCidrOverride({
    templateBody: artifacts.templateBody,
    deployAllowedCidrs: deps.deployAllowedCidrs,
  });
  warnAllowedCidrDecision({ decision: allowedCidrOverride, detail, correlationId });

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
    templateBody: artifacts.templateBody,
    deployAllowedCidrs: deps.deployAllowedCidrs,
    allowedCidrOverride,
    boundParameters: detail.parameters,
  });
  const tags = buildStackTags({
    namePrefix: detail.namePrefix,
    problemSlug: detail.problemId,
    teamSlug: detail.teamSlug,
    tenantId: detail.tenantId,
    jobId: detail.jobId,
  });

  const cfn = deps.cfnClient({ region: detail.region, credentials });
  await reportProgress(`Deploying stack ${detail.namePrefix} ...`);

  // Create-or-update collapse (mirrors idempotent `aws cloudformation deploy`): pick the action
  // from the live stack status. An absent stack → create; a healthy stack → in-place update; an
  // un-updatable stack → delete + re-create; a transitional `*_IN_PROGRESS` → fail loud.
  const existingStatus = await describeStackStatus(cfn, detail.namePrefix);
  const action = classifyDeployAction(existingStatus);

  // Never silently skip a deploy over a stack that is still settling — fail loud so the SM → DDB
  // records FAILED rather than a no-op success while the stack keeps transitioning.
  if (action === "in-progress") {
    throw new Error(
      `stack ${detail.namePrefix} is currently ${existingStatus}; cannot deploy until it settles`,
    );
  }

  // Delete an un-updatable stack (ROLLBACK_COMPLETE / CREATE_FAILED / …) before re-create.
  if (action === "delete-recreate") {
    warnDeployTrace("deploy.cfn-lambda.delete-unrecoverable", {
      jobId: detail.jobId,
      correlationId,
      stackName: detail.namePrefix,
      status: existingStatus,
    });
    await reportProgress(`Deleting unrecoverable stack (${existingStatus}) before re-create ...`);
    await cfn.send(new DeleteStackCommand({ StackName: detail.namePrefix }));
    const waitForStackDelete = deps.waitForStackDelete ?? defaultWaitForStackDelete;
    await waitForStackDelete(cfn, detail.namePrefix);
  }

  // Same-account deploy passes the dedicated CFn execution role (`--role-arn`); cross-account
  // deploys run under the assumed competitor credentials, so no RoleARN is passed.
  const roleArn = credentials === undefined ? deps.cfnExecRoleArn : undefined;

  // A healthy stack is updated in place (create-or-update collapse).
  if (action === "update") {
    return updateHealthyStack(cfn, {
      detail,
      correlationId,
      templateBody: artifacts.templateBody,
      parameters,
      tags,
      roleArn,
      reportProgress,
    });
  }

  // action is "create" or "delete-recreate" (the stack is now absent) → CreateStack.
  const stackInput = {
    StackName: detail.namePrefix,
    TemplateBody: artifacts.templateBody,
    Parameters: parameters,
    Capabilities: [Capability.CAPABILITY_NAMED_IAM],
    Tags: tags,
    ...(roleArn ? { RoleARN: roleArn } : {}),
  };
  let out: CreateStackCommandOutput;
  try {
    out = await cfn.send(new CreateStackCommand(stackInput));
  } catch (error) {
    await reportProgress(
      `Deploy failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  logDeployTrace("deploy.cfn-lambda.create-stack.submitted", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.namePrefix,
    region: detail.region,
    stackId: out.StackId,
  });
  await reportProgress(`CreateStack submitted (stackId ${out.StackId ?? "-"})`);
  return { stackId: out.StackId, operation: "create" };
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

export function buildCloudFormationClient(params: {
  readonly region: string;
  readonly credentials?: Credentials;
}): CloudFormationClient {
  return new CloudFormationClient({
    region: params.region,
    ...(params.credentials
      ? {
          credentials: {
            accessKeyId: params.credentials.AccessKeyId ?? "",
            secretAccessKey: params.credentials.SecretAccessKey ?? "",
            sessionToken: params.credentials.SessionToken,
          },
        }
      : {}),
  });
}

export async function handler(
  input: CreateStackInput,
): Promise<{ readonly stackId?: string; readonly operation: "create" | "update" | "noop" }> {
  const sourceBucket = requireEnv("SOURCE_BUCKET_NAME");
  const tenkaCloudAccountId = requireEnv("TENKACLOUD_ACCOUNT_ID");
  const cfnExecRoleArn = process.env.CFN_EXEC_ROLE_ARN || undefined;
  const deployAllowedCidrs = parseDeployAllowedCidrs(process.env.DEPLOY_ALLOWED_CIDRS);
  return createStackForDeployment(input, {
    ssm,
    sts,
    cfnClient: buildCloudFormationClient,
    // Public problems read the materialized tree from S3; private problems (challengePayloadUrl
    // set) download + unzip the presigned payload via challenge-payload-artifacts.ts.
    resolveArtifacts: buildArtifactsResolver({
      resolveFromS3: buildS3ArtifactsResolver(s3, { sourceBucket }),
    }),
    tenkaCloudAccountId,
    cfnExecRoleArn,
    deployAllowedCidrs,
    progress: writeDeploymentProgress,
  });
}
