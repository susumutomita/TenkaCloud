import * as cdk from "aws-cdk-lib";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { ControlDataTablesOutputs } from "./build-control-data-tables.js";
import { CompetitorAccountsApiLambda } from "./competitor-accounts-api-lambda.js";
import { DeployApiLambda } from "./deploy-api-lambda.js";
import { DisruptionExecutorLambda } from "./disruption-executor-lambda.js";
import { EventApiLambda } from "./event-api-lambda.js";
import { ExternalIdAuditLambda } from "./external-id-audit-lambda.js";
import { SystemAuditWriterLambda } from "./system-audit-writer-lambda.js";

/**
 * control-plane data backend selector + Turso executor wiring, spread into every Lambda
 * construct that "opens the DB" (resolves a repository seam to a SQL executor in
 * turso mode) — same undefined-when-dynamodb shape as the old
 * three explicit props, so each `...controlDataBackendProps` call site is byte-identical.
 */
export interface ControlDataBackendProps {
  readonly controlDataBackend?: string;
  readonly tursoDatabaseUrl?: string;
  readonly tursoAuthTokenParameterName?: string;
}

export interface BuildApiLambdasArgs {
  readonly tables: ControlDataTablesOutputs;
  readonly eventBus: IEventBus;
  readonly controlDataBackendProps: ControlDataBackendProps;
  readonly environmentName: string;
  readonly defaultTenantId?: string;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly problemsVisibility?: Readonly<Record<string, "private">>;
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
  readonly challengePayloadBucketName?: string;
  readonly auditLogEnabled?: boolean;
  readonly deployQuotaByTier?: {
    readonly basic: number;
    readonly advanced: number;
    readonly platinum: number;
  };
  readonly cloudActionEnforcementMode?: "shadow" | "enforce";
  readonly problemsDisruptions?: Readonly<Record<string, unknown>>;
  /** [Issue #3169] `interTeamCoordination` per problem; bulk deploy's capacity preflight reads it. */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  readonly problemsProvenance?: Readonly<Record<string, unknown>>;
  readonly useBulkDistributedMap?: boolean;
  readonly capacityRunbookDocumentName?: string;
  readonly capacityRunbookAutomationRoleArn?: string;
  readonly deployViaLambda?: boolean;
  /**
   * [Issue #2745] The materialized `problems/` tree bucket name — threaded into `DeployApiLambda`
   * so a public `gcp/infra-manager` problem's Terraform root module can be read (see
   * `deploy-api-lambda.ts` prop docs). Always present at the stack level (`sourceBucketName` is a
   * required `ProblemDeployBackendStackProps` field), so this is required too.
   */
  readonly sourceBucketName: string;
}

export interface ApiLambdasOutputs {
  /**
   * [Issue #3152] Concrete rather than `IFunction`: the caller adds the
   * coordination artifact bucket's name to these two Lambdas' environments once
   * the participant-portal subsystem has created it, and `IFunction` exposes no
   * way to add an environment variable.
   */
  readonly deployApiFn: NodejsFunction;
  readonly eventApiFn: NodejsFunction;
  readonly competitorAccountsApiFn: IFunction;
  readonly externalIdAuditFn: IFunction;
  /**
   * Issue #910 (#895 Phase 2.C.2.b): bulk batch payload S3 bucket。EventApiLambda の
   * bulk-deploy handler が PutObject で deployment 配列を書き、`buildDeployPipeline` の
   * Distributed Map state machine が読む (= caller が pipeline builder へ渡す)。
   */
  readonly bulkPayloadBucket: Bucket;
}

/**
 * [#2527 Slice 5] API Lambda family: the six tenant-facing / event-driven Lambdas
 * (SystemAuditWriter, DeployApi, EventApi, DisruptionExecutor, CompetitorAccountsApi,
 * ExternalIdAudit) plus the bulk-deploy payload bucket EventApi writes into — extracted
 * verbatim from `ProblemDeployBackendStack`'s constructor.
 *
 * `scope` MUST be the stack instance itself (all construct IDs below are unprefixed,
 * exactly as they were inline) — moving this to a nested construct would change every
 * logical ID beneath it (CFn REPLACE on every Lambda/role), same constraint as
 * `buildDeployPipeline`.
 */
