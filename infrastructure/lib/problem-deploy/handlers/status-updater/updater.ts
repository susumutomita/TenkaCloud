import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import {
  type DeploymentStatus,
  extractStackContext,
  resolveDeploymentStatus,
  serializeStackOutputs,
} from "../shared/cfn-status.js";
import {
  COMPETITOR_ROLE_NAME_DEFAULT,
  EVENT_DETAIL_TYPE_DEPLOY_COMPLETED,
  EVENT_DETAIL_TYPE_DEPLOY_DELETED,
  EVENT_DETAIL_TYPE_DEPLOY_FAILED,
  publishProblemEvent,
} from "../shared/events.js";
import type { TrackedDeployment } from "./types.js";

interface AssumedCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

const NON_TERMINAL_STATUSES = new Set<DeploymentStatus>(["PENDING", "IN_PROGRESS", "DELETING"]);

const DETAIL_TYPE_BY_STATUS = {
  COMPLETE: EVENT_DETAIL_TYPE_DEPLOY_COMPLETED,
  DELETED: EVENT_DETAIL_TYPE_DEPLOY_DELETED,
  FAILED: EVENT_DETAIL_TYPE_DEPLOY_FAILED,
} as const satisfies Partial<Record<DeploymentStatus, string>>;

export interface UpdaterSharedResources {
  readonly tableName: string;
  readonly eventBusName: string;
  readonly competitorRoleName: string;
  readonly externalId: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly sts: STSClient;
  readonly cfnFactory: (creds: AssumedCredentials, region: string) => CloudFormationClient;
  readonly now: () => number;
}

export function buildUpdaterShared(): UpdaterSharedResources {
  return {
    tableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventBusName: getEnv("DEPLOY_EVENT_BUS_NAME"),
    competitorRoleName: process.env.COMPETITOR_ROLE_NAME ?? COMPETITOR_ROLE_NAME_DEFAULT,
    externalId: getEnv("DEPLOY_EXTERNAL_ID"),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    sts: new STSClient({}),
    cfnFactory: (creds, region) =>
      new CloudFormationClient({
        region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      }),
    now: () => Date.now(),
  };
}

export async function runStatusUpdate(shared: UpdaterSharedResources): Promise<void> {
  const items = await scanTracked(shared);
  await Promise.allSettled(items.map((item) => processOne(shared, item)));
}

