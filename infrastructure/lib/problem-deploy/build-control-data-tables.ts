import { CfnOutput } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { AdminAuditLogTable } from "./admin-audit-log-table.js";
import { CompetitorAccountsTable } from "./competitor-accounts-table.js";
import { dataTableRemovalPolicy } from "./data-table-removal-policy.js";
import { DeploymentsTable } from "./deployments-table.js";
import { DisruptionsTable } from "./disruptions-table.js";
import { EventCapacityRunbook } from "./event-capacity-runbook.js";
import { EventsTable } from "./events-table.js";
import { ProblemEndpointsTable } from "./problem-endpoints-table.js";
import { TeamsTable } from "./teams-table.js";

export interface BuildControlDataTablesArgs {
  /**
   * [Issue #2440 / #2441 / #2442] `controlDataBackend` が純 SQL (`turso`) のとき true。
   * 7 つの control-data DDB table を一切 synth しない (= DynamoDB standing cost をゼロにする)。
   * `dynamodb` (default) では従来どおりテーブルを作る。
   */
  readonly pureSql: boolean;
  /**
   * [Issue #2959] table を stack 削除後も残すか。未指定 / false は DESTROY (= 既定)。
   * `AppConfig.retainDataTables` をそのまま渡す。
   */
  readonly retainDataTables?: boolean;
}

export interface ControlDataTablesOutputs {
  readonly deployments?: DeploymentsTable;
  readonly events?: EventsTable;
  readonly teams?: TeamsTable;
  readonly endpoints?: ProblemEndpointsTable;
  readonly competitorAccounts?: CompetitorAccountsTable;
  readonly disruptions?: DisruptionsTable;
  readonly adminAuditLog?: AdminAuditLogTable;
  /**
   * Issue #2410 Slice 1 の SSM Automation Runbook document 名。EventApiLambda の
   * `GET /admin/capacity` が実行コマンド例の表示に使う。
   */
  readonly capacityRunbookDocumentName?: string;
  /**
   * Issue #2680: runbook の least-privilege automation role ARN。EventApi Lambda の
   * `POST /admin/capacity` (StartAutomationExecution) が document default の
   * `AutomationAssumeRole` を渡すのに必要な `iam:PassRole` の対象として使う。
   */
  readonly capacityRunbookAutomationRoleArn?: string;
}

/**
 * [#2527 Slice 5] Control-data resources subsystem: the seven conditional DynamoDB tables,
 * the event-capacity SSM Automation runbook that operates them, and their table-name
 * CfnOutputs — extracted verbatim from `ProblemDeployBackendStack`'s constructor.
 *
 * `scope` MUST be the stack instance itself (all construct IDs below are unprefixed,
 * exactly as they were inline) — moving this to a nested construct would change every
 * logical ID beneath it (data-loss-class REPLACE on every table), same constraint as
 * `buildDeployPipeline`.
 */
