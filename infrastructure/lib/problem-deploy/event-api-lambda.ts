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
   * Phase 2.2 (Issue #459): Bulk Deploy が deploy 前に verified=true 行のみ許可する
   * gate のため、CompetitorAccounts table を Read する。
   */
  readonly competitorAccountsTable: Table;
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
  /**
   * SSM SecureString path 構築用の env 名 (Phase 2.2)。Bulk Deploy が DeployCreate-
   * Requested detail に詰める `externalIdParameterName` のために必要 (= CompetitorAccountsApi
   * Lambda と同じ env 名)。
   */
  readonly environmentName: string;
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
        // Phase 2.2 (Issue #459): bulk-deploy が CompetitorAccounts table を引いて verified-only
        // gate を実現するため、table 名と SSM path 構築用 env 名を Lambda 環境に注入する。
        COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        // #686: legacy "unknown-tenant" fallback は削除 (= JWT claim 欠落時は handler が 401)
        ...(props.defaultTenantId ? { DEFAULT_TENANT_ID: props.defaultTenantId } : {}),
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
    // Phase 2.2 (Issue #459): CompetitorAccounts は read-only (verified gate のみ)。
    // verify / Put / Delete は CompetitorAccountsApiLambda 側で行うので、本 Lambda には
    // RW を付与しない (= 最小権限)。
    props.competitorAccountsTable.grantReadData(this.fn);
    props.eventBus.grantPutEventsTo(this.fn);
  }
}