export function buildApiLambdas(scope: Construct, args: BuildApiLambdasArgs): ApiLambdasOutputs {
  const { tables, eventBus, controlDataBackendProps } = args;

  // Issue #1034: SBT Control Plane が発する onboarding* / offboarding* event を audit に集約。
  // SystemAdmin の tenant CRUD は SBT 経由なので App Plane Lambda が走らず、 audit-log page の
  // SystemAdmin scope が常に空になっていた。 本 listener が SBT bus 上の 6 detailType を catch して
  // `PK=SYSTEM#<env>` 行を書く。 Lite mode (= ControlPlane 不在) では local bus にぶら下がるが、
  // SBT events も流れて来ない (= 副作用なし) ため idle で安全。
  new SystemAuditWriterLambda(scope, "SystemAuditWriter", {
    eventBus,
    adminAuditLogTable: tables.adminAuditLog?.table,
    environmentName: args.environmentName,
    // Issue #2311: 監査ログ feature flag (off で writeAuditEvent が no-op)。
    auditLogEnabled: args.auditLogEnabled,
    ...controlDataBackendProps, // #2442: SBT tenant onboarding/offboarding 監査の repository seam を開く
    // Issue #2291: Lambda deploy 経路のとき、失敗 event を拾う DeployFailureRule を有効化
    // (= CodeBuild path の CodeBuild FAILED audit と parity)。flag OFF では Rule なし = byte 互換。
    deployViaLambda: args.deployViaLambda,
  });

  // tenant API から invoke される Lambda。validation + DDB Put + EventBridge PutEvents のみ。
  // Phase 2.2 (Issue #459): CompetitorAccounts table + env を渡して verified-only gate を有効化。
  const deployApi = new DeployApiLambda(scope, "DeployApi", {
    deploymentsTable: tables.deployments?.table,
    competitorAccountsTable: tables.competitorAccounts?.table,
    eventBus,
    defaultTenantId: args.defaultTenantId,
    problemsCatalog: args.problemsCatalog,
    // Issue #642: visibility + bucket、 unset で dormant default。
    problemsVisibility: args.problemsVisibility ?? {},
    // [#2054] 非 AWS 問題を cloud mutation 前に拒否する runtime catalog
    // (= DeployApiLambda の optional prop。 undefined は env 側 `?? {}` で空 map に正規化)。
    problemRuntimes: args.problemRuntimes,
    ...(args.challengePayloadBucketName
      ? { challengePayloadBucketName: args.challengePayloadBucketName }
      : {}),
    environmentName: args.environmentName,
    // Issue #950: admin audit log を write
    adminAuditLogTable: tables.adminAuditLog?.table,
    // Issue #2311: 監査ログ feature flag。
    auditLogEnabled: args.auditLogEnabled,
    ...controlDataBackendProps, // #2560: startDeployment / resolveVerifiedCompetitorAccount が SQL executor を acquire
    // #1766: tier 別の同時デプロイ上限 (env JSON)。
    deployQuotaByTier: args.deployQuotaByTier,
    // Issue #2019: TrustBridge enforcement mode (undefined → lambda
    // defaults to shadow = no-op)。
    cloudActionEnforcementMode: args.cloudActionEnforcementMode,
    // [Issue #2745] materialized problems/ tree bucket — public gcp/infra-manager Terraform read.
    sourceBucketName: args.sourceBucketName,
  });

  // Issue #910 (#895 Phase 2.C.2.b): bulk batch payload S3 bucket。 EventApiLambda の
  // bulk-deploy handler が PutObject で deployment 配列を書く。 default では feature flag
  // off で旧 fan-out 維持、 flag flip で Distributed Map 経路 (= 後段 BulkDeployCreateStateMachine)
  // に切替。 bucket 自体は flag に関係なく作る (= flip だけで切替可能、 段階移行)。
  const bulkPayloadBucket = new Bucket(scope, "BulkDeployPayloadBucket", {
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    // 旧 batch の object はもう不要なので 7 日で自動削除 (= cost / GC)。
    lifecycleRules: [
      {
        expiration: cdk.Duration.days(7),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      },
    ],
  });

  // Event / Team CRUD + Bulk Deploy/Teardown Lambda。
  // deployment 行の作成 / status 更新 + EventBridge fan-out publish を担う。
  // Phase 2.2 (Issue #459): CompetitorAccounts table + env を渡して verified-only gate を有効化。
  const eventApi = new EventApiLambda(scope, "EventApi", {
    eventsTable: tables.events?.table,
    teamsTable: tables.teams?.table,
    deploymentsTable: tables.deployments?.table,
    competitorAccountsTable: tables.competitorAccounts?.table,
    eventBus,
    problemsCatalog: args.problemsCatalog,
    defaultTenantId: args.defaultTenantId,
    environmentName: args.environmentName,
    // Issue #888: disruption fire / audit / catalog で参照
    // Issue #2442: 純 SQL backend では table 自体が無いので undefined を渡す (env/grant を
    // EventApiLambda 側で条件化。 disruption 読み書きは repository seam 経由)。
    disruptionsTable: tables.disruptions?.table,
    // Issue #2410 Slice 2: キャパ監視 (`GET /admin/capacity`) の event-hot 5 テーブル目 +
    // Slice 1 runbook の document 名 (UI が実行コマンド例を表示する)。
    // Issue #2442: 純 SQL backend では table 自体が無いので undefined を渡す (env/grant/
    // DescribeTable IAM を EventApiLambda 側で条件化)。
    problemEndpointsTable: tables.endpoints?.table,
    capacityRunbookDocumentName: args.capacityRunbookDocumentName,
    // Issue #2680: `POST /admin/capacity` (StartAutomationExecution + PassRole) の IAM scope。
    capacityRunbookAutomationRoleArn: args.capacityRunbookAutomationRoleArn,
    problemsDisruptions: (args.problemsDisruptions ?? {}) as Readonly<
      Record<string, readonly unknown[]>
    >,
    // [Issue #3169] Bulk deploy refuses an event that cannot fit a coordination
    // problem on the selected backend; this is the declaration it reads.
    problemsCoordination: args.problemsCoordination ?? {},
    problemsProvenance: args.problemsProvenance ?? {},
    // [#2054 / Issue #2571] Bulk Deploy adapter dispatch 用 runtime catalog。DeployApi
    // と同一 source (args.problemRuntimes) をそのまま流す — undefined は EventApiLambda 側の
    // `?? {}` で空 map に正規化される。
    problemRuntimes: args.problemRuntimes,
    // Issue #910 Phase 2.C.2.b: bulk batch payload bucket + feature flag。
    bulkDeployPayloadBucket: bulkPayloadBucket,
    useBulkDistributedMap: args.useBulkDistributedMap ?? false,
    // Issue #950
    adminAuditLogTable: tables.adminAuditLog?.table,
    // Issue #2311: 監査ログ feature flag。
    auditLogEnabled: args.auditLogEnabled,
    // Issue #2290: control-plane data backend。event-handler の getEventDetail が Events / Teams
    // repository seam を切替える (= turso 選択時のみ CONTROL_DATA_BACKEND を注入)。
    ...controlDataBackendProps,
  });

  // [Issue #1419] Disruption: operator fire が publish した `*DisruptionFired` を
  // 拾い、 team deployment へ AssumeRole して実障害を注入し、 revert を予約する cross-account executor。
  // action 未宣言の disruption は no-op (= Phase A 監査のみ、 後方互換)。
  new DisruptionExecutorLambda(scope, "DisruptionExecutor", {
    environmentName: args.environmentName,
    eventBus,
    deploymentsTable: tables.deployments?.table,
    // Issue #2442: 純 SQL backend では table 自体が無いので undefined を渡す (env/grant を
    // DisruptionExecutorLambda 側で条件化)。
    disruptionsTable: tables.disruptions?.table,
    problemsDisruptions: (args.problemsDisruptions ?? {}) as Readonly<Record<string, unknown>>,
    ...controlDataBackendProps, // #2442: EXEC# 冪等 claim の repository seam を開く
  });

  // Issue #459: Competitor Accounts CRUD + STS verify Lambda。
  // 独立 Lambda にする理由: SSM SecureString R/W + STS AssumeRole の IAM scope を最小化するため。
  const competitorAccountsApi = new CompetitorAccountsApiLambda(scope, "CompetitorAccountsApi", {
    competitorAccountsTable: tables.competitorAccounts?.table,
    environmentName: args.environmentName,
    // Issue #950
    adminAuditLogTable: tables.adminAuditLog?.table,
    // Issue #2311: 監査ログ feature flag。
    auditLogEnabled: args.auditLogEnabled,
    ...controlDataBackendProps, // #2442: CompetitorAccounts CRUD + SAML config の repository seam を開く
  });

  // Phase 3.2 / Issue #603: ExternalId rotation age 監査 Lambda。1 日 1 回起動して
  // CompetitorAccounts table を Scan し、各 (tenantId, awsAccountId) の rotation age を
  // CloudWatch メトリクス `TenkaCloud/CompetitorAccounts/RotationAge` に publish する。
  // SSM Parameter Store は 100 version で auto-drop するため明示的な cleanup Lambda は
  // 入れない (= 説明は `external-id-audit-lambda.ts` の docblock を参照)。
  const externalIdAudit = new ExternalIdAuditLambda(scope, "ExternalIdAudit", {
    competitorAccountsTable: tables.competitorAccounts?.table,
    environmentName: args.environmentName,
    ...controlDataBackendProps, // #2442: 日次 rotation 監査の repository seam を開く
  });

  return {
    deployApiFn: deployApi.fn,
    eventApiFn: eventApi.fn,
    competitorAccountsApiFn: competitorAccountsApi.fn,
    externalIdAuditFn: externalIdAudit.fn,
    bulkPayloadBucket,
  };
}