export function buildControlDataTables(
  scope: Construct,
  args: BuildControlDataTablesArgs,
): ControlDataTablesOutputs {
  const { pureSql } = args;
  // [Issue #2959] 8 table 共通の削除方針。既定 DESTROY、opt-in で RETAIN。
  const tableProps = { removalPolicy: dataTableRemovalPolicy(args.retainDataTables) };

  // Event / Team の 2 Table を Deployments と並列に持つ。
  // Phase 2 で Bulk Deploy / Bulk Teardown を State Machine 経由で動かす。
  //
  // [Issue #2440] `controlDataBackend` が純 SQL (`turso`) の
  // ときは Events/Teams を **synth しない** — DynamoDB standing cost (Events+Teams+GSI 3本 =
  // 5 ユニット常時) をゼロにする。
  //
  // [Issue #2441 / Phase B PR-6] 同じ条件で Deployments も **synth しない**。GSI3本を持つ単体
  // 最大のコスト源 (テーブル+GSI=4ユニット常時) をゼロにする。62 handler サイト + SFN 書き戻し
  // (Phase B PR-1〜5) が既に repository seam を経由しているため、pure SQL では本 table への
  // 参照が残らない (壊れる参照は呼び出し側で個別に条件化)。
  const deployments = pureSql ? undefined : new DeploymentsTable(scope, "Deployments", tableProps);
  const events = pureSql ? undefined : new EventsTable(scope, "Events", tableProps);
  const teams = pureSql ? undefined : new TeamsTable(scope, "Teams", tableProps);
  // Endpoint registry。per (tenant, team, problem, slot) で override
  // URL を保管する。default URL は read-through で deployment.stackOutputs から算出。
  //
  // [Issue #2442 / Phase C1] `controlDataBackend` が純 SQL (`turso`) のときは Events/Teams/
  // Deployments と同条件で **synth しない**。62 handler サイトが repository seam
  // (`resolveProblemEndpointsRepository`) 経由で読み書きするため、pure SQL では本 table への
  // 参照が残らない。
  const endpoints = pureSql
    ? undefined
    : new ProblemEndpointsTable(scope, "ProblemEndpoints", tableProps);
  // Issue #459: tenant ↔ 競技者 AWS account の許可表。
  // 1 行 = 1 (tenantId, awsAccountId)。verified=false は deploy 不可。
  //
  // [Issue #2442 / Phase C2] 純 SQL backend では Events/Teams/Deployments/ProblemEndpoints と
  // 同条件で **synth しない**。7 handler サイトが repository seam
  // (`resolveCompetitorAccountsRepository` / `resolveSamlConfigRepository`) 経由で読み書きする。
  const competitorAccounts = pureSql
    ? undefined
    : new CompetitorAccountsTable(scope, "CompetitorAccounts", tableProps);
  // Issue #888: Red Team Disruption Injection の audit log + idempotency
  //
  // [Issue #2442 / Phase C3] 純 SQL backend では同条件で **synth しない**。4 handler サイト
  // (disruption-fire.ts / disruption-recurring.ts / executor-store.ts / generic-scoring index.ts)
  // が repository seam (`resolveDisruptionsRepository`) 経由で読み書きする。
  const disruptions = pureSql ? undefined : new DisruptionsTable(scope, "Disruptions", tableProps);
  // Issue #950: admin 操作の append-only 監査ログ。 6 handler Lambda +
  // admin-insight Lambda が read/write する。 TTL 90 日で自動 GC (= env `AUDIT_RETENTION_DAYS`
  // で 365 / SOC2 enterprise 用に上げる)。
  //
  // [Issue #2442 / Phase C4] 純 SQL backend では同条件で **synth しない**。 write 元 6 Lambda
  // (deploy-api / event-api / competitor-accounts-api / system-audit-writer / sign-in-audit /
  // admin-insight) は全て repository seam (`writeAuditEvent` / `resolveAdminAuditLogRepository`)
  // 経由で読み書きする。
  const adminAuditLog = pureSql
    ? undefined
    : new AdminAuditLogTable(scope, "AdminAuditLog", tableProps);

  // Issue #2410 Slice 1: イベント中の DynamoDB キャパシティを運営が明示的に上げ下げする
  // SSM Automation Runbook。event-hot 5 テーブル (Deployments / Events / Teams /
  // ProblemEndpoints / Disruptions) に allowedValues + IAM resource の二重で固定し、
  // ハード上限 ceiling (200) で課金爆死を構造的に防ぐ。オートスケーリングは採用しない。
  //
  // この配列が event-hot テーブルの唯一の stack 側 source。handler 側の対応 (capacity.ts
  // `resolveEventHotTables`) と運用 doc (docs/operations/dynamodb-event-capacity.md) の表は
  // この並びと揃えること (増減時は 3 箇所同時に更新)。
  //
  // Issue #2440 / #2441 / #2442: 純 SQL backend では Events/Teams/Deployments/ProblemEndpoints
  // が無いので runbook の allowedValues / IAM からも除外する (= filter で undefined を落とす。
  // 存在しない table を runbook 対象にしない)。
  const eventHotTables = [
    deployments?.table,
    events?.table,
    teams?.table,
    endpoints?.table,
    disruptions?.table,
  ].filter((t): t is Table => t !== undefined);
  let capacityRunbookDocumentName: string | undefined;
  let capacityRunbookAutomationRoleArn: string | undefined;
  if (eventHotTables.length > 0) {
    const capacityRunbook = new EventCapacityRunbook(scope, "EventCapacityRunbook", {
      eventHotTables,
    });
    capacityRunbookDocumentName = capacityRunbook.documentName;
    // Issue #2680: EventApi Lambda が `POST /admin/capacity` で document default の
    // AutomationAssumeRole を渡すための iam:PassRole 対象。
    capacityRunbookAutomationRoleArn = capacityRunbook.automationRoleArn;
    new CfnOutput(scope, "EventCapacityRunbookName", {
      value: capacityRunbook.documentName,
      description:
        "Issue #2410 SSM Automation document 名。aws ssm start-automation-execution --document-name に渡してイベント中のキャパを上げ下げする。",
    });
  }

  // Issue #2440 / #2441 / #2442: 純 SQL backend では table 自体が無いので output も作らない
  // (存在しない論理 ID を参照する CfnOutput は synth できない)。
  if (deployments) {
    new CfnOutput(scope, "DeploymentsTableName", {
      value: deployments.table.tableName,
      description: "Deploy ジョブを記録する DynamoDB テーブル名。",
    });
  }
  if (events) {
    new CfnOutput(scope, "EventsTableName", {
      value: events.table.tableName,
      description: "Events table 名 (1 競技イベント = 1 行)。",
    });
  }
  if (teams) {
    new CfnOutput(scope, "TeamsTableName", {
      value: teams.table.tableName,
      description: "Teams table 名 (1 チーム = 1 行、teamLoginKey は team scope)。",
    });
  }
  if (competitorAccounts) {
    new CfnOutput(scope, "CompetitorAccountsTableName", {
      value: competitorAccounts.table.tableName,
      description: "Issue #459 Competitor Accounts table 名 (tenant ↔ 競技者 AWS account 紐付け)。",
    });
  }
  if (endpoints) {
    new CfnOutput(scope, "ProblemEndpointsTableName", {
      value: endpoints.table.tableName,
      description:
        "Endpoint registry table 名 (per (tenant, team, problem, slot) の override 行)。",
    });
  }

  return {
    deployments,
    events,
    teams,
    endpoints,
    competitorAccounts,
    disruptions,
    adminAuditLog,
    capacityRunbookDocumentName,
    capacityRunbookAutomationRoleArn,
  };
}
