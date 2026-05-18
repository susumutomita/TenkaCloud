import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Issue #950 (ADR-020 Phase D): admin 操作の append-only 監査ログ DDB Table。
 *
 * 旧状態: admin 操作 (= user 招待 / role 変更 / 削除、 SAML CRUD、 ExternalId rotate、 Event 削除 等) は
 * CloudWatch Logs に `console.log` で 1 行残るだけ。 「誰が・いつ・何を」 を後追いする集約 storage が
 * 無く、 audit 監査 (= 内部統制) を CloudWatch Logs Insights grep に依存。
 *
 * Schema:
 *   PK: TENANT#<tenantId>     (tenant 操作)
 *       SYSTEM#<env>          (SystemAdmin 操作、 tenant に紐づかないもの)
 *   SK: AUDIT#<ulid>
 *
 * 主な属性:
 *   - actor: Cognito sub (= 実行者)
 *   - actorUsername: cognito:username (= 通常 email、 検索性のため非正規化で持つ)
 *   - action: e.g. "patch_user_role" / "invite_user" / "rotate_external_id" / "delete_event"
 *   - outcome: "success" / "forbidden" / "not_found" / "error"
 *   - target: 対象 resource (= username / awsAccountId / eventId 等)
 *   - ipAddress: source IP (X-Forwarded-For)
 *   - userAgent: User-Agent header
 *   - occurredAt: ISO8601 (caller の Date.now() 由来)
 *   - ttl: 90 日後の unix timestamp (= 自動削除、 audit 要件は 90 日想定)
 *
 * provisioned 1/1 (DynamoDbLowCapacity Aspect で更に均す)。 audit write は admin 操作毎の 1 行で
 * 極低 QPS、 read は監査画面の paginate のみ。 Free Tier 25 RCU/WCU に十分収まる。
 *
 * 削除方針: RETAIN。 stack delete で audit 履歴を意図せず消さない (= 監査要件)。 必要なら手動。
 */
export class AdminAuditLogTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      // 90 日で自動削除 (= caller が `ttl` attribute に Date.now()/1000 + 90*86400 を入れる)
      timeToLiveAttribute: "ttl",
    });

    // GSI1: actor 別の audit query (= 「ユーザー X が何をしたか」 を 1 引きで)
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    });
  }
}
