import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface EventApiLambdaProps {
  readonly eventsTable: Table;
  readonly teamsTable: Table;
  /**
   * Phase 2a (Bulk Deploy / Bulk Teardown) で deployment 行を作成 / 状態更新するため
   * 既存 Deployments table への RW 権限が必要。
   */
  readonly deploymentsTable: Table;
  /**
   * Phase 2a で `DeployCreateRequested` / `DeployDeleteRequested` を fan-out publish
   * するため、ControlPlane の共通 EventBus への PutEvents 権限を grant する。
   */
  readonly eventBus: IEventBus;
  /**
   * Bulk deploy 時に problemId → problemDir を解決するための hard-coded カタログ。
   * Phase 2 (ADR-003) で DDB catalog に置換される予定。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env (DeployApi と同じ fallback)。
   * Cognito JWT 結線後は JWT claim から取る。
   */
  readonly defaultTenantId?: string;
}

/**
 * Event / Team CRUD + Bulk Deploy 用の Lambda (ADR-004 Phase 1+2a)。
 *
 * tenant API (TenantTemplateStack の REST API + Cognito authorizer) から
 * `LambdaIntegration` で invoke される。Phase 2a で `POST /events/{id}/deploy` /
 * `DELETE /events/{id}` が追加され、deployment 行 (Deployments table) の作成 /
 * 状態更新と EventBridge fan-out publish (DeployCreateRequested /
 * DeployDeleteRequested) を担う。実 CFn deploy / delete は既存 DeployCreate /
 * DeployDelete State Machine が個別に拾って実行する。
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
      // Bulk teardown は teams × problems 全行を Update + chunk publish するので
      // teams=25 × problems=30 = 750 行で 30 秒前後を見込む。Phase 3 で Distributed
      // Map に切り出すまでの暫定。
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        TEAMS_TABLE_NAME: props.teamsTable.tableName,
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        DEFAULT_TENANT_ID: props.defaultTenantId ?? "unknown-tenant",
        BATTLE_PROBLEMS_CATALOG: JSON.stringify(props.problemsCatalog),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    // Events / Teams への RW (Phase 1 の CRUD)、Deployments への RW (Phase 2a の
    // bulk deploy / teardown で行を Put + Update)、EventBus への PutEvents (fan-out)。
    props.eventsTable.grantReadWriteData(this.fn);
    props.teamsTable.grantReadWriteData(this.fn);
    props.deploymentsTable.grantReadWriteData(this.fn);
    props.eventBus.grantPutEventsTo(this.fn);
  }
}
