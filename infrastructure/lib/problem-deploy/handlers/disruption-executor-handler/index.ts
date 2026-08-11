/**
 * [Issue #1419] cross-account disruption executor Lambda の entry。
 *
 * 実 client / AssumeRole を組み立てて `routeDisruptionInvocation` (= 純粋 router) に注入するだけの
 * 薄い glue (= describe-stack-handler/index.ts と同じ「testable service + real-deps entry」分離)。
 * 判断ロジック・dispatch mapping・scheduler 呼び出し・DDB アクセスはすべて test 済の module 側にあり、
 * ここは AWS SDK の構築と env 読取に閉じる。
 *
 * 2 経路で起動される (route が判別):
 *   - EventBridge `*DisruptionFired` rule → `{ detail }` envelope (= 注入)
 *   - aws-scheduler one-shot → `{ mode:"revert", dispatch, target }` (= 復旧)
 * revert / inject とも `wiredSendDispatch` が target から都度 AssumeRole する (= 注入時 creds は永続しない)。
 */

import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseDisruptionsCatalogEnv } from "../../../utils/discover-problems-catalog.js";
import { createDefaultControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { assumeCompetitorRole } from "../shared/assume-competitor-role.js";
import { logDeployTrace } from "../shared/trace-log.js";
import type { DeploymentTarget, ExecutorDeps } from "./execute.js";
import { claimExecution, type ExecutorResources, resolveDeployment } from "./executor-store.js";
import { type RouteOutcome, routeDisruptionInvocation } from "./route.js";
import { scheduleInject, scheduleRecurring, scheduleRevert } from "./schedule-revert.js";
import { type DispatchTarget, sendDispatch } from "./send-dispatch.js";

const SESSION_NAME_PREFIX = "tc-disruption-";
const GRACE_FALLBACK_TRACE = "deploy.disruption-executor.assume-role.grace-fallback";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const sts = new STSClient({});
const scheduler = new SchedulerClient({});

// [#2527 Slice 4] Composition root: one control-data runtime per Lambda instance.
const resources: ExecutorResources = {
  runtime: createDefaultControlDataRuntime(),
  ddb,
  deploymentsTableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
  disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
};

const problemsDisruptions = parseDisruptionsCatalogEnv(process.env.BATTLE_PROBLEMS_DISRUPTIONS);
const schedulerRoleArn = process.env.REVERT_SCHEDULER_ROLE_ARN ?? "";
const revertTargetArn = process.env.EXECUTOR_FUNCTION_ARN ?? "";

/** target から都度 AssumeRole して competitor account 内で dispatch を送る (= inject / revert 共通)。 */
async function wiredSendDispatch(
  dispatch: Parameters<ExecutorDeps["sendDispatch"]>[0],
  target: DeploymentTarget,
): Promise<void> {
  const credentials = await assumeCompetitorRole(
    { ssm, sts },
    {
      region: target.region,
      jobId: target.jobId,
      competitorRoleArn: target.competitorRoleArn,
      externalIdParameterName: target.externalIdParameterName,
      sessionNamePrefix: SESSION_NAME_PREFIX,
      graceFallbackTraceEvent: GRACE_FALLBACK_TRACE,
    },
  );
  const dispatchTarget: DispatchTarget = { region: target.region, credentials };
  await sendDispatch(dispatch, dispatchTarget, {
    ssmClient: (t) => new SSMClient(sdkClientConfig(t)),
    lambdaClient: (t) => new LambdaClient(sdkClientConfig(t)),
    cfnClient: (t) => new CloudFormationClient(sdkClientConfig(t)),
  });
}

/** STS Credentials (PascalCase) を SDK client config の camelCase credentials に写す (describe-stack と同方針)。 */
function sdkClientConfig(target: DispatchTarget) {
  const creds = target.credentials;
  return {
    region: target.region,
    ...(creds
      ? {
          credentials: {
            accessKeyId: creds.AccessKeyId ?? "",
            secretAccessKey: creds.SecretAccessKey ?? "",
            sessionToken: creds.SessionToken,
          },
        }
      : {}),
  };
}

const deps: ExecutorDeps = {
  problemsDisruptions,
  claimExecution: (detail, phase) => claimExecution(resources, detail, Date.now(), phase),
  resolveDeployment: (detail) => resolveDeployment(resources, detail),
  sendDispatch: wiredSendDispatch,
  scheduleRevert: (detail, dispatch, target, afterSeconds) =>
    scheduleRevert(dispatch, detail, target, afterSeconds, {
      scheduler,
      schedulerRoleArn,
      revertTargetArn,
    }),
  scheduleInject: (detail, afterMinutes) =>
    scheduleInject(detail, afterMinutes, { scheduler, schedulerRoleArn, revertTargetArn }),
  scheduleRecurring: (detail, intervalMinutes, maxFires) =>
    scheduleRecurring(detail, intervalMinutes, maxFires, {
      scheduler,
      schedulerRoleArn,
      revertTargetArn,
    }),
};

/** Lambda handler。 inject / revert を route が判別し dispatch する。 outcome は observability の trace に出す。 */
export async function handler(event: unknown): Promise<RouteOutcome> {
  const outcome = await routeDisruptionInvocation(event, deps);
  logDeployTrace("deploy.disruption-executor.outcome", { kind: outcome.kind });
  return outcome;
}
