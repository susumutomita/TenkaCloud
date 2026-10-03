/**
 * Issue #2291: Lambda-based problem deploy — the DELETE path.
 *
 * TypeScript port of `scripts/delete-battles.sh` so the teardown can run inside the **same**
 * `CfnDeployLambda` the create path (`create-stack.ts`) uses (Step Functions invokes it, then
 * polls DescribeStacks) instead of a CodeBuild build. This coexists with the CodeBuild path
 * behind the `deployViaLambda` feature flag (default OFF), which keeps the existing CodeBuild
 * behavior and the default CloudFormation template byte-identical.
 *
 * What this module preserves 1:1 from the shell path (`delete-battles.sh`):
 *   - ExternalId is ALWAYS required for a cross-account AssumeRole (reuses the shared
 *     {@link assumeCompetitorRole}; ExternalId is never optional — CLAUDE.md security invariant).
 *   - #1797 account-mismatch guard: before DeleteStack, verify the (assumed) credentials point at
 *     the account the stack actually lives in (`detail.awsAccountId`). Deleting a stack by name in
 *     the wrong account is a silent no-op success — the DB row would flip to DELETED while the real
 *     stack survives. `sts:GetCallerIdentity` under the assumed creds is compared and we fail loud
 *     on mismatch (mirrors the `DELETE_EXPECTED_AWS_ACCOUNT_ID` check in `delete-battles.sh`).
 *   - DeleteStack is idempotent: an already-gone stack (`ValidationError` / "does not exist") is a
 *     no-op success, not a failure (mirrors the `grep -qiE "ValidationError|does not exist"` guard).
 *   - same-account passes the CFn exec role (`--role-arn`) so the Lambda role keeps no direct
 *     resource-deletion power (#1381); cross-account runs under the assumed competitor creds.
 *
 * NON-blocking: {@link deleteStackForDeployment} returns right after DeleteStack; the Step Functions
 * poll loop calls {@link describeDeleteStackForPoll} (Wait + DescribeStacks) until the stack reaches
 * DELETE_COMPLETE / is gone, and writes the DDB status transitions (DELETING → DELETED / FAILED).
 */

import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { type Credentials, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  type AssumeCompetitorRoleDeps,
  assumeCompetitorRole,
} from "../shared/assume-competitor-role.js";
import {
  type DeployDeleteRequestedDetail,
  DeployDeleteRequestedDetailSchema,
} from "../shared/events.js";
import { errorDeployTrace, logDeployTrace, warnDeployTrace } from "../shared/trace-log.js";
import {
  type JobProgressLogger,
  makeJobProgressLogger,
  NOOP_JOB_PROGRESS_LOGGER,
  safeProgressInfo,
} from "./job-progress-log.js";

// ---------------------------------------------------------------------------
// Pure helpers (no AWS SDK calls)
// ---------------------------------------------------------------------------

/**
 * CloudFormation reports an already-deleted stack as a `ValidationError` whose message contains
 * "does not exist". DeleteStack against such a stack is a no-op success (mirrors the
 * `grep -qiE "ValidationError|does not exist"` guard in `delete-battles.sh` — the delete is
 * idempotent and a pre-check `describe-stacks` would only add a TOCTOU race, so we let the API
 * tell us the stack is gone).
 */
export function isStackAlreadyDeletedError(err: unknown): boolean {
  return err instanceof Error && /ValidationError|does not exist/i.test(err.message);
}

/** CloudFormation `Stacks[0]` shape the Step Functions poll loop reads via `$.cfn.Stacks[0]`. */
export interface PollStackStatus {
  readonly StackStatus: string;
  readonly StackStatusReason?: string;
  readonly StackId?: string;
}

export interface PollStackResult {
  readonly Stacks: readonly [PollStackStatus];
}

/**
 * A gone stack is terminal SUCCESS for a delete. DescribeStacks by name on a fully-deleted stack
 * throws (`ValidationError`), so we normalize "gone" to a synthetic `DELETE_COMPLETE` here — that
 * way the state machine's `RoutePollStatus` Choice sees one clean terminal status regardless of
 * whether the stack lingered in DELETE_COMPLETE (StackId lookup) or vanished (name lookup).
 */
