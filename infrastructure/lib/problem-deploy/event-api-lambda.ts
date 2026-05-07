import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface EventApiLambdaProps {
  readonly eventsTable: Table;
  readonly teamsTable: Table;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env (DeployApi と同じ fallback)。
   * Cognito JWT 結線後は JWT claim から取る。
   */
  readonly defaultTenantId?: string;
}

/**
 * Event / Team CRUD 用の Lambda (ADR-004 Phase 1)。
 *
 * tenant API (TenantTemplateStack の REST API + Cognito authorizer) から
 * `LambdaIntegration` で invoke される。Phase 1 は CRUD のみで、Bulk Deploy /
 * Bulk Teardown は Phase 2 で別 Lambda + Step Functions Distributed Map に拡張する。
 */
export class EventApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: EventApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/event-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        TEAMS_TABLE_NAME: props.teamsTable.tableName,
        DEFAULT_TENANT_ID: props.defaultTenantId ?? "unknown-tenant",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // 必要な権限: Events / Teams 両 Table の RW (TransactWrite で同時 Put + 詳細取得 Query)。
    // EventBridge は Phase 2 (Bulk Deploy) で初めて要る、Phase 1 では publish しない。
    props.eventsTable.grantReadWriteData(this.fn);
    props.teamsTable.grantReadWriteData(this.fn);
  }
}
