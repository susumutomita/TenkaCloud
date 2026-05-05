import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface DeployApiLambdaProps {
  readonly deploymentsTable: Table;
  readonly eventBus: IEventBus;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env。Cognito JWT authorizer
   * 結線後は JWT claim から取るが、Function URL 直叩き / dev / unit test では本値を使う。
   */
  readonly defaultTenantId?: string;
  /**
   * `problemId → problemDir` の hard-coded 問題カタログ (MVP-1)。
   * tenant API Lambda が POST /problems/:id/deploy を受けたとき、引数の problemId から
   * `problems/<category>/<id>` 形式の path を解決し、Step Functions State Machine の
   * 入力 (`detail.problemDir`) に詰める。Phase 2 (ADR-003) で DDB ベースの catalog に置換。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
}

/**
 * 問題 deploy 起動用 Lambda。
 *
 * MVP-1 (ADR-001 PR-2): tenant API (TenantTemplateStack の REST API + Cognito authorizer)
 * から `LambdaIntegration` で invoke され、validation 後に EventBridge へ
 * `DeployCreateRequested` event を publish する。実 deploy は EventBridge Rule から
 * Step Functions State Machine + CodeBuild が肩代わりする。
 *
 * Function URL は付けない (旧 MVP-0 の AWS_IAM 経路は廃止)。
 */
export class DeployApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: DeployApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/deploy-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
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

    // 必要な権限: DDB CRUD + EventBus PutEvents (cross-account AssumeRole は不要、MVP-1 は
    // 同一 account 内 deploy のみ)。
    props.deploymentsTable.grantReadWriteData(this.fn);
    props.eventBus.grantPutEventsTo(this.fn);
  }
}
