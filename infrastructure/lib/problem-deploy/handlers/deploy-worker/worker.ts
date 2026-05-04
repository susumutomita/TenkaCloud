import {
  CloudFormationClient,
  CreateStackCommand,
  type CreateStackInput,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import {
  COMPETITOR_ROLE_NAME_DEFAULT,
  type DeployRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_FAILED,
  EVENT_DETAIL_TYPE_DEPLOY_STARTED,
  publishProblemEvent,
} from "../shared/events.js";
import { generateProblemSecret } from "./team-secret.js";
import { loadProblemTemplate } from "./templates.js";

export interface WorkerSharedResources {
  readonly tableName: string;
  readonly eventBusName: string;
  readonly competitorRoleName: string;
  readonly externalId: string;
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly sts: STSClient;
  /** target アカウントの一時 credentials で CFn client を作る factory。テストで DI 可能。 */
  readonly cfnFactory: (creds: AssumedCredentials, region: string) => CloudFormationClient;
  readonly readTemplate: (problemId: string) => string;
  readonly secretFactory: () => string;
}

export interface AssumedCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export function buildWorkerShared(): WorkerSharedResources {
  const tableName = getEnv("DEPLOYMENTS_TABLE_NAME");
  const eventBusName = getEnv("DEPLOY_EVENT_BUS_NAME");
  const competitorRoleName = process.env.COMPETITOR_ROLE_NAME ?? COMPETITOR_ROLE_NAME_DEFAULT;
  const externalId = getEnv("DEPLOY_EXTERNAL_ID");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const events = new EventBridgeClient({});
  const sts = new STSClient({});
  return {
    tableName,
    eventBusName,
    competitorRoleName,
    externalId,
    ddb,
    events,
    sts,
    cfnFactory: (creds, region) =>
      new CloudFormationClient({
        region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      }),
    readTemplate: (problemId) => loadProblemTemplate(problemId),
    secretFactory: () => generateProblemSecret(),
  };
}

const ALLOWED_CIDR_DEFAULT = "0.0.0.0/0";

/**
 * DeployRequested イベントを受けて、競技者アカウントへ問題 CFn を deploy する。
 *
 * AssumeRole / CreateStack / DDB Update のいずれかが失敗したら throw して Lambda 全体を
 * 失敗扱いにし (EventBridge retry / DLQ が拾える)、ベストエフォートで DDB FAILED 更新
 * + DeployFailed event publish (markFailed)。
 *
 * 重複 deploy 防止 (同一 namePrefix の同時起動拒否) は別途 conditional put で追加する想定。
 */
export async function handleDeployRequested(
  shared: WorkerSharedResources,
  detail: DeployRequestedDetail,
): Promise<void> {
  let assumed: AssumedCredentials;
  try {
    assumed = await assumeCompetitorRole(shared, detail);
  } catch (err) {
    await markFailed(shared, detail, "assume_role_failed", err);
    throw err;
  }

  const dbPassword = shared.secretFactory();
  const templateBody = shared.readTemplate(detail.problemId);

  let stackId: string;
  try {
    const cfn = shared.cfnFactory(assumed, detail.region);
    const input: CreateStackInput = {
      StackName: detail.namePrefix,
      TemplateBody: templateBody,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Parameters: [
        { ParameterKey: "NamePrefix", ParameterValue: detail.namePrefix },
        { ParameterKey: "DbPassword", ParameterValue: dbPassword },
        { ParameterKey: "AllowedCidr", ParameterValue: ALLOWED_CIDR_DEFAULT },
      ],
      Tags: [
        { Key: "TenkaCloud:JobId", Value: detail.jobId },
        { Key: "TenkaCloud:TenantId", Value: detail.tenantId },
        { Key: "TenkaCloud:ProblemId", Value: detail.problemId },
        { Key: "TenkaCloud:TeamName", Value: detail.teamName },
      ],
      OnFailure: "DELETE",
    };
    const out = await cfn.send(new CreateStackCommand(input));
    if (!out.StackId) throw new Error("CreateStack returned without StackId");
    stackId = out.StackId;
  } catch (err) {
    await markFailed(shared, detail, "create_stack_failed", err);
    throw err;
  }

  try {
    await Promise.all([
      shared.ddb.send(
        new UpdateCommand(buildSuccessUpdate(shared.tableName, detail, stackId, dbPassword)),
      ),
      publishProblemEvent({
        client: shared.events,
        busName: shared.eventBusName,
        detailType: EVENT_DETAIL_TYPE_DEPLOY_STARTED,
        jobId: detail.jobId,
        detail: {
          jobId: detail.jobId,
          tenantId: detail.tenantId,
          stackId,
          namePrefix: detail.namePrefix,
          awsAccountId: detail.awsAccountId,
          region: detail.region,
        },
      }),
    ]);
  } catch (err) {
    // CFn は既に走り出している。DDB / EventBus の post-success 同期に失敗しても
    // 状態が PENDING のままだと UI と乖離するので、failed 扱いに倒す + DLQ retry を効かせる。
    await markFailed(shared, detail, "post_create_sync_failed", err);
    throw err;
  }
}

function buildSuccessUpdate(
  tableName: string,
  detail: DeployRequestedDetail,
  stackId: string,
  dbPassword: string,
): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { PK: `DEPLOYMENT#${detail.jobId}`, SK: "META" },
    UpdateExpression:
      "SET #s = :status, stackId = :stackId, dbPassword = :dbPassword, updatedAt = :updatedAt",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":status": "IN_PROGRESS",
      ":stackId": stackId,
      ":dbPassword": dbPassword,
      ":updatedAt": new Date().toISOString(),
    },
  };
}

async function assumeCompetitorRole(
  shared: WorkerSharedResources,
  detail: DeployRequestedDetail,
): Promise<AssumedCredentials> {
  const roleArn = `arn:aws:iam::${detail.awsAccountId}:role/${shared.competitorRoleName}`;
  const out = await shared.sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `tenkacloud-${detail.jobId}`,
      ExternalId: shared.externalId,
      DurationSeconds: 3600,
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

async function markFailed(
  shared: WorkerSharedResources,
  detail: DeployRequestedDetail,
  reasonKey: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // DDB / EventBridge の更新は独立。片方が失敗しても他方は走らせる。
  const results = await Promise.allSettled([
    shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: `DEPLOYMENT#${detail.jobId}`, SK: "META" },
        UpdateExpression: "SET #s = :status, failureReason = :reason, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": "FAILED",
          ":reason": `${reasonKey}: ${message}`.slice(0, 1024),
          ":updatedAt": new Date().toISOString(),
        },
      }),
    ),
    publishProblemEvent({
      client: shared.events,
      busName: shared.eventBusName,
      detailType: EVENT_DETAIL_TYPE_DEPLOY_FAILED,
      jobId: detail.jobId,
      detail: {
        jobId: detail.jobId,
        tenantId: detail.tenantId,
        reason: reasonKey,
      },
    }),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[worker] markFailed downstream failed", {
        jobId: detail.jobId,
        reasonKey,
        err: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
}
