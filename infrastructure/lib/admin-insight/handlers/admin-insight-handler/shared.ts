import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { EventsRepository } from "../../../problem-deploy/control-data/events-repository.js";
import { controlDataRuntime } from "../../../problem-deploy/control-data/runtime-repositories.js";

/**
 * AdminInsight Lambda が module load で 1 度だけ作るリソース束。
 *
 * Lambda warm invoke で SDK client / connection pool を使い回すため、handler 外で
 * `buildSharedResources()` を呼ぶ。`DEPLOYMENTS_TABLE_NAME` が無い場合は **module 評価時に
 * throw** して `Initialization Error` で落とす (= 後段 routes が `undefined` 参照で意味不明な
 * 500 を返すよりは fail-fast)。[Issue #2440 / ADR-049 §5.1 Phase A5] `EVENTS_TABLE_NAME` /
 * `TEAMS_TABLE_NAME` は純 SQL backend (turso|sql) で table 自体が synth されないため対象外
 * (空文字 default、下記参照)。
 */
export interface AdminInsightSharedResources {
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
  readonly teamsTableName: string;
  readonly ddb: DynamoDBDocumentClient;
  /**
   * Issue #950 (ADR-020 Phase D): admin audit log table 名。 未配線時は空文字、
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`AdminInsight Lambda の env ${name} が未設定です`);
  }
  return value;
}

export function buildSharedResources(): AdminInsightSharedResources {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    deploymentsTableName: requireEnv("DEPLOYMENTS_TABLE_NAME"),
    // [Issue #2440 / ADR-049 §5.1 Phase A5] pure SQL backend (turso|sql) では Events/Teams
    // table 自体が synth されず env も配線されないため、module-load を fail-fast にすると cold
    // start が Initialization Error で落ちる。空文字 default に緩和し、dynamodb / mirror backend
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
 * [ADR-049 §5.1 / #2438] Events aggregate 専用 read seam (event-handler/shared.ts の
 * `resolveEventsRepository` と同型)。 default backend (`CONTROL_DATA_BACKEND` 未設定 =
 * dynamodb) では従来と byte 互換の Query を `shared.ddb` 経由で発火する。 admin-insight は
 * Events の read-only 集計のみ行う (mutating method は使わない) ため、 events-only seam で十分。
 *
 * [#2450] turso 対応済み: cold-start cache 済みの async resolver (`controlDataRuntime`) 経由で
 * 解決するため `CONTROL_DATA_BACKEND=turso|sql` でも動作する (read は Mirrored の canonical
 * passthrough)。 `AdminInsightApiLambdaProps.controlDataBackend` に `"turso"` を渡すと
 * `CONTROL_DATA_BACKEND` env が注入され、 SSM read 権限は `tursoAuthTokenParameterName` 指定時に
 * 付与される。 `Promise<EventsRepository>` を返すので caller は await する。
 */
export function resolveEventsRepository(
  shared: Pick<AdminInsightSharedResources, "ddb" | "eventsTableName">,
): Promise<EventsRepository> {
  return controlDataRuntime.resolveEventsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}
