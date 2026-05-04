// Deploy completion handler — subscribes to problem.deploy.completed /
// problem.deploy.failed events emitted by the CodeBuild deploy pipeline and
// updates the corresponding GameDayDeploymentJob row in the shared DynamoDB
// table.
//
// Event detail shape (from scripts/codebuild/deploy-problem.sh emit_outcome):
//   {
//     deploymentKey: "<eventId>:<problemId>:<jobId>",
//     jobOutput: {
//       tenantData: {
//         deployStatus: "completed" | "failed",
//         stackName?: string,
//         stackId?: string,
//         errorReason?: string
//       }
//     }
//   }

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.DYNAMODB_TABLE_NAME;
if (!TABLE) {
  throw new Error("DYNAMODB_TABLE_NAME env var is required");
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function parseKey(deploymentKey) {
  if (typeof deploymentKey !== "string") {
    throw new Error(`deploymentKey is not a string: ${deploymentKey}`);
  }
  const [eventId, problemId, jobId] = deploymentKey.split(":");
  if (!eventId || !problemId || !jobId) {
    throw new Error(`deploymentKey must be "<eventId>:<problemId>:<jobId>", got ${deploymentKey}`);
  }
  return { eventId, problemId, jobId };
}

export const handler = async (event) => {
  // EventBridge rule with multiple detail-types delivers a single event per
  // invocation. Detail-type tells us success vs failure; the payload tells the rest.
  const detailType = event["detail-type"];
  const detail = event.detail ?? {};
  const tenantData = detail.jobOutput?.tenantData ?? {};

  const { eventId, problemId, jobId } = parseKey(detail.deploymentKey);

  const status =
    detailType === "problem.deploy.completed" || tenantData.deployStatus === "completed" ? "completed" : "failed";

  const now = new Date().toISOString();
  const updateExpr = ["SET #status = :status", "#updatedAt = :updatedAt", "#completedAt = :completedAt"];
  const exprAttrNames = {
    "#status": "status",
    "#updatedAt": "UpdatedAt",
    "#completedAt": "completedAt",
  };
  const exprAttrValues = {
    ":status": status,
    ":updatedAt": now,
    ":completedAt": now,
  };

  if (tenantData.stackName) {
    updateExpr.push("#stackName = :stackName");
    exprAttrNames["#stackName"] = "stackName";
    exprAttrValues[":stackName"] = tenantData.stackName;
  }
  if (tenantData.stackId) {
    updateExpr.push("#stackId = :stackId");
    exprAttrNames["#stackId"] = "stackId";
    exprAttrValues[":stackId"] = tenantData.stackId;
  }
  if (status === "failed" && tenantData.errorReason) {
    updateExpr.push("#error = :error");
    exprAttrNames["#error"] = "error";
    exprAttrValues[":error"] = tenantData.errorReason;
  }
  // Active GSI partition は active job だけが入る。完了 / 失敗 → 削除。
  const removeExpr = ["GSI1PK", "GSI1SK"];

  const params = {
    TableName: TABLE,
    Key: {
      PK: `GAMEDAY_DEPLOY#EVENT#${eventId}#PROBLEM#${problemId}`,
      SK: `JOB#${jobId}`,
    },
    UpdateExpression: `${updateExpr.join(", ")} REMOVE ${removeExpr.join(", ")}`,
    ExpressionAttributeNames: exprAttrNames,
    ExpressionAttributeValues: exprAttrValues,
    // Job が存在しない invalid event は no-op で良いので ConditionExpression は付けない。
    // (重複配信や順序違反でレース condition があり得るため、idempotent な UpdateItem に留める)
    ReturnValues: "NONE",
  };

  await ddb.send(new UpdateCommand(params));
  console.log(`[deploy-completion] eventId=${eventId} problemId=${problemId} jobId=${jobId} status=${status}`);
  return { statusCode: 200, body: "ok" };
};
