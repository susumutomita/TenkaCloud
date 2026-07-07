import { Aws, CfnOutput } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnDocument } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * [#2410] Event-window DynamoDB capacity runbook.
 *
 * The platform keeps every table at PROVISIONED 1/1 (cost-zero when idle, via
 * the `DynamoDbLowCapacity` Aspect). A big event can throttle at 1 RCU, so an
 * operator needs to raise capacity **for the event window only** — and lower it
 * again afterwards.
 *
 * We do this with an SSM Automation document (a runbook), NOT auto-scaling.
 * Auto-scaling can ramp silently and bill without a human in the loop; a runbook
 * is a deliberate, logged, bounded operator action. Cost-explosion is fenced off
 * structurally:
 *   1. Tables stay PROVISIONED — request spikes throttle, they never bill
 *      per-request (no on-demand surprise).
 *   2. A hard `ceiling` baked into the document rejects any request above it, so
 *      a fat-fingered `ReadCapacity=100000` fails instead of scaling.
 *   3. Every run is an explicit SSM execution recorded in history.
 *   4. Scale-down is one more run (`ReadCapacity=1 WriteCapacity=1`), and the
 *      next `cdk deploy` resets to the 1/1 floor anyway.
 *
 * Operator usage:
 *   aws ssm start-automation-execution --document-name <DocumentName> \
 *     --parameters ReadCapacity=50,WriteCapacity=50
 * then after the event:
 *   aws ssm start-automation-execution --document-name <DocumentName> \
 *     --parameters ReadCapacity=1,WriteCapacity=1
 */
export interface EventCapacityRunbookProps {
  /** The event-critical tables whose capacity the runbook raises/lowers. */
  readonly tables: readonly Table[];
  /** SSM document name (must be unique per account/region — pass a per-env prefix). */
  readonly documentName: string;
  /**
   * Hard upper bound on requested capacity (cost guard). A run above this fails.
   * Default 200 RCU/WCU ≈ under $0.20/hr provisioned — generous for an event,
   * bounded against a fat-finger. Keep it well inside the account's budget alarm.
   */
  readonly ceiling?: number;
}

export const DEFAULT_EVENT_CAPACITY_CEILING = 200;

export class EventCapacityRunbook extends Construct {
  readonly documentName: string;

  constructor(scope: Construct, id: string, props: EventCapacityRunbookProps) {
    super(scope, id);
    const ceiling = props.ceiling ?? DEFAULT_EVENT_CAPACITY_CEILING;
    if (!Number.isInteger(ceiling) || ceiling < 1) {
      throw new Error(`ceiling must be a positive integer (got ${ceiling})`);
    }
    if (props.tables.length === 0) {
      throw new Error("EventCapacityRunbook requires at least one table");
    }
    this.documentName = props.documentName;

    const tableArns = props.tables.map((t) => t.tableArn);
    const tableNames = props.tables.map((t) => t.tableName);

    // Least-privilege role SSM assumes: describe/update only the named tables
    // (+ their indexes). No table:CreateTable / DeleteTable, no wildcard.
    const automationRole = new Role(this, "AutomationRole", {
      assumedBy: new ServicePrincipal("ssm.amazonaws.com"),
      description: "TenkaCloud event-capacity runbook - DynamoDB UpdateTable only",
    });
    automationRole.addToPolicy(
      new PolicyStatement({
        actions: ["dynamodb:DescribeTable", "dynamodb:UpdateTable"],
        resources: [...tableArns, ...tableArns.map((arn) => `${arn}/index/*`)],
      }),
    );

    const document = new CfnDocument(this, "Document", {
      name: props.documentName,
      documentType: "Automation",
      documentFormat: "JSON",
      updateMethod: "NewVersion",
      content: {
        schemaVersion: "0.3",
        description:
          "Raise or lower TenkaCloud DynamoDB provisioned capacity for an event window (bounded by a cost ceiling).",
        assumeRole: automationRole.roleArn,
        parameters: {
          ReadCapacity: {
            type: "Integer",
            default: 1,
            description: `Target read capacity units per table + index (1..${ceiling}).`,
          },
          WriteCapacity: {
            type: "Integer",
            default: 1,
            description: `Target write capacity units per table + index (1..${ceiling}).`,
          },
        },
        mainSteps: [
          {
            name: "GuardAndScale",
            action: "aws:executeScript",
            // Fail the whole automation loudly if the guard rejects the request.
            onFailure: "Abort",
            inputs: {
              Runtime: "python3.11",
              Handler: "handler",
              InputPayload: {
                ReadCapacity: "{{ ReadCapacity }}",
                WriteCapacity: "{{ WriteCapacity }}",
                Ceiling: ceiling,
                Tables: tableNames,
              },
              Script: SCALE_SCRIPT,
            },
          },
        ],
      },
    });

    new CfnOutput(this, "DocumentNameOutput", {
      value: document.ref,
      description: `SSM runbook to scale event DynamoDB capacity (ceiling ${ceiling}). Run: aws ssm start-automation-execution --document-name ${props.documentName} --parameters ReadCapacity=<n>,WriteCapacity=<n> in ${Aws.REGION}.`,
    });
  }
}

/**
 * Bounded scale step. Rejects capacity outside [1, Ceiling] before touching any
 * table (cost guard), skips PAY_PER_REQUEST tables and no-op updates (avoids the
 * "throughput unchanged" ValidationException), and updates the base table plus
 * every GSI in one UpdateTable call.
 */
const SCALE_SCRIPT = `import boto3


def handler(event, context):
    read = int(event["ReadCapacity"])
    write = int(event["WriteCapacity"])
    ceiling = int(event["Ceiling"])
    tables = event["Tables"]
    if read < 1 or write < 1:
        raise ValueError("ReadCapacity/WriteCapacity must be >= 1")
    if read > ceiling or write > ceiling:
        raise ValueError(
            "requested capacity %d/%d exceeds ceiling %d (cost guard: refusing to scale)"
            % (read, write, ceiling)
        )
    ddb = boto3.client("dynamodb")
    updated = []
    skipped = []
    for name in tables:
        table = ddb.describe_table(TableName=name)["Table"]
        if table.get("BillingModeSummary", {}).get("BillingMode") == "PAY_PER_REQUEST":
            skipped.append(name)
            continue
        base = table.get("ProvisionedThroughput", {})
        base_changed = (
            base.get("ReadCapacityUnits") != read
            or base.get("WriteCapacityUnits") != write
        )
        gsi_updates = []
        for gsi in table.get("GlobalSecondaryIndexes", []):
            tp = gsi.get("ProvisionedThroughput", {})
            if tp.get("ReadCapacityUnits") != read or tp.get("WriteCapacityUnits") != write:
                gsi_updates.append(
                    {
                        "Update": {
                            "IndexName": gsi["IndexName"],
                            "ProvisionedThroughput": {
                                "ReadCapacityUnits": read,
                                "WriteCapacityUnits": write,
                            },
                        }
                    }
                )
        if not base_changed and not gsi_updates:
            skipped.append(name)
            continue
        args = {"TableName": name}
        if base_changed:
            args["ProvisionedThroughput"] = {
                "ReadCapacityUnits": read,
                "WriteCapacityUnits": write,
            }
        if gsi_updates:
            args["GlobalSecondaryIndexUpdates"] = gsi_updates
        ddb.update_table(**args)
        updated.append(name)
    return {
        "updated": updated,
        "skipped": skipped,
        "readCapacity": read,
        "writeCapacity": write,
    }
`;
