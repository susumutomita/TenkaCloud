import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createEventsRepository,
  type EventsRepository,
} from "../../../problem-deploy/control-data/events-repository.js";

/**
 * AdminInsight Lambda が module load で 1 度だけ作るリソース束。
 *
 * Lambda warm invoke で SDK client / connection pool を使い回すため、handler 外で
 * `buildSharedResources()` を呼ぶ。env が無い場合は **module 評価時に throw** して
 * `Initialization Error` で落とす (= 後段 routes が `undefined` 参照で意味不明な 500 を
 * 返すよりは fail-fast)。
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
    eventsTableName: requireEnv("EVENTS_TABLE_NAME"),
    teamsTableName: requireEnv("TEAMS_TABLE_NAME"),
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
 * Events の read-only 集計のみ行う (mutating method は使わない) ため、 sync factory の
 * events-only seam で十分。
 *
 * **[#2437 と同じ既知の制約]** この resolver は sync factory なので Turso/SQL executor を
 * 組み立てられない。 `CONTROL_DATA_BACKEND=turso|sql` が渡ると `createEventsRepository` が
 * `deps.sql` 欠落で fail-loud に throw する (= 意図的。 silent に DynamoDB へ fallback しない — repo の
 * "no silent fallbacks" 原則)。 `AdminInsightApiLambdaProps.controlDataBackend` は現状どの caller
 * (`wire.ts` 含む) からも `"turso"` を渡されていないため到達しないが、 将来 SQL 対応が必要になったら
 * `event-handler/shared.ts` の async `resolveEventRepositories` と同様に SSM + libsql client 構築を
 * 別途スレッドすること (この sync 版のまま turso を有効化してはいけない)。
 */
export function resolveEventsRepository(
  shared: Pick<AdminInsightSharedResources, "ddb" | "eventsTableName">,
): EventsRepository {
  return createEventsRepository(process.env.CONTROL_DATA_BACKEND, {
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
}
