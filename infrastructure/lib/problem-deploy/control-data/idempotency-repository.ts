import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SqlExecutor } from "./sql-port.js";

/**
 * Issue #3002: `Idempotency-Key` の保存先。
 *
 * ## なぜ要るか
 *
 * `POST /problems/{problemId}/deploy` は毎回まっさらな `ulid()` を発行して `putDeployment` する
 * ため、 同じ deploy を 2 回 POST すると job が 2 本でき、 競技アカウント側に CloudFormation
 * stack が 2 つ作られる。 deploy はレスポンスまで時間がかかるので、 タイムアウトやネットワーク断で
 * 「送れたのか分からない」状況は普通に起きる。 クライアントから見ると再送は避けようがない。
 *
 * ## なぜ 2 backend あるか
 *
 * deployments repository は DynamoDB と SQL (Turso/libSQL) の 2 実装を持ち、 `/deploy` は
 * どちらでも動く。 DynamoDB だけに実装すると **Turso の環境は黙って無防備なまま**になり、
 * 「防げているように見えて防げていない」という最悪の壊れ方をする。 だから port を切って両方に
 * 実装し、 parity suite で同じ assertion を両方に流す。
 *
 * ## 排他の実現
 *
 * どちらも「先に書いた 1 本だけが勝つ」を storage の条件付き書き込みで担保する。 read してから
 * write する実装にはしない (並行リクエストが両方 read を抜けて両方 write できてしまう)。
 *
 * | backend | 手段 |
 * | --- | --- |
 * | DynamoDB | `attribute_not_exists(PK)` の条件付き put |
 * | SQL | PRIMARY KEY への INSERT (UNIQUE 違反で負けを検出) |
 *
 * ## 有効期限
 *
 * 24 時間。 恒久的な重複排除ではなく、 リトライを安全にするための短期の仕組みという Stripe の
 * 位置づけに合わせる。 DynamoDB は deployments table の TTL 属性 (`expiresAt`) に載せるので
 * 掃除は DynamoDB がやる。 SQLite に TTL は無いので、 読み出し側で期限切れを「無い」と扱う
 * (掃除しないと行が残るが、 期限切れの行は必ず無視されるので判定は狂わない)。
 */

/** 24h。 Stripe と同じ。 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Stripe と同じ上限。 これを超えるキーは受け付けない。 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly key: string;
  /** リクエスト本体のハッシュ。 同じキーで違う内容を送られたことを検出する。 */
  readonly requestHash: string;
  /** 1 回目のレスポンス。 まだ完了していなければ undefined (= 処理中)。 */
  readonly responseStatus?: number;
  readonly responseBody?: string;
  /** unix 秒。 DynamoDB の TTL 属性名と揃える。 */
  readonly expiresAt: number;
}

export type ReserveOutcome =
  /** このリクエストが 1 番乗り。 呼び出し側が実処理を進める。 */
  | { readonly kind: "reserved" }
  /** 既に同じキーがある。 `existing` の状態で replay か拒否かを決める。 */
  | { readonly kind: "conflict"; readonly existing: IdempotencyRecord };

export interface IdempotencyPort {
  /** 予約を試みる。 storage の条件付き書き込みで、 並行しても 1 本しか `reserved` にならない。 */
  reserve(record: IdempotencyRecord): Promise<ReserveOutcome>;
  /** 実処理の結果を書き込む。 以降の再送はこれを replay する。 */
  complete(tenantId: string, key: string, status: number, body: string): Promise<void>;
}

/** DynamoDB の item key。 deployments table に別 prefix で相乗りする (新 table を作らない)。 */
function ddbKey(tenantId: string, key: string) {
  return { PK: `IDEM#${tenantId}`, SK: `KEY#${key}` };
}

