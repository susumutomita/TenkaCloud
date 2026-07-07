import { Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDocument } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import {
  EVENT_CAPACITY_CEILING,
  EVENT_CAPACITY_PARAM_PATTERN,
} from "./event-capacity-constants.js";

/**
 * SSM aws:executeScript 本体。describe → 差分のある base table / GSI だけ UpdateTable する。
 * parameter validation (allowedPattern) をすり抜ける経路 (例: 手動で document を別 role から
 * 実行) への defense in depth として、script 内でも ceiling を assert する。
 */
const RUNBOOK_SCRIPT = `import boto3

CEILING = ${EVENT_CAPACITY_CEILING}


def handler(event, context):
    table_name = event["TableName"]
    rcu = int(event["ReadCapacityUnits"])
    wcu = int(event["WriteCapacityUnits"])
    for label, value in (("ReadCapacityUnits", rcu), ("WriteCapacityUnits", wcu)):
        if value < 1 or value > CEILING:
            raise ValueError(
                f"{label}={value} is outside the allowed range 1..{CEILING}"
            )
    ddb = boto3.client("dynamodb")
    desc = ddb.describe_table(TableName=table_name)["Table"]
    update = {"TableName": table_name}
    changed = []
    base = desc["ProvisionedThroughput"]
    if base["ReadCapacityUnits"] != rcu or base["WriteCapacityUnits"] != wcu:
        update["ProvisionedThroughput"] = {
            "ReadCapacityUnits": rcu,
            "WriteCapacityUnits": wcu,
        }
        changed.append("table")
    gsi_updates = []
    for gsi in desc.get("GlobalSecondaryIndexes", []):
        current = gsi["ProvisionedThroughput"]
        if current["ReadCapacityUnits"] != rcu or current["WriteCapacityUnits"] != wcu:
            gsi_updates.append(
                {
                    "Update": {
                        "IndexName": gsi["IndexName"],
                        "ProvisionedThroughput": {
                            "ReadCapacityUnits": rcu,
                            "WriteCapacityUnits": wcu,
                        },
                    }
                }
            )
            changed.append(gsi["IndexName"])
    if gsi_updates:
        update["GlobalSecondaryIndexUpdates"] = gsi_updates
    if not changed:
        return {"changed": changed, "message": "already at requested capacity"}
    ddb.update_table(**update)
    return {"changed": changed, "message": "UpdateTable issued"}
`;

export interface EventCapacityRunbookProps {
  /**
   * イベント中に read/write が集中する (= event-hot) テーブル群。runbook の `TableName`
   * parameter は `allowedValues` でこの 5 テーブル名に構造的に固定され、automation role の
   * IAM resource もこの ARN 群に限定される (= 他テーブルへの適用は二重に不可能)。
   */
  readonly eventHotTables: readonly Table[];
}

/**
 * Issue #2410 Slice 1: イベント中の DynamoDB キャパシティを運営が明示的に上げ下げする
 * SSM Automation Runbook (bounded / logged / deliberate)。
 *
 * 課金爆死ガード (4 層):
 *  1. PROVISIONED のまま (on-demand へは切替えない) — リクエスト激増は throttle するだけ
 *  2. ハード上限 {@link EVENT_CAPACITY_CEILING} — parameter `allowedPattern` と script 内
 *     assert の二重化。桁打ち間違いは実行前に fail
 *  3. 手動 SSM 実行 = 実行履歴 (StartAutomationExecution) が必ず残る
 *  4. イベント後の明示 scale-down (同 runbook で 1/1 に戻す)。CFn がテーブルを次に UPDATE
 *     する deploy でも template の 1/1 に収斂する
 *
 * 実行例 (Slice 3 の運用 doc `docs/operations/dynamodb-event-capacity.md` を参照):
 *   aws ssm start-automation-execution \
 *     --document-name <EventCapacityRunbookName output> \
 *     --parameters TableName=<table>,ReadCapacityUnits=25,WriteCapacityUnits=10
 */
export class EventCapacityRunbook extends Construct {
  /** `aws ssm start-automation-execution --document-name` に渡す SSM document 名。 */
  public readonly documentName: string;
  /** Automation が AssumeRole する最小権限 role の ARN。 */
  public readonly automationRoleArn: string;

  constructor(scope: Construct, id: string, props: EventCapacityRunbookProps) {
    super(scope, id);

    const tableArns = props.eventHotTables.map((t) => t.tableArn);
    const tableNames = props.eventHotTables.map((t) => t.tableName);

    // 最小権限: event-hot 5 テーブルへの DescribeTable (差分検出) + UpdateTable (キャパ変更) のみ。
    // UpdateTable の GSI キャパ変更も IAM resource は table ARN (index ARN は不要)。
    const automationRole = new Role(this, "AutomationRole", {
      assumedBy: new ServicePrincipal("ssm.amazonaws.com"),
      description:
        "Least-privilege role for the event capacity runbook: DescribeTable/UpdateTable on event-hot tables only",
      inlinePolicies: {
        EventCapacity: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:DescribeTable", "dynamodb:UpdateTable"],
              resources: tableArns,
            }),
          ],
        }),
      },
    });

    // Document 名は stack 名から決定的に導出する (= 運用 doc / CLI にそのまま書ける)。
    // 明示名付き CfnDocument の更新は NewVersion 方式 (in-place で新 version を発行)。
    const documentName = `${Stack.of(this).stackName}-event-capacity`;
    const document = new CfnDocument(this, "Document", {
      documentType: "Automation",
      name: documentName,
      updateMethod: "NewVersion",
      content: {
        schemaVersion: "0.3",
        description:
          "TenkaCloud event capacity runbook (Issue #2410). Scales the provisioned RCU/WCU of one event-hot DynamoDB table (base table + all GSIs) within the hard ceiling. Scale down to 1/1 after the event with the same document.",
        assumeRole: "{{ AutomationAssumeRole }}",
        parameters: {
          TableName: {
            type: "String",
            description: "Event-hot table to scale (allowed values are pinned at synth time).",
            allowedValues: tableNames,
          },
          ReadCapacityUnits: {
            type: "String",
            description: `Target RCU for the base table and every GSI (1..${EVENT_CAPACITY_CEILING}).`,
            allowedPattern: EVENT_CAPACITY_PARAM_PATTERN,
          },
          WriteCapacityUnits: {
            type: "String",
            description: `Target WCU for the base table and every GSI (1..${EVENT_CAPACITY_CEILING}).`,
            allowedPattern: EVENT_CAPACITY_PARAM_PATTERN,
          },
          AutomationAssumeRole: {
            type: "String",
            description:
              "IAM role the automation assumes (defaults to the bundled least-privilege role).",
            default: automationRole.roleArn,
          },
        },
        mainSteps: [
          {
            name: "UpdateProvisionedCapacity",
            action: "aws:executeScript",
            isEnd: true,
            inputs: {
              Runtime: "python3.11",
              Handler: "handler",
              Script: RUNBOOK_SCRIPT,
              InputPayload: {
                TableName: "{{ TableName }}",
                ReadCapacityUnits: "{{ ReadCapacityUnits }}",
                WriteCapacityUnits: "{{ WriteCapacityUnits }}",
              },
            },
            outputs: [
              { Name: "Changed", Selector: "$.Payload.changed", Type: "StringList" },
              { Name: "Message", Selector: "$.Payload.message", Type: "String" },
            ],
          },
        ],
      },
    });
    // CfnDocument.ref = document 名 (明示名を出力にそのまま使う)。
    this.documentName = document.ref;
    this.automationRoleArn = automationRole.roleArn;
  }
}
