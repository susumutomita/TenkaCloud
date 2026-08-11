import {
  type AgentRunOutcome,
  type CloudActionAuditRecord,
  CloudFormationExecutor,
  CustomerExecutionAgent,
  CustomerExecutionPlane,
  type CustomerExecutionPolicy,
  combinePolicyEvaluators,
  createBudgetPolicyEvaluator,
  createCfnTemplateInspector,
  DdbNonceStore,
} from "@TenkaCloud/trust-bridge";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { buildCfnDeployClient, buildDdbConditionalPutClient } from "./aws-clients.js";
import { parseIntentMessage } from "./message.js";

/**
 * Issue #1727: customer execution plane の Lambda entry (SQS 駆動)。
 *
 * customer 側アカウントで動き、 hosted control plane が署名した CloudActionIntent を
 * SQS から受け、 **ローカル CFn 権限** で deploy/destroy する。 control plane が trust
 * する role は一切 AssumeRole しない (肝)。 trust-bridge の検証・実行・監査
 * ロジックに、 ここで実 SDK client を注入する。
 */

interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}
interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}
interface SqsBatchResponse {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

function csv(name: string): string[] {
  return env(name)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildPolicy(): CustomerExecutionPolicy {
  return {
    audience: env("PLANE_AUDIENCE"),
    allowedProviderAccountRefs: csv("ALLOWED_ACCOUNT_IDS"),
    allowedRegions: csv("ALLOWED_REGIONS"),
    approvedProblemIds: csv("APPROVED_PROBLEM_IDS"),
    allowPrivilegeEscalation: process.env.ALLOW_PRIVILEGE_ESCALATION === "true",
    maxTtlSeconds: Number(env("MAX_TTL_SECONDS")),
  };
}

/** verify 用 secret を SSM SecureString から 1 度だけ取得する (cold start)。 */
let cachedSecret: Promise<Uint8Array> | undefined;
function resolveVerifySecret(ssm: SSMClient): Promise<Uint8Array> {
  cachedSecret ??= (async () => {
    const out = await ssm.send(
      new GetParameterCommand({ Name: env("VERIFY_SECRET_PARAM"), WithDecryption: true }),
    );
    const value = out.Parameter?.Value;
    if (!value) {
      throw new Error("verify secret parameter is empty");
    }
    return new TextEncoder().encode(value);
  })();
  return cachedSecret;
}

async function buildAgent(): Promise<CustomerExecutionAgent> {
  const region = process.env.AWS_REGION;
  const clientConfig = region ? { region } : {};
  const secret = await resolveVerifySecret(new SSMClient(clientConfig));

  const nonceStore = new DdbNonceStore({
    client: buildDdbConditionalPutClient(new DynamoDBClient(clientConfig)),
    tableName: env("NONCE_TABLE_NAME"),
  });
  const plane = new CustomerExecutionPlane({
    policy: buildPolicy(),
    verify: { resolveSecret: () => secret, nonceStore },
    policyEvaluator: combinePolicyEvaluators(
      createBudgetPolicyEvaluator({
        maxEstimatedCostUsd: Number(process.env.MAX_ESTIMATED_COST_USD ?? "50"),
        policyVersion: process.env.POLICY_VERSION ?? "local-1",
      }),
    ),
    artifactInspector: createCfnTemplateInspector(),
  });
  const executor = new CloudFormationExecutor({
    client: buildCfnDeployClient(new CloudFormationClient(clientConfig)),
    ...(process.env.CFN_SERVICE_ROLE_ARN
      ? { executionRoleArn: process.env.CFN_SERVICE_ROLE_ARN }
      : {}),
  });
  return new CustomerExecutionAgent({ plane, executor, audit: emitAudit });
}

/** 監査レコードを構造化ログで出す (第 1 版: CloudWatch Logs)。 */
function emitAudit(record: CloudActionAuditRecord): void {
  console.log(JSON.stringify({ kind: "CloudActionAuditRecord", ...record }));
}

/**
 * 再試行すべきか。 deterministic な拒否 (authorization / artifact / policy) は redrive
 * しない (= 何度やっても同じ)。 authenticity 失敗のうち nonce-replay は「既に処理済み」
 * の正常系なので再試行不要。 それ以外の一時要因は handler の catch 側で redrive する。
 */
function shouldRetry(outcome: AgentRunOutcome): boolean {
  return (
    !outcome.ok && outcome.stage === "intent-authenticity" && outcome.reason !== "nonce-replay"
  );
}

let agentPromise: Promise<CustomerExecutionAgent> | undefined;

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  agentPromise ??= buildAgent();
  const agent = await agentPromise;
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const { token, templateBytes } = parseIntentMessage(record.body);
      const outcome = await agent.run({ token, artifact: { bytes: templateBytes } });
      if (shouldRetry(outcome)) {
        failures.push({ itemIdentifier: record.messageId });
      }
    } catch (err) {
      // 実行時例外 (= CFn API / DDB 一時障害 / parse 不能) は redrive させる。
      console.error(
        JSON.stringify({ kind: "ExecutionError", messageId: record.messageId, error: String(err) }),
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
