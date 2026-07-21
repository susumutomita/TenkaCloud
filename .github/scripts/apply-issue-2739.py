from pathlib import Path


SHARED_PATH = Path("infrastructure/lib/problem-deploy/handlers/event-handler/shared.ts")
IMPORT_ANCHOR = (
    'import type { AdminAuditLogRepository } from '
    '"../../control-data/admin-audit-log-repository.js";\n'
)
BACKEND_IMPORT = 'import { selectBackend } from "../../control-data/backend-config.js";\n'
TEARDOWN_MARKER = "/**\n * [ADR-047] 毎分 reconciler"
FOLLOWING_MARKER = "/**\n * [ADR-049 §5.1] Events"

SCHEDULED_RESOURCE_BUILDERS = '''/**
 * [ADR-047] 毎分 reconciler (generic-scoring Lambda) から `bulkTeardownEvent` を呼ぶための
 * 最小 `EventSharedResources`。 teardown は Events / Deployments / CompetitorAccounts table と
 * deploy event bus だけを使う (= Teams / problem catalog / S3 は不要)。 未使用 field は安全な
 * placeholder で埋める。
 *
 * **防御設計**: default DynamoDB backend では従来どおり table env が 1 つでも欠ければ
 * `undefined` を返して dormant にする。pure Turso backend は table 自体を synth しないため、注入済み
 * `ControlDataRuntime` が SQL repository を解決し、backend 非依存の bus / environment だけで有効化する
 * (#2739)。unknown backend は `selectBackend` が fail loud に拒否する。
 */
export function buildScheduledTeardownResources(
  runtime: ControlDataRuntime,
): EventSharedResources | undefined {
  const backend = selectBackend(process.env);
  const competitorAccountsTableName = process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const deploymentsTableName = process.env.DEPLOYMENTS_TABLE_NAME;
  const eventBusName = process.env.DEPLOY_EVENT_BUS_NAME;
  const env = process.env.DEPLOY_ENVIRONMENT;
  if (!eventBusName || !env) return undefined;
  if (
    backend.kind === "dynamodb" &&
    (!competitorAccountsTableName || !eventsTableName || !deploymentsTableName)
  ) {
    return undefined;
  }
  return {
    runtime,
    // Pure Turso has no DynamoDB tables. Repository seams ignore these placeholders and resolve
    // through the injected SQL runtime; DynamoDB reached this point only with every name present.
    eventsTableName: eventsTableName ?? "",
    deploymentsTableName: deploymentsTableName ?? "",
    competitorAccountsTableName: competitorAccountsTableName ?? "",
    eventBusName,
    env,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    // teardown 未使用 field の placeholder (bulkTeardownEvent は参照しない)。
    teamsTableName: "",
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    adminAuditLogTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    problemsCatalog: {},
    problemsDisruptions: {},
    problemsProvenance: {},
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
    // [#2571] generic-scoring Lambda は sakura/azure/gcp credential parameter への
    // ssm:GetParameter + kms:Decrypt grant を既に持つ (generic-scoring-lambda.ts) ため、
    // ここで wire しても新規 IAM は不要。 未 wire のままだと非 AWS single-provider 行の
    // scheduled bulk teardown が adapter.destroy に届かず leak する (#2571 の core bug)。
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
  };
}

/**
 * [ADR-047 follow-up] 毎分 reconciler (generic-scoring Lambda) から `bulkDeployEvent` を呼ぶための
 * `EventSharedResources` (teardown の鏡像)。 bulk deploy は Events / Deployments / Teams /
 * CompetitorAccounts table と deploy event bus + problem catalog を使う (= teardown より広い)。
 *
 * **防御設計**: problem catalog / bus / environment は backend 共通で必須。default DynamoDB
 * backend は Teams を含む 4 table env も必須のままにし、1 つでも欠ければ dormant にする。pure Turso
 * backend は table env を synth しないため、空 placeholder と注入済み SQL runtime で repository seam を
 * 通す (#2739)。`bulkDeployEvent` の problemId→problemDir 解決には catalog が引き続き必須。
 */
export function buildScheduledDeployResources(
  runtime: ControlDataRuntime,
): EventSharedResources | undefined {
  const backend = selectBackend(process.env);
  const competitorAccountsTableName = process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const deploymentsTableName = process.env.DEPLOYMENTS_TABLE_NAME;
  const teamsTableName = process.env.TEAMS_TABLE_NAME;
  const eventBusName = process.env.DEPLOY_EVENT_BUS_NAME;
  const env = process.env.DEPLOY_ENVIRONMENT;
  const problemsCatalog = parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG);
  if (!eventBusName || !env || Object.keys(problemsCatalog).length === 0) return undefined;
  if (
    backend.kind === "dynamodb" &&
    (!competitorAccountsTableName || !eventsTableName || !deploymentsTableName || !teamsTableName)
  ) {
    return undefined;
  }
  return {
    runtime,
    // Pure Turso has no DynamoDB tables. Repository seams ignore these placeholders and resolve
    // through the injected SQL runtime; DynamoDB reached this point only with every name present.
    eventsTableName: eventsTableName ?? "",
    deploymentsTableName: deploymentsTableName ?? "",
    teamsTableName: teamsTableName ?? "",
    competitorAccountsTableName: competitorAccountsTableName ?? "",
    eventBusName,
    env,
    problemsCatalog,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    events: new EventBridgeClient({}),
    s3: new S3Client({}),
    scheduler: new SchedulerClient({}),
    // deploy 未使用 field の placeholder (bulkDeployEvent fan-out 経路は参照しない)。
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    adminAuditLogTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    problemsDisruptions: {},
    problemsProvenance: {},
    // Distributed Map 経路は EventApiLambda 専用 (= S3 bucket env)。 reconciler は旧 fan-out
    // 経路 (N×M DeployCreateRequested publish) を使うので bucket 不要 / flag は false 固定。
    bulkDeployPayloadBucket: "",
    useBulkDistributedMap: false,
    // [#2571] teardown 側と同じく generic-scoring Lambda は sakura/azure/gcp credential
    // grant を既に持つ。 未 wire のままだと scheduled bulk deploy が非 AWS single-provider
    // 問題の v1 unsupportedRuntime gate すら通らず silent skip する (#2571 の core bug —
    // resolveProblemRuntimeDescriptor 自体も未配線だったため)。
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
    resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
      process.env.BATTLE_PROBLEMS_RUNTIMES,
    ),
  };
}

'''


def main() -> None:
    source = SHARED_PATH.read_text()
    if BACKEND_IMPORT not in source:
        if source.count(IMPORT_ANCHOR) != 1:
            raise SystemExit("shared.ts import anchor was not found exactly once")
        source = source.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + BACKEND_IMPORT, 1)

    start = source.find(TEARDOWN_MARKER)
    end = source.find(FOLLOWING_MARKER, start)
    if start < 0 or end < 0 or end <= start:
        raise SystemExit("scheduled-resource builder block markers were not found")

    source = source[:start] + SCHEDULED_RESOURCE_BUILDERS + source[end:]
    SHARED_PATH.write_text(source)


if __name__ == "__main__":
    main()
