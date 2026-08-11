import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AdminAuditLogRepository } from "../../../problem-deploy/control-data/admin-audit-log-repository.js";
import type { DeploymentsRepository } from "../../../problem-deploy/control-data/deployments-repository.js";
import type { EventsRepository } from "../../../problem-deploy/control-data/events-repository.js";
import type { ControlDataRuntime } from "../../../problem-deploy/control-data/runtime-repositories.js";

/**
 * AdminInsight Lambda が module load で 1 度だけ作るリソース束。
 *
 * Lambda warm invoke で SDK client / connection pool を使い回すため、handler 外で
 * `buildSharedResources` を呼ぶ。[Issue #2440] `EVENTS_TABLE_NAME` /
 * `TEAMS_TABLE_NAME` は純 SQL backend (turso) で table 自体が synth されないため対象外
 * (空文字 default、下記参照)。[Issue #2441 / Phase B PR-6] `DEPLOYMENTS_TABLE_NAME` も同じ
 * 条件で synth されないため、同じ空文字 default に統一した (以前は module 評価時に throw して
 * いたが、それだと turso backend で AdminInsight Lambda 自体が Initialization Error で落ちる)。
 * dynamodb backend の誤設定は runtime resolver (`runtime-repositories.ts`) が fail
 * loud に受ける (= silent fallback にはならない)。
 */
export interface AdminInsightSharedResources {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /**
   * Issue #950: admin audit log table 名。 未配線時は空文字、
   * handler の audit route が 503 を返す。
   */
  readonly auditTableName: string;
  /**
   * Issue #1765: tenant usage facts table. 未配線時は空文字、 handler の usage route が
   * 503 を返す。
   */
  readonly usageTableName: string;
  /** Issue #950: 環境名 (= SYSTEM 操作の PK 構築に使う `SYSTEM#<env>`)。 */
  readonly environmentName: string;
}

export function buildSharedResources(runtime: ControlDataRuntime): AdminInsightSharedResources {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    runtime,
    // [Issue #2441 / Phase B PR-6] pure SQL backend (turso) では Deployments table 自体が
    // synth されず env も配線されない。EVENTS_TABLE_NAME/TEAMS_TABLE_NAME と同じ空文字 default。
    deploymentsTableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
    // [Issue #2440] pure SQL backend (turso) では Events/Teams
    // table 自体が synth されず env も配線されないため、module-load を fail-fast にすると cold
    // start が Initialization Error で落ちる。空文字 default に緩和し、dynamodb backend
    // の誤設定は runtime resolver (`runtime-repositories.ts`) が fail loud に受ける (= silent
    // fallback にはならない)。
    eventsTableName: process.env.EVENTS_TABLE_NAME ?? "",
    teamsTableName: process.env.TEAMS_TABLE_NAME ?? "",
    ddb,
    // Issue #950: 未配線時は空文字。 caller (audit route) が 503 を返す。
    auditTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    usageTableName: process.env.USAGE_FACTS_TABLE_NAME ?? "",
    environmentName: process.env.DEPLOY_ENVIRONMENT ?? "development",
  };
}

/**
 * [#2438] Events aggregate 専用 read seam (event-handler/shared.ts の
 * `resolveEventsRepository` と同型)。 default backend (`CONTROL_DATA_BACKEND` 未設定 =
 * dynamodb) では従来と byte 互換の Query を `shared.ddb` 経由で発火する。 admin-insight は
 * Events の read-only 集計のみ行う (mutating method は使わない) ため、 events-only seam で十分。
 *
 * [#2450] turso 対応済み: cold-start cache 済みの async resolver (injected `shared.runtime`) 経由で
 * 解決するため `CONTROL_DATA_BACKEND=turso` (pure SQL) でも動作する。
 * `AdminInsightApiLambdaProps.controlDataBackend` に `"turso"` を渡すと
 * `CONTROL_DATA_BACKEND` env が注入され、 SSM read 権限は `tursoAuthTokenParameterName` 指定時に
 * 付与される。 `Promise<EventsRepository>` を返すので caller は await する。
 */
export function resolveEventsRepository(
  shared: Pick<AdminInsightSharedResources, "runtime" | "ddb" | "eventsTableName">,
): Promise<EventsRepository> {
  return shared.runtime.resolveEventsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}

/**
 * [Issue #2441 / Phase B PR-6] Deployments aggregate 専用 read seam (mirror of
 * {@link resolveEventsRepository}). `summary.ts`'s `countTenantDeployments` uses
 * this instead of a raw GSI1 `QueryCommand` so tenant deploy-status counts keep
 * working when `controlDataBackend` is pure SQL (turso) — the previous raw
 * query hard-coded `TableName: shared.deploymentsTableName`, which is `""` once
 * the Deployments table is no longer synthesized. default backend (`dynamodb`)
 * stays byte-identical to the pre-seam Query it replaces, other than splitting
 * one full-item Query into two `Select=COUNT` queries (see `countActiveByTenant`).
 */
export function resolveDeploymentsRepository(
  shared: Pick<AdminInsightSharedResources, "runtime" | "ddb" | "deploymentsTableName">,
): Promise<DeploymentsRepository> {
  return shared.runtime.resolveDeploymentsRepository({
    ddb: shared.ddb,
    deploymentsTableName: shared.deploymentsTableName,
  });
}

/**
 * [Issue #2442 / Phase C4] AdminAuditLog read seam for the SystemAdmin cross-tenant `/admin/
 * insight/audit` route (mirror of {@link resolveDeploymentsRepository}). default backend
 * (`CONTROL_DATA_BACKEND` unset = dynamodb) stays byte-identical to the pre-seam Query; turso
 * works via the same cold-start-cached async resolver every other seam in this module uses.
 */
export function resolveAdminAuditLogRepository(
  shared: Pick<AdminInsightSharedResources, "runtime" | "ddb" | "auditTableName">,
): Promise<AdminAuditLogRepository> {
  return shared.runtime.resolveAdminAuditLogRepository({
    ddb: shared.ddb,
    adminAuditLogTableName: shared.auditTableName,
  });
}