function goneStackResult(stackName: string): PollStackResult {
  return { Stacks: [{ StackStatus: "DELETE_COMPLETE", StackId: stackName }] };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DeleteStackDeps extends AssumeCompetitorRoleDeps {
  /** CloudFormation client factory (competitor account creds for cross-account delete). */
  readonly cfnClient: (params: {
    readonly region: string;
    readonly credentials?: Credentials;
  }) => Pick<CloudFormationClient, "send">;
  /**
   * STS client factory used to run `GetCallerIdentity` **under the assumed (or same-account)
   * credentials** for the #1797 account-mismatch guard. Distinct from {@link AssumeCompetitorRoleDeps.sts}
   * (which assumes the role with the Lambda's own creds) — here we verify who we became.
   */
  readonly stsIdentityClient: (params: {
    readonly region: string;
    readonly credentials?: Credentials;
  }) => Pick<STSClient, "send">;
  /** Same-account CFn execution role ARN (`--role-arn` equivalent). Omitted for cross-account. */
  readonly cfnExecRoleArn?: string;
  /**
   * Issue #2291: factory for the per-job progress logger (keyed by `jobId`), mirroring the create
   * path so a teardown watched via `GET /portal/me/deploy-logs` shows progress on the Lambda path
   * too. Present only when the job log group is wired (`DEPLOY_JOB_LOG_GROUP`, `deployViaLambda`
   * ON); absent → {@link NOOP_JOB_PROGRESS_LOGGER} (default-safe, no CloudWatch writes).
   */
  readonly progressFactory?: (jobId: string) => JobProgressLogger;
}

export interface DeleteStackInput {
  readonly detail?: unknown;
}

/** Emit a competitor-visible terminal line for the delete poll (DELETE_COMPLETE / DELETE_FAILED). */
async function emitDeleteTerminalProgress(
  progress: JobProgressLogger,
  stack: PollStackStatus,
): Promise<void> {
  if (stack.StackStatus === "DELETE_COMPLETE") {
    await safeProgressInfo(progress, "Delete complete");
  } else if (stack.StackStatus === "DELETE_FAILED") {
    await safeProgressInfo(progress, `Delete failed: ${stack.StackStatusReason ?? "unknown"}`);
  }
}

/** Assume the competitor role (if configured) and build a CFn client for the target account. */
async function resolveTargetContext(
  detail: DeployDeleteRequestedDetail,
  deps: DeleteStackDeps,
): Promise<{
  readonly cfn: Pick<CloudFormationClient, "send">;
  readonly credentials: Credentials | undefined;
  readonly correlationId: string;
}> {
  const correlationId = detail.correlationId ?? detail.jobId;
  // ExternalId is ALWAYS required for cross-account AssumeRole (never optional). Same-account
  // (dev) returns undefined credentials — the shared helper enforces the invariant.
  const credentials = await assumeCompetitorRole(deps, {
    region: detail.region,
    jobId: detail.jobId,
    competitorRoleArn: detail.competitorRoleArn,
    externalIdParameterName: detail.externalIdParameterName,
    sessionNamePrefix: "tenkacloud-cfn-delete-",
    graceFallbackTraceEvent: "deploy.cfn-lambda.delete.assume-role.grace-fallback",
  });
  const cfn = deps.cfnClient({ region: detail.region, credentials });
  return { cfn, credentials, correlationId };
}

/**
 * #1797 silent-leak guard: confirm the (assumed) credentials are for the account the stack lives
 * in before DeleteStack. Deleting by name in the wrong account is a no-op success that would flip
 * the DB row to DELETED while the real stack survives. Fails loud on mismatch.
 */
async function assertCredentialsTargetExpectedAccount(
  deps: DeleteStackDeps,
  args: {
    readonly region: string;
    readonly credentials: Credentials | undefined;
    readonly expectedAccountId: string;
    readonly stackName: string;
    readonly jobId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  const sts = deps.stsIdentityClient({ region: args.region, credentials: args.credentials });
  const out = await sts.send(new GetCallerIdentityCommand({}));
  const actual = out.Account;
  if (!actual) {
    throw new Error("sts:GetCallerIdentity returned no Account (credential / STS availability)");
  }
  if (actual !== args.expectedAccountId) {
    errorDeployTrace("deploy.cfn-lambda.delete.account-mismatch", {
      jobId: args.jobId,
      correlationId: args.correlationId,
      stackName: args.stackName,
      region: args.region,
      expectedAccount: args.expectedAccountId,
      actualAccount: actual,
    });
    throw new Error(
      `credentials are for account ${actual} but stack ${args.stackName} lives in ` +
        `${args.expectedAccountId}; aborting before DeleteStack (the stack would silently survive)`,
    );
  }
}

/**
 * Perform the delete path for one `DeployDeleteRequested` event. Returns after DeleteStack
 * (non-blocking); the Step Functions poll loop drives the status → DDB transitions.
 */
export async function deleteStackForDeployment(
  input: DeleteStackInput,
  deps: DeleteStackDeps,
): Promise<{ readonly deleted: boolean }> {
  const detail = DeployDeleteRequestedDetailSchema.parse(input.detail);
  const { cfn, credentials, correlationId } = await resolveTargetContext(detail, deps);
  // #2291: NOOP when no job log group is wired (flag OFF). Lines are secret-free.
  const progress = deps.progressFactory?.(detail.jobId) ?? NOOP_JOB_PROGRESS_LOGGER;

  logDeployTrace("deploy.cfn-lambda.delete.start", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.stackName,
    region: detail.region,
    hasCompetitorRole: Boolean(detail.competitorRoleArn),
  });

  await assertCredentialsTargetExpectedAccount(deps, {
    region: detail.region,
    credentials,
    expectedAccountId: detail.awsAccountId,
    stackName: detail.stackName,
    jobId: detail.jobId,
    correlationId,
  });

  await safeProgressInfo(progress, `Deleting stack ${detail.stackName} ...`);

  // same-account delete passes the dedicated CFn execution role (`--role-arn`); cross-account
  // deletes run under the assumed competitor credentials, so no RoleARN is passed (#1381).
  const roleArn = credentials === undefined ? deps.cfnExecRoleArn : undefined;

  try {
    await cfn.send(
      new DeleteStackCommand({
        StackName: detail.stackName,
        ...(roleArn ? { RoleARN: roleArn } : {}),
      }),
    );
  } catch (err) {
    if (isStackAlreadyDeletedError(err)) {
      warnDeployTrace("deploy.cfn-lambda.delete.already-deleted", {
        jobId: detail.jobId,
        correlationId,
        stackName: detail.stackName,
        region: detail.region,
      });
      await safeProgressInfo(progress, "Delete complete");
      return { deleted: true };
    }
    await safeProgressInfo(
      progress,
      `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  logDeployTrace("deploy.cfn-lambda.delete.submitted", {
    jobId: detail.jobId,
    correlationId,
    tenantId: detail.tenantId,
    stackName: detail.stackName,
    region: detail.region,
  });
  await safeProgressInfo(progress, `Delete submitted for stack ${detail.stackName}`);
  return { deleted: true };
}

/**
 * One poll iteration for the delete state machine: DescribeStacks on the target stack, normalized
 * so the SM Choice reads a single terminal status. A gone stack (`ValidationError` / "does not
 * exist") is normalized to `DELETE_COMPLETE` (terminal success). Cross-account DescribeStacks needs
 * the ExternalId-scoped AssumeRole, which is why the poll runs in this Lambda rather than a native
 * Step Functions CallAwsService (mirrors why the create poll uses `describe-stack-handler`).
 */
export async function describeDeleteStackForPoll(
  input: DeleteStackInput,
  deps: DeleteStackDeps,
): Promise<PollStackResult> {
  const detail = DeployDeleteRequestedDetailSchema.parse(input.detail);
  const { cfn, credentials, correlationId } = await resolveTargetContext(detail, deps);
  // #2291: NOOP when no job log group is wired (flag OFF).
  const progress = deps.progressFactory?.(detail.jobId) ?? NOOP_JOB_PROGRESS_LOGGER;

  // #1797 (poll): a name miss (empty Stacks / ValidationError) is only terminal SUCCESS when the
  // credentials are still on the target account. Without this, drifted creds could turn a
  // wrong-account name miss into DELETE_COMPLETE and advance teardown for a stack that still exists.
  // Checked only on the "gone" transition (not every poll), so the extra STS call is one-shot.
  const assertOnTargetAccount = () =>
    assertCredentialsTargetExpectedAccount(deps, {
      region: detail.region,
      credentials,
      expectedAccountId: detail.awsAccountId,
      stackName: detail.stackName,
      jobId: detail.jobId,
      correlationId,
    });

  let result: PollStackResult;
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: detail.stackName }));
    const stack = out.Stacks?.[0];
    if (!stack?.StackStatus) {
      // CFn returns the stack or throws; an empty Stacks array means it is gone.
      await assertOnTargetAccount();
      result = goneStackResult(detail.stackName);
    } else {
      // The SM's DELETE_FAILED branch reads StackStatusReason via JsonPath
      // (`$.cfn.Stacks[0].StackStatusReason`). CloudFormation does not always populate it, so
      // guarantee the field on DELETE_FAILED with a static fallback — a missing field would throw
      // States.Runtime in the failure Pass and strand the row in DELETING instead of reaching
      // MarkFailed. Other statuses stay sparse (their reason, if any, is passed through but never
      // referenced).
      const failureReason =
        stack.StackStatus === "DELETE_FAILED"
          ? (stack.StackStatusReason ?? "CloudFormation reported DELETE_FAILED without a reason")
          : stack.StackStatusReason;
      result = {
        Stacks: [
          {
            StackStatus: stack.StackStatus,
            ...(failureReason ? { StackStatusReason: failureReason } : {}),
            ...(stack.StackId ? { StackId: stack.StackId } : {}),
          },
        ],
      };
    }
  } catch (err) {
    if (!isStackAlreadyDeletedError(err)) throw err;
    await assertOnTargetAccount();
    logDeployTrace("deploy.cfn-lambda.delete.poll.gone", {
      jobId: detail.jobId,
      correlationId,
      stackName: detail.stackName,
      region: detail.region,
    });
    result = goneStackResult(detail.stackName);
  }

  // #2291: only DELETE_COMPLETE / DELETE_FAILED emit a competitor-visible terminal line; an
  // in-progress poll writes nothing (so a multi-poll teardown yields one terminal line, not many).
  await emitDeleteTerminalProgress(progress, result.Stacks[0]);
  return result;
}

// ---------------------------------------------------------------------------
// Lambda entries (real SDK clients). index.ts dispatches to these by `action` (keeps the routing
// file free of direct @aws-sdk imports — handler-no-direct-sdk-import harness rule).
// ---------------------------------------------------------------------------

const ssm = new SSMClient({});
const sts = new STSClient({});
const cwLogs = new CloudWatchLogsClient({});

/** Shape STS `Credentials` into the AWS SDK v3 `credentials` option (empty for same-account). */
function sdkCredentials(credentials?: Credentials) {
  return credentials
    ? {
        credentials: {
          accessKeyId: credentials.AccessKeyId ?? "",
          secretAccessKey: credentials.SecretAccessKey ?? "",
          sessionToken: credentials.SessionToken,
        },
      }
    : {};
}

function buildRealDeps(): DeleteStackDeps {
  // #2291: only wire a real progress logger when the dedicated job log group is present
  // (deployViaLambda ON). Absent → NOOP inside the delete handlers (default-safe).
  const jobLogGroup = process.env.DEPLOY_JOB_LOG_GROUP || undefined;
  return {
    ssm,
    sts,
    cfnClient: ({ region, credentials }) =>
      new CloudFormationClient({ region, ...sdkCredentials(credentials) }),
    stsIdentityClient: ({ region, credentials }) =>
      new STSClient({ region, ...sdkCredentials(credentials) }),
    cfnExecRoleArn: process.env.CFN_EXEC_ROLE_ARN || undefined,
    ...(jobLogGroup
      ? {
          progressFactory: (jobId: string) =>
            makeJobProgressLogger({ logs: cwLogs, logGroupName: jobLogGroup, jobId }),
        }
      : {}),
  };
}

export async function deleteHandler(
  input: DeleteStackInput,
): Promise<{ readonly deleted: boolean }> {
  return deleteStackForDeployment(input, buildRealDeps());
}

export async function describeDeleteHandler(input: DeleteStackInput): Promise<PollStackResult> {
  return describeDeleteStackForPoll(input, buildRealDeps());
}
