import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { grantChallengePayloadRead } from "../utils/iam-helpers.js";
import { auditLogEnabledEnv } from "./audit-log-env.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";
import { buildAzureCredentialParameterArnPattern } from "./handlers/shared/azure-credential-store.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";
import { buildGcpCredentialParameterArnPattern } from "./handlers/shared/gcp-credential-store.js";
import { buildSakuraCredentialParameterArnPattern } from "./handlers/shared/sakura-credential-store.js";

export interface DeployApiLambdaProps {
  /**
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `DEPLOYMENTS_TABLE_NAME` は空文字、grant も付与しない — deploy 起動 (PutItem) は
   * repository seam (`resolveDeploymentsRepository`) が SQL executor 直結で処理する。
   */
  readonly deploymentsTable?: Table;
  readonly eventBus: IEventBus;
  /**
   * Phase 2.2 (Issue #459): single-deploy / stack-progress が verified=true 行のみ
   * 許可する gate のため、CompetitorAccounts table を Read する。
   *
   * [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `COMPETITOR_ACCOUNTS_TABLE_NAME` は注入せず、grant も付与しない — verified-gate lookup
   * は repository seam (`resolveVerifiedCompetitorAccount` → `resolveCompetitorAccountsRepository`)
   * が処理する ({@link deploymentsTable} と同じ条件)。
   *
   * [Issue #2560] 本 Lambda は `startDeployment` (`resolveDeploymentsRepository`) と
   * `resolveVerifiedCompetitorAccount` (`resolveCompetitorAccountsRepository`) の両方を通じて
   * 実際に SQL executor を acquire する — つまり EventApi / GenericScoring 等と同じ
   * 「DB を開く Lambda」であり、{@link tursoDatabaseUrl} / {@link tursoAuthTokenParameterName}
   * を持つのが正しい適用（以前は「本 Lambda は DB を開かない」という誤った前提でこの配線が
   * scope-out されていたため、pure SQL 選択時の deploy 起動 API 全体が動作しなかった）。
   */
  readonly competitorAccountsTable?: Table;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env。Cognito JWT authorizer
   * 結線後は JWT claim から取るが、Function URL 直叩き / dev / unit test では本値を使う。
   */
  readonly defaultTenantId?: string;
  /**
   * `problemId → problemDir` の hard-coded 問題カタログ (MVP-1)。
   * tenant API Lambda が POST /problems/:id/deploy を受けたとき、引数の problemId から
   * `problems/<category>/<id>` 形式の path を解決し、Step Functions State Machine の
   * 入力 (`detail.problemDir`) に詰める。
   */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /**
   * Issue #642: private 問題 id のセット (`{problemId: "private"}`)。
   * `discoverProblemsVisibility` の戻り値そのまま。 空 map なら全 public 扱いで dormant。
   */
  readonly problemsVisibility: Readonly<Record<string, "private">>;
  /**
   * [#2054] 非 aws/cloudformation の runtime を宣言した問題のみ
   * (= `{problemId: {provider,engine,entry}}`)。`discoverProblemsRuntime` の戻り値。
   * deploy handler が `resolveProblemRuntime` に配線し、 非 AWS 問題を cloud mutation
   * 前に 4xx で拒否する (= ローカル専用問題のクラウド誤デプロイ防止)。空 map なら全 AWS 扱い。
   */
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
  /**
   * Issue #642: private 問題 payload を格納する bucket 名。
   * 未指定 / 空文字列なら presigned URL を発行しない (= local-path 経路で動作)。
   * ChallengePayloadStack (Phase 2 infra) が deploy 後にここを指定して活性化する。
   */
  readonly challengePayloadBucketName?: string;
  /**
   * SSM SecureString path 構築用の env 名 (Phase 2.2、`/<environmentName>/tenants/...`)。
   */
  readonly environmentName: string;
  /**
   * Issue #950: admin 操作 audit log を append-only 書き込む DDB Table。
   * 指定時は Lambda env `ADMIN_AUDIT_LOG_TABLE_NAME` を注入 + IAM `dynamodb:PutItem` を付与する。
   * 未指定なら writeAuditEvent は env 不在で no-op を選ぶ (= 旧 stack 互換、 audit 行 0 件)。
   */
  readonly adminAuditLogTable?: Table;
  /**
   * Issue #2311: 監査ログ feature flag。false で env `AUDIT_LOG_ENABLED="false"` を注入し
   * `writeAuditEvent` を no-op 化する (= 書き込みコスト節約)。default (undefined/true) は env を
   * 足さず従来どおり (byte 互換)。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #2290: control-plane data backend (dynamodb|turso)。監査 Lambda 群と
   * lockstep で env を配線する (= 実際に repository seam を使うのは EventApi だが、AUDIT_LOG_ENABLED と
   * 同じ注入面に揃える)。default (未指定 / `dynamodb`) は env を足さず byte 互換。
   */
  readonly controlDataBackend?: string;
  /** [Issue #2560] Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** [Issue #2560] SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
  /**
   * #1766: tier 別の同時デプロイ上限。指定時は `DEPLOY_QUOTA_BY_TIER` env (JSON) を注入し、
   * handler が deploy 受付時に enforce する (超過 = 429)。未指定はクォータ無効 (空文字 env)。
   */
  readonly deployQuotaByTier?: {
    readonly basic: number;
    readonly advanced: number;
    readonly platinum: number;
  };
  /**
   * Issue #2019: TrustBridge high-risk enforcement mode, injected as the
   * `CLOUD_ACTION_ENFORCEMENT_MODE` env. `"shadow"` (default / unset) keeps every
   * deploy on the legacy path (no behavior change). `"enforce"` opts in: a
   * high-risk deploy (replacing a live stack) is held as `APPROVAL_PENDING`
   * instead of running AssumeRole / CloudFormation.
   */
  readonly cloudActionEnforcementMode?: "shadow" | "enforce";
  /**
   * [Issue #2745] The materialized `problems/` tree bucket (same bucket `CfnDeployLambda` reads,
   * `problem-deploy-backend-stack.ts`'s `sourceBucketName`). A **public** `gcp/infra-manager`
   * problem's Terraform root module is read from here (`gcp-blueprint-materializer.ts`); a
   * **private** problem's presigned `challengePayloadUrl` path needs no bucket read at all. Always
   * passed (the bucket already exists unconditionally in every environment) — only whether the
   * `problems/` tree is actually MATERIALIZED there is gated on `CDK_PARAM_DEPLOY_VIA_LAMBDA`
   * (`build-deploy-pipeline.ts`); an unmaterialized tree fails the read loud, it is never silent.
   */
  readonly sourceBucketName: string;
}