export class DynamoDbIdempotencyRepository implements IdempotencyPort {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tableName: string,
  ) {}

  async reserve(record: IdempotencyRecord): Promise<ReserveOutcome> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...ddbKey(record.tenantId, record.key),
            requestHash: record.requestHash,
            expiresAt: record.expiresAt,
          },
          // 条件付き put が排他の本体。 read してから write すると、 並行リクエストが
          // 両方とも read を抜けて両方 write できてしまう。
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { kind: "reserved" };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      const existing = await this.read(record.tenantId, record.key);
      // 条件で負けた直後に TTL で消えている、という競合はありうる。 そのときは
      // 「無かったこと」にせず conflict として扱い、 呼び出し側に再送を促す方へ倒す
      // (握り潰して実処理を走らせると二重実行になる)。
      return {
        kind: "conflict",
        existing: existing ?? { ...record, requestHash: record.requestHash },
      };
    }
  }

  async complete(tenantId: string, key: string, status: number, body: string): Promise<void> {
    const existing = await this.read(tenantId, key);
    if (!existing) return;
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...ddbKey(tenantId, key),
          requestHash: existing.requestHash,
          responseStatus: status,
          responseBody: body,
          expiresAt: existing.expiresAt,
        },
      }),
    );
  }

  private async read(tenantId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: ddbKey(tenantId, key) }),
    );
    const item = out.Item;
    if (!item) return undefined;
    return {
      tenantId,
      key,
      requestHash: String(item.requestHash ?? ""),
      responseStatus: typeof item.responseStatus === "number" ? item.responseStatus : undefined,
      responseBody: typeof item.responseBody === "string" ? item.responseBody : undefined,
      expiresAt: typeof item.expiresAt === "number" ? item.expiresAt : 0,
    };
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

/**
 * SQL 側の table。 `CREATE TABLE IF NOT EXISTS` で足す (deployments 系と同じやり方)。
 * PRIMARY KEY が排他そのもので、 2 本目の INSERT は UNIQUE 違反になる。
 */
export const IDEMPOTENCY_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS idempotency_records (` +
  `tenant_id TEXT NOT NULL, ` +
  `key TEXT NOT NULL, ` +
  `request_hash TEXT NOT NULL, ` +
  `response_status INTEGER, ` +
  `response_body TEXT, ` +
  `expires_at INTEGER NOT NULL, ` +
  `PRIMARY KEY (tenant_id, key))`;

export class SqlIdempotencyRepository implements IdempotencyPort {
  constructor(
    private readonly executor: SqlExecutor,
    /** 期限切れ判定に使う現在時刻 (unix 秒)。 test から固定するための seam。 */
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async reserve(record: IdempotencyRecord): Promise<ReserveOutcome> {
    // 期限切れの行が残っていると、 同じキーが二度と使えなくなる。 SQLite に TTL は無いので
    // INSERT の前に期限切れだけ消す (消し損ねても下の読み出し側で無視するので判定は狂わない)。
    await this.executor.run(
      "DELETE FROM idempotency_records WHERE tenant_id = ? AND key = ? AND expires_at <= ?",
      [record.tenantId, record.key, this.now()],
    );
    try {
      await this.executor.run(
        "INSERT INTO idempotency_records (tenant_id, key, request_hash, expires_at) VALUES (?, ?, ?, ?)",
        [record.tenantId, record.key, record.requestHash, record.expiresAt],
      );
      return { kind: "reserved" };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.read(record.tenantId, record.key);
      return { kind: "conflict", existing: existing ?? record };
    }
  }

  async complete(tenantId: string, key: string, status: number, body: string): Promise<void> {
    await this.executor.run(
      "UPDATE idempotency_records SET response_status = ?, response_body = ? WHERE tenant_id = ? AND key = ?",
      [status, body, tenantId, key],
    );
  }

  private async read(tenantId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.executor.get(
      "SELECT tenant_id, key, request_hash, response_status, response_body, expires_at " +
        "FROM idempotency_records WHERE tenant_id = ? AND key = ? AND expires_at > ?",
      [tenantId, key, this.now()],
    );
    if (!row) return undefined;
    return {
      tenantId,
      key,
      requestHash: String(row.request_hash ?? ""),
      responseStatus: typeof row.response_status === "number" ? row.response_status : undefined,
      responseBody: typeof row.response_body === "string" ? row.response_body : undefined,
      expiresAt: Number(row.expires_at ?? 0),
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.includes("UNIQUE constraint failed");
}
