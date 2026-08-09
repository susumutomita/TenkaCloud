import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { type DataTableProps, dataTableRemovalPolicy } from "./data-table-removal-policy.js";

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
 *   - ttl: env `AUDIT_RETENTION_DAYS` (= 90 default / SOC2 365) 後の unix timestamp
 *
 * provisioned 1/1 (DynamoDbLowCapacity Aspect で更に均す)。 audit write は admin 操作毎の 1 行で
 * 極低 QPS、 read は監査画面の paginate のみ。 Free Tier 25 RCU/WCU に十分収まる。
 *
 * 削除方針: 既定 DESTROY (#2959)。`CDK_PARAM_RETAIN_DATA_TABLES=true` のときだけ RETAIN。
 * 消し忘れた table が PROVISIONED 容量で課金され続けるほうが実害が大きい、という判断による。
 * 監査要件で履歴を残したい環境は opt-in で RETAIN にする。
 */
export class AdminAuditLogTable extends Construct {
  public readonly table: Table;

  constructor(scope: Construct, id: string, props: DataTableProps = {}) {
    super(scope, id);
    this.table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: props.removalPolicy ?? dataTableRemovalPolicy(undefined),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      // env `AUDIT_RETENTION_DAYS` (= 90 default / SOC2 365 等) を caller が ttl に書く。
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
