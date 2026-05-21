import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";

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
   * Issue #888: Red Team Disruption Injection の audit + idempotency 用 DDB table。
   */
  readonly disruptionsTable: Table;
  /**
   * Issue #888: problem metadata.json の `disruptions[]` 宣言。 Lambda runtime で
   * `(problemId, disruptionId)` lookup に使う。
   */
  readonly problemsDisruptions: Readonly<Record<string, readonly unknown[]>>;
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
  /**
   * Issue #910 (#895 Phase 2.C): bulk batch payload を保存する S3 bucket。 未配線
   * (= 旧 fan-out のみ) なら undefined。 wire 時に bulk-deploy.ts が PutObject で
   * deployment 配列を書き、 1 BulkDeployCreateRequested event を publish する。
   */
  readonly bulkDeployPayloadBucket?: IBucket;
  /**
   * Issue #910: Distributed Map 経路への切替 flag。 "true" で bulk-deploy.ts が S3 PutObject
   * + 1 event publish に切替。 未設定 / "false" は旧 fan-out 維持 (= rollback safety)。
   */
  readonly useBulkDistributedMap?: boolean;
  /**
   * Issue #950 (ADR-020 Phase D): admin 操作 audit log 用 DDB Table。 deploy-api-lambda と同じ。
   */
  readonly adminAuditLogTable?: Table;
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
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handlers/event-handler/index.ts"),
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
        // Issue #888: disruption fire / catalog / audit Lambda 経路で参照
        DISRUPTIONS_TABLE_NAME: props.disruptionsTable.tableName,
        BATTLE_PROBLEMS_DISRUPTIONS: JSON.stringify(props.problemsDisruptions),
        // Issue #910 (#895 Phase 2.C.2.b): bulk batch payload S3 bucket + feature flag。
        // bucket 未配線時は空文字、 flag は default false (= 旧 fan-out 維持)。
        BULK_DEPLOY_PAYLOAD_BUCKET: props.bulkDeployPayloadBucket?.bucketName ?? "",
        BULK_DEPLOY_VIA_DISTRIBUTED_MAP: props.useBulkDistributedMap ? "true" : "false",
        // Issue #950: audit log table 名 (未配線なら空文字)
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable?.tableName ?? "",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
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
    // Issue #888: disruption audit + idempotency 用に RW、 EventBus PutEvents は既存付与で十分
    // (= disruption fire でも同 bus に publish するため)。
    props.disruptionsTable.grantReadWriteData(this.fn);
    // Issue #950 (ADR-020 Phase D): admin 操作 audit log は write-only で十分。
    props.adminAuditLogTable?.grantWriteData(this.fn);
    // Issue #910 (#895 Phase 2.C.2.b): bulk payload bucket への PutObject 権限。 bucket が
    // 渡されたときのみ grant (= 未配線時の余分な IAM を避ける)。 useBulkDistributedMap が
    // false でも grant を入れておくと、 flag を flip するだけで切替できる (= 段階移行)。
    if (props.bulkDeployPayloadBucket) {
      props.bulkDeployPayloadBucket.grantPut(this.fn);
    }
  }
}