async function scanTracked(shared: UpdaterSharedResources): Promise<TrackedDeployment[]> {
  const out: TrackedDeployment[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await shared.ddb.send(
      new ScanCommand({
        TableName: shared.tableName,
        FilterExpression: "#s IN (:pending, :inProgress, :deleting)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":inProgress": "IN_PROGRESS",
          ":deleting": "DELETING",
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const raw of res.Items ?? []) {
      out.push(toTracked(raw));
    }
    exclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return out;
}

function toTracked(raw: Record<string, unknown>): TrackedDeployment {
  return {
    jobId: String(raw.jobId ?? ""),
    tenantId: String(raw.tenantId ?? ""),
    problemId: String(raw.problemId ?? ""),
    awsAccountId: String(raw.awsAccountId ?? ""),
    region: String(raw.region ?? ""),
    namePrefix: String(raw.namePrefix ?? ""),
    stackId: typeof raw.stackId === "string" ? raw.stackId : undefined,
    status: String(raw.status ?? "PENDING") as DeploymentStatus,
    expiresAt: Number(raw.expiresAt ?? 0),
  };
}

async function processOne(shared: UpdaterSharedResources, item: TrackedDeployment): Promise<void> {
  if (!NON_TERMINAL_STATUSES.has(item.status)) return;
  if (!item.stackId) return; // Worker がまだ CFn を作っていない / markFailed 済

  const expired = expiredFor(shared.now(), item.expiresAt);

  let assumed: AssumedCredentials;
  try {
    assumed = await assumeRole(shared, item);
  } catch (err) {
    console.error("[status-updater] AssumeRole failed", {
      jobId: item.jobId,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const cfn = shared.cfnFactory(assumed, item.region);

  if (expired && item.status !== "DELETING") {
    await tearDown(shared, cfn, item);
    return;
  }

  let stack: Stack | undefined;
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: item.stackId }));
    stack = out.Stacks?.[0];
  } catch (err) {
    console.error("[status-updater] DescribeStacks failed", {
      jobId: item.jobId,
      stackId: item.stackId,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const { cfnStatus, stackStatusReason, outputs } = extractStackContext(stack);
  const resolved = resolveDeploymentStatus(item.status, cfnStatus, stackStatusReason);
  if (resolved.kind !== "transition") return;

  const stackOutputs = resolved.status === "COMPLETE" ? serializeStackOutputs(outputs) : undefined;
  await applyTransition(shared, item, resolved.status, resolved.failureReason, stackOutputs);
}

function expiredFor(nowMs: number, expiresAtSeconds: number): boolean {
  if (!expiresAtSeconds) return false;
  return nowMs / 1000 > expiresAtSeconds;
}

async function assumeRole(
  shared: UpdaterSharedResources,
  item: TrackedDeployment,
): Promise<AssumedCredentials> {
  const roleArn = `arn:aws:iam::${item.awsAccountId}:role/${shared.competitorRoleName}`;
  const out = await shared.sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `tenkacloud-su-${item.jobId}`,
      ExternalId: shared.externalId,
      DurationSeconds: 900,
    }),
  );
  const creds = out.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error("AssumeRole returned without credentials");
  }
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
}

async function tearDown(
  shared: UpdaterSharedResources,
  cfn: CloudFormationClient,
  item: TrackedDeployment,
): Promise<void> {
  try {
    await cfn.send(new DeleteStackCommand({ StackName: item.stackId }));
  } catch (err) {
    console.error("[status-updater] DeleteStack failed", {
      jobId: item.jobId,
      stackId: item.stackId,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  await applyTransition(shared, item, "DELETING", "auto_teardown_ttl", undefined);
}

async function applyTransition(
  shared: UpdaterSharedResources,
  item: TrackedDeployment,
  next: Exclude<DeploymentStatus, "PENDING">,
  failureReason: string | undefined,
  stackOutputs: string | undefined,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const update = buildTransitionUpdate(
    shared.tableName,
    item,
    next,
    failureReason,
    stackOutputs,
    updatedAt,
  );
  try {
    await shared.ddb.send(new UpdateCommand(update));
  } catch (err) {
    // ConditionalCheckFailed は他 Lambda が先に同じ遷移を書いた場合に起きる。
    // race の早い方を let-win としてここで silently 終了する。
    const code = (err as { name?: string })?.name ?? "";
    if (code === "ConditionalCheckFailedException") return;
    console.error("[status-updater] DDB Update failed", {
      jobId: item.jobId,
      next,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  await publishForTransition(shared, item, next, failureReason, stackOutputs);
}

function buildTransitionUpdate(
  tableName: string,
  item: TrackedDeployment,
  next: Exclude<DeploymentStatus, "PENDING">,
  failureReason: string | undefined,
  stackOutputs: string | undefined,
  updatedAt: string,
): UpdateCommandInput {
  const sets: string[] = ["#s = :next", "updatedAt = :updatedAt"];
  const values: Record<string, unknown> = {
    ":next": next,
    ":updatedAt": updatedAt,
    ":current": item.status,
  };
  if (failureReason !== undefined) {
    sets.push("failureReason = :reason");
    values[":reason"] = failureReason.slice(0, 1024);
  }
  if (stackOutputs !== undefined) {
    sets.push("stackOutputs = :outputs");
    values[":outputs"] = stackOutputs;
  }
  return {
    TableName: tableName,
    Key: { PK: `DEPLOYMENT#${item.jobId}`, SK: "META" },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "#s = :current",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: values,
  };
}

async function publishForTransition(
  shared: UpdaterSharedResources,
  item: TrackedDeployment,
  next: Exclude<DeploymentStatus, "PENDING">,
  failureReason: string | undefined,
  stackOutputs: string | undefined,
): Promise<void> {
  const detailType = DETAIL_TYPE_BY_STATUS[next as keyof typeof DETAIL_TYPE_BY_STATUS];
  if (!detailType) return;
  try {
    await publishProblemEvent({
      client: shared.events,
      busName: shared.eventBusName,
      detailType,
      jobId: item.jobId,
      detail: {
        jobId: item.jobId,
        tenantId: item.tenantId,
        status: next,
        failureReason,
        stackOutputs,
      },
    });
  } catch (err) {
    console.error("[status-updater] publish event failed", {
      jobId: item.jobId,
      detailType,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