export function deployApiBundlingDefine(
  props: Pick<DeployApiLambdaProps, "problemsCatalog" | "problemRuntimes">,
): Record<string, string> {
  return {
    "process.env.BATTLE_PROBLEMS_CATALOG": JSON.stringify(JSON.stringify(props.problemsCatalog)),
    "process.env.BATTLE_PROBLEMS_RUNTIMES": JSON.stringify(
      JSON.stringify(props.problemRuntimes ?? {}),
    ),
  };
}

/**
 * 問題 deploy 起動用 Lambda。
 *
 * MVP-1: tenant API (TenantTemplateStack の REST API + Cognito authorizer)
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

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/deploy-handler/index.ts"),
      timeout: Duration.seconds(15),
      // 256MB では本番で 255/256MB まで張り付き、CPU 不足で init が遅く 15s timeout を連発
      // していた (デプロイ履歴 API)。メモリ増で CPU も増え cold start が速くなり timeout も解消。
      memorySize: 1024,
      environment: {
        // Issue #2441: 純 SQL backend では table 自体が無いので env も足さない (= CFn byte 互換 /
        // EVENTS_TABLE_NAME と同じ conditional-spread パターン)。
        ...(props.deploymentsTable
          ? { DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName }
          : {}),
        // Phase 2.2 (Issue #459) / [Issue #2442]: 純 SQL backend では table 自体が無いので
        // env も足さない (= CFn byte 互換 / DEPLOYMENTS_TABLE_NAME と同じ conditional-spread パターン)。
        ...(props.competitorAccountsTable
          ? { COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTable.tableName }
          : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        // #686: legacy "unknown-tenant" fallback は削除 (= JWT claim 欠落時は handler が 401)
        ...(props.defaultTenantId ? { DEFAULT_TENANT_ID: props.defaultTenantId } : {}),
        // Issue #642: visibility + bucket env、 default は dormant
        BATTLE_PROBLEMS_VISIBILITY: JSON.stringify(props.problemsVisibility),
        CHALLENGE_PAYLOAD_BUCKET: props.challengePayloadBucketName ?? "",
        // Issue #950: audit log table 名 (未配線なら空文字、 handler の writeAuditEvent が no-op)
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable?.tableName ?? "",
        // Issue #2311: 監査ログ feature flag (無効時のみ AUDIT_LOG_ENABLED="false" を注入)。
        ...auditLogEnabledEnv(props.auditLogEnabled),
        // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        // [Issue #2560] EventApi と同型: 純 SQL 選択時、本 Lambda も deploymentsRepository /
        // competitorAccountsRepository 経由で SQL executor を acquire するため Turso 接続情報が要る。
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        // #1766: tier 別同時デプロイ上限 (未配線なら空文字 = クォータ無効)
        DEPLOY_QUOTA_BY_TIER: props.deployQuotaByTier
          ? JSON.stringify(props.deployQuotaByTier)
          : "",
        // Issue #2019: TrustBridge high-risk enforcement mode。 default
        // "shadow" (= 既存挙動、 全 deploy が従来経路)。 "enforce" で opt-in。
        CLOUD_ACTION_ENFORCEMENT_MODE: props.cloudActionEnforcementMode ?? "shadow",
        // [Issue #2745] materialized problems/ tree bucket — read by gcp-blueprint-materializer.ts
        // for a public gcp/infra-manager problem's Terraform root module.
        SOURCE_BUCKET_NAME: props.sourceBucketName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      // Issue #1308: BATTLE_PROBLEMS_CATALOG は問題が増えるたび growing し 4 KB Lambda env
      // hard limit に張り付いた (= EventApi / DeployApi の deploy が CREATE_FAILED)。 #1158
      // (GenericScoring / ParticipantPortal) と同じ esbuild define で build 時に literal 置換
      // し env を 0 化する。 handler は process.env を読む既存 code のまま (= build 後に literal
      // JSON 文字列が埋まる)。 tests は process.env 経由で fixture を注入するので影響なし。
      bundlingDefine: deployApiBundlingDefine(props),
    });

    // 必要な権限: DDB CRUD + EventBus PutEvents + CompetitorAccounts Read。
    // Phase 2.2 (Issue #459): verified-only gate のために CompetitorAccounts は read-only で
    // 引く。AssumeRole / SSM SecureString は CompetitorAccountsApiLambda + State Machine 経由
    // (= 本 Lambda は同期 API 経路のみ担う)。
    props.deploymentsTable?.grantReadWriteData(this.fn);
    // Issue #2442: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.competitorAccountsTable?.grantReadData(this.fn);
    props.eventBus.grantPutEventsTo(this.fn);
    // Issue #950: admin 操作 audit log を append-only 書き込む。
    // Read は付与しない (= write-only から query を起こす経路を作らない)。
    props.adminAuditLogTable?.grantWriteData(this.fn);

    // #534: deploy job 詳細ページから CFn StackEvents / StackResources を引く読み取り権限。
    // same-account 経路 (= dev / 旧 deployment 行) では本 Lambda Role が直接呼ぶため Describe*
    // を ALLOW する。Phase 2.2 (Issue #459) の cross-account では AssumeRole 経由になるが、
    // verified=true 行が無いケースで fallback として残るので削除しない。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources"],
        resources: ["*"],
      }),
    );

    // Phase 2.2 (Issue #459): stack-progress の cross-account 経路で必要な権限。
    //   - SSM SecureString Read (= tenant path prefix scope)
    //   - kms:Decrypt (= SSM SecureString 復号、AWS managed key + EncryptionContext で絞る)
    //   - sts:AssumeRole (= 競技者 IAM Role `TenkaCloud-*`)
    // CompetitorAccountsApiLambda と同じ pattern (= 最小権限 + path prefix scope)。
    const stack = Stack.of(this);
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    // [#1412 #1410 #1411] per-team の Sakura API key / Azure deploy credential /
    // GCP WIF config (SSM SecureString) も同 Lambda が deploy 時に decrypt 取得する。 ExternalId と同じ
    // prefix-scope + AWS managed key 復号で最小権限を保つ。
    const sakuraSsmArn = buildSakuraCredentialParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    const azureSsmArn = buildAzureCredentialParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    const gcpSsmArn = buildGcpCredentialParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    const credentialSsmArns = [ssmArn, sakuraSsmArn, azureSsmArn, gcpSsmArn];
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: credentialSsmArns,
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringLike: { "kms:EncryptionContext:PARAMETER_ARN": credentialSsmArns },
        },
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );

    // Issue #642: private 問題 payload の GetObject 権限。
    // bucket 未指定なら no-op (= dormant、 最小権限維持)。
    grantChallengePayloadRead(this, this.fn, props.challengePayloadBucketName);

    // [Issue #2745] materialized problems/ tree read — a PUBLIC gcp/infra-manager problem's
    // Terraform root module (gcp-blueprint-materializer.ts). `s3:GetObject` on every object (same
    // scope CfnDeployLambda already has, cfn-deploy-lambda.ts); `s3:ListBucket` is additionally
    // scoped to the two valid `problemDir` prefix shapes (events.ts `isProblemDir`:
    // `problems/<category>/<id>` core catalog, `pack-problems/<packId>/<version>/<category>/<id>`
    // installed pack) via condition — least privilege, the materializer only ever lists under one
    // problem's own directory, never the whole bucket.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::${props.sourceBucketName}/*`],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${props.sourceBucketName}`],
        conditions: {
          StringLike: { "s3:prefix": ["problems/*", "pack-problems/*"] },
        },
      }),
    );

    // [Issue #2560] Turso SecureString read — EventApiLambda と同じ pattern。
    // `tursoAuthTokenParameterName` 未配線 (= dynamodb backend) なら no-op。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }
  }
}
