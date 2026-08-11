import type { NonceStore } from "./verify.js";

/**
 * Issue #1727: replay 防止を本番化する DDB-backed NonceStore。
 *
 * PoC は in-memory Set で nonce を覚えていたが、 Lambda は warm/cold・水平スケールで
 * memory を共有しないため replay 防止にならない。 本 store は **conditional PutItem**
 * (`attribute_not_exists(PK)`) で「同 nonce の 2 度目」を DDB レベルで弾く:
 *   - Put 成功               → "accepted" (= 初回)
 *   - ConditionalCheckFailed → "replay"   (= 既出 nonce)
 *   - それ以外のエラー        → rethrow (= fail loud。 silent fallback 禁止)
 *
 * TenkaCloud の DDB 1/1 PROVISIONED コスト制約に合わせ、 行は intent の expiresAt +
 * grace を **TTL 属性** に持たせて DynamoDB TTL に GC を任せる (= sweeper 不要)。
 * PK は `tenantId#requestId#nonce` で multi-tenant の nonce 衝突を構造的に防ぐ。
 *
 * `@aws-sdk/client-dynamodb` は hard dep にしない (= 既存 trust-bridge の方針)。
 * consumer (= customer-execution Lambda) が `PutItemCommand` を wrap した
 * {@link DdbConditionalPutClient} を注入する。 test では fake を渡す。
 */

export interface DdbConditionalPutInput {
  readonly TableName: string;
  readonly Item: Record<string, unknown>;
  /** 通常 `attribute_not_exists(PK)`。 既存なら ConditionalCheckFailed で reject される。 */
  readonly ConditionExpression: string;
}

/**
 * DynamoDB conditional PutItem を呼ぶ最小 seam。 production は
 * `DynamoDBDocumentClient.send(new PutCommand(input))` を wrap する。
 * 競合時は `name === "ConditionalCheckFailedException"` の error を reject すること。
 */
export interface DdbConditionalPutClient {
  putItem(input: DdbConditionalPutInput): Promise<void>;
}

export interface DdbNonceStoreOptions {
  readonly client: DdbConditionalPutClient;
  readonly tableName: string;
  /** intent.expiresAt に足す TTL 余裕 (秒)。 default 300 (= 5 min)。 */
  readonly ttlGraceSeconds?: number;
}

const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";
const DEFAULT_TTL_GRACE_SECONDS = 300;

/** DynamoDB の条件付き Put で nonce の単一消費を担保する {@link NonceStore}。 */
export class DdbNonceStore implements NonceStore {
  private readonly client: DdbConditionalPutClient;
  private readonly tableName: string;
  private readonly ttlGraceSeconds: number;

  constructor(options: DdbNonceStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.ttlGraceSeconds = options.ttlGraceSeconds ?? DEFAULT_TTL_GRACE_SECONDS;
  }

  async recordNonce(
    intent: Parameters<NonceStore["recordNonce"]>[0],
  ): Promise<"accepted" | "replay"> {
    const pk = `${intent.source.tenantId}#${intent.requestId}#${intent.nonce}`;
    const expiresAtEpoch =
      Math.floor(Date.parse(intent.constraints.expiresAt) / 1000) + this.ttlGraceSeconds;
    try {
      await this.client.putItem({
        TableName: this.tableName,
        Item: {
          PK: pk,
          SK: "NONCE",
          requestId: intent.requestId,
          nonce: intent.nonce,
          tenantId: intent.source.tenantId,
          // DynamoDB TTL 属性 (epoch 秒)。 期限切れ行を DDB が自動削除する。
          expiresAt: expiresAtEpoch,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      });
      return "accepted";
    } catch (err) {
      if ((err as { name?: string } | null)?.name === CONDITIONAL_CHECK_FAILED) {
        return "replay";
      }
      // 想定外エラーは握り潰さず投げる (= AGENTS.md: silent fallback 禁止)。
      throw err;
    }
  }
}
