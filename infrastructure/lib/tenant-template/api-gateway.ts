import { Stack } from "aws-cdk-lib";
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  Integration,
  IntegrationType,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import { CfnPermission, type IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { CustomApiKey } from "../interfaces/custom-api-key.js";
import type { IdentityDetails } from "../interfaces/identity-details.js";

interface ApiGatewayProps {
  tenantId: string;
  isPooledDeploy: boolean;
  idpDetails: IdentityDetails;
  /**
   * 本テナントの Cognito UserPool (`IdentityProvider.tenantUserPool`)。Deploy 系 endpoint
   * の Cognito JWT authorizer に渡す。tenant 自身のログインユーザーを信頼する SBT 同型。
   */
  userPool: IUserPool;
  /**
   * `ProblemDeployBackendStack.deployApiLambda` のクロススタック参照。Deploy 系 routes が
   * `proxyIntegrationFor` 経由で本 Lambda を invoke する。
   */
  deployApiLambda: IFunction;
  /**
   * `ProblemDeployBackendStack.eventApiLambda` のクロススタック参照 (ADR-004 Phase 1)。
   * Event / Team CRUD routes が本 Lambda を invoke する。
   */
  eventApiLambda: IFunction;
  /**
   * `ProblemDeployBackendStack.competitorAccountsApiLambda` のクロススタック参照
   * (Issue #459 / ADR-002 Phase 2.1)。`/admin/competitor-accounts*` routes を proxy する。
   */
  competitorAccountsApiLambda: IFunction;
  /**
   * Issue #1312: SAML IdP CRUD 用の Application Plane Lambda
   * (`ProblemDeployBackendStack.samlIdpLambda`)。 `/tenant/idp*` route を proxy する。
   * Lite mode では silo 同型 (= 1 tenant 専用 UserPool) のため有効、 pooled では handler 側
   * `IDP_TIER_GUARD` env が `"silo"` 以外なら 503 を返す fail-closed guard で防ぐ。
   * 未配線 (= 旧 stack) なら route を生やさない (= NO-OP)。
   */
  samlIdpLambda?: IFunction;
  apiKeyBasicTier: CustomApiKey;
  apiKeyStandardTier: CustomApiKey;
  apiKeyPremiumTier: CustomApiKey;
  apiKeyPlatinumTier: CustomApiKey;
  /**
   * Issue #860: CORS \`allowOrigins\` に乗せる application-admin-console の CloudFront URL。
   * 旧コードは \`["*"]\` だったが、 phishing 経路で attacker サイトから fetch される攻撃面が
   * 残るため、 同 tenant の SPA origin のみ許可する。 未指定なら dev fallback (= localhost のみ)。
   */
  applicationAdminConsoleUrl?: string;
  /**
   * Issue #860: environment 名 (development / staging / production)。 production のみ
   * localhost を CORS allowOrigins から除外する (= phishing 経路で localhost への redirect を弾く)。
   */
  environment?: string;
}

/**
 * テナントの REST API。tenant の Cognito UserPool で JWT 認可された「ログイン済み」ユーザー
 * が Deploy 操作を publish する経路を提供する (ADR-001 / SBT Control-Plane → Application-Plane
 * 同型)。
 *
 * MVP-1 で Deploy 系 routes (POST /problems/:id/deploy 等) を本 RestApi に直接生やし、
 * 共通の DeployApiLambda にプロキシする。Deploy 専用 HTTP API + 別 User Pool 信頼の構成は
 * 廃止 (Issue #458)。
 */
export class ApiGateway extends Construct {
  public readonly restApi: RestApi;

  /**
   * 1 つの Lambda を「1 statement だけ」で invoke 可能にする integration を作る。
   *
   * `LambdaIntegration` は method ごとに `AWS::Lambda::Permission` を 1 本足すが、 Lambda の
   * resource policy は **20,480 byte 固定上限**で、 しかもこの Lambda 群は Application Plane
   * (`tenkacloud-problem-deploy`) の **共有 function** なので、 全 tenant の API の permission が
   * 同じ policy に積み上がる。
   *
   * 実測 (2026-08-08、 pooled tenant のみが存在する状態):
   *   CompetitorAccountsApi  12,662 byte / 26 statement  ← 全部 pooled の API 由来
   *   DeployApi               5,795 byte / 12 statement
   *   EventApi                  495 byte /  1 statement  ← 既に本 pattern を適用済
   *
   * この状態で silo (platinum) tenant を 1 つ足すと admin routes 分が乗って 20,674 byte となり、
   * **最初の 1 tenant すら deploy できない** (scale 限界ではなくゼロ)。 実際に siloverify が
   * `The final policy size (20674) is bigger than the limit (20480)` で ROLLBACK した。
   *
   * そこで wildcard permission 1 本 + 低レベル `AWS_PROXY` integration にする。 wire 上の挙動は
   * `LambdaIntegration` と同一で、 生成される permission だけが method 数と無関係に 1 本になる。
   *
   * permission は **この stack (= API 側)** に `CfnPermission` で置く。 `fn.addPermission` は
   * Lambda 側の stack に置かれ、 そこから API の ARN を参照すると既存の cross-stack 依存
   * (API stack → Lambda stack) が逆流して synth が DependencyCycle で落ちる。
   */
  private proxyIntegrationFor(id: string, fn: IFunction): Integration {
    new CfnPermission(this, id, {
      action: "lambda:InvokeFunction",
      functionName: fn.functionArn,
      principal: "apigateway.amazonaws.com",
      sourceArn: this.restApi.arnForExecuteApi(),
    });
    const stack = Stack.of(this);
    return new Integration({
      type: IntegrationType.AWS_PROXY,
      integrationHttpMethod: "POST",
      uri: `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${fn.functionArn}/invocations`,
    });
  }

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    // Issue #860: CORS allowOrigins を `["*"]` から具体 origin に絞る (= phishing サイトから
    // 任意 origin で fetch される攻撃面を縮減)。 application-admin-console URL + dev localhost。
    // localhost は production env では除外する (= prod 環境の operator が dev tooling 経由で
    // 本番 API を叩く経路を塞ぐ)。
    const isProduction = (props.environment ?? "").toLowerCase() === "production";
    const allowOrigins: string[] = [];
    if (props.applicationAdminConsoleUrl) {
      allowOrigins.push(props.applicationAdminConsoleUrl);
    }
    if (!isProduction) {
      allowOrigins.push("http://localhost:5174");
    }
    if (allowOrigins.length === 0) {
      // synth-only / dev-fallback で URL が解決できないときは安全側に localhost のみ。
      allowOrigins.push("http://localhost:5174");
    }
    this.restApi = new RestApi(this, `TenantAPI-${props.tenantId}`, {
      defaultCorsPreflightOptions: {
        allowOrigins,
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, "TenantCognitoAuthorizer", {
      cognitoUserPools: [props.userPool],
      authorizerName: `TenantAuth-${props.tenantId}`,
    });

    const deployIntegration = this.proxyIntegrationFor(
      "ApiGatewayInvokeDeployRoutes",
      props.deployApiLambda,
    );
    const deployMethodOptions = {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    } as const;

    // /problems/{problemId}
    const problems = this.restApi.root.addResource("problems");
    const problem = problems.addResource("{problemId}");
    problem.addResource("deploy").addMethod("POST", deployIntegration, deployMethodOptions);
    problem.addResource("deployments").addMethod("GET", deployIntegration, deployMethodOptions);

    // /deployments — tenant 内全 deploy job 一覧 (サイドバー「デプロイ履歴」用)
    // /deployments/{jobId} — 1 件の取得 / 削除
    const deployments = this.restApi.root.addResource("deployments");
    deployments.addMethod("GET", deployIntegration, deployMethodOptions);
    const deployment = deployments.addResource("{jobId}");
    deployment.addMethod("GET", deployIntegration, deployMethodOptions);
    deployment.addMethod("DELETE", deployIntegration, deployMethodOptions);
    deployment
      .addResource("stack-progress")
      .addMethod("GET", deployIntegration, deployMethodOptions);

    // ADR-004 Phase 1+2a/2b: /events — 1 競技イベント = 1 行で teams + problems を持つ
    // /events                          POST  = create   / GET = list
    // /events/{eventId}                GET   = detail   / DELETE = bulk teardown
    // /events/{eventId}/deploy         POST  = bulk deploy (teams × problems を fan-out)
    // /events/{eventId}/schedule       PATCH = 競技開始時刻 (startsAt) を設定 (Phase 2b 追加)
    // /events/{eventId}/end            POST  = Event を ENDED 状態にし採点を停止 (Issue #494)
    // /events/{eventId}/notifications  POST  = 運営 → 競技者 通知 1 件作成 (ADR-006、#553)
    // /events/{eventId}/lock-scoring   POST  = 採点を lock (表彰フェーズ)、DELETE = unlock (#558)
    // EventApi は ~40 route を持つので、 最初にこの pattern が必要になったのはここだった
    // (per-method permission では /feature-flags を足した時点で 20KB を超えた)。 現在は他の
    // Lambda も同じ理由で同じ扱いにしてある — 詳細は `proxyIntegrationFor` を正本とする。
    const eventIntegration = this.proxyIntegrationFor(
      "ApiGatewayInvokeEventRoutes",
      props.eventApiLambda,
    );
    const events = this.restApi.root.addResource("events");
    events.addMethod("GET", eventIntegration, deployMethodOptions);
    events.addMethod("POST", eventIntegration, deployMethodOptions);
    const event = events.addResource("{eventId}");
    event.addMethod("GET", eventIntegration, deployMethodOptions);
    event.addMethod("DELETE", eventIntegration, deployMethodOptions);
    event.addResource("deploy").addMethod("POST", eventIntegration, deployMethodOptions);
    event.addResource("schedule").addMethod("PATCH", eventIntegration, deployMethodOptions);
    event.addResource("end").addMethod("POST", eventIntegration, deployMethodOptions);
    event.addResource("archive").addMethod("POST", eventIntegration, deployMethodOptions);
    event.addResource("notifications").addMethod("POST", eventIntegration, deployMethodOptions);
    const lockScoring = event.addResource("lock-scoring");
    lockScoring.addMethod("POST", eventIntegration, deployMethodOptions);
    lockScoring.addMethod("DELETE", eventIntegration, deployMethodOptions);

    // Issue #888 Phase A: Red Team Disruption Injection
    //   /events/{eventId}/disruptions                                  GET  = catalog
    //   /events/{eventId}/disruptions/audit                            GET  = 発火履歴 (pagination)
    //   /events/{eventId}/disruptions/fire                             POST = disruption を fire
    //   [ADR-037 Slice 2] /events/{eventId}/disruptions/recurring      GET  = 実行中の定期障害 一覧
    //   [ADR-037 Slice 2] /events/{eventId}/disruptions/recurring/{requestId}/cancel POST = 早期解除
    const disruptions = event.addResource("disruptions");
    disruptions.addMethod("GET", eventIntegration, deployMethodOptions);
    disruptions.addResource("audit").addMethod("GET", eventIntegration, deployMethodOptions);
    disruptions.addResource("fire").addMethod("POST", eventIntegration, deployMethodOptions);
    const recurring = disruptions.addResource("recurring");
    recurring.addMethod("GET", eventIntegration, deployMethodOptions);
    recurring
      .addResource("{requestId}")
      .addResource("cancel")
      .addMethod("POST", eventIntegration, deployMethodOptions);

    // Issue #459 / ADR-002 Phase 2.1: Competitor Accounts CRUD + verify
    //   /admin/competitor-accounts                                     POST=register, GET=list
    //   /admin/competitor-accounts/{awsAccountId}                      DELETE=remove (last row なら SSM 鍵も掃除)
    //   /admin/competitor-accounts/{awsAccountId}/verify               POST=STS AssumeRole sanity check
    //   /admin/competitor-accounts/{awsAccountId}/rotate-external-id   POST=ExternalId rotation (Issue #596 / Phase 3.1)
    const competitorAccountsIntegration = this.proxyIntegrationFor(
      "ApiGatewayInvokeCompetitorAccountsRoutes",
      props.competitorAccountsApiLambda,
    );
    const admin = this.restApi.root.addResource("admin");
    const competitorAccounts = admin.addResource("competitor-accounts");
    competitorAccounts.addMethod("GET", competitorAccountsIntegration, deployMethodOptions);
    competitorAccounts.addMethod("POST", competitorAccountsIntegration, deployMethodOptions);
    const competitorAccount = competitorAccounts.addResource("{awsAccountId}");
    competitorAccount.addMethod("DELETE", competitorAccountsIntegration, deployMethodOptions);
    competitorAccount
      .addResource("verify")
      .addMethod("POST", competitorAccountsIntegration, deployMethodOptions);
    competitorAccount
      .addResource("rotate-external-id")
      .addMethod("POST", competitorAccountsIntegration, deployMethodOptions);

    // Issue #839 follow-up Phase B: Tenant 管理者が画面 / API から SAML IdP を CRUD する経路。
    // 同 Lambda (competitor-accounts) に相乗りさせ、 IAM 拡張 (cognito-idp) は Lambda 側で済ませる。
    //   /admin/tenant-saml-config  GET=read / PUT=upsert / DELETE=disable
    const tenantSamlConfig = admin.addResource("tenant-saml-config");
    tenantSamlConfig.addMethod("GET", competitorAccountsIntegration, deployMethodOptions);
    tenantSamlConfig.addMethod("PUT", competitorAccountsIntegration, deployMethodOptions);
    tenantSamlConfig.addMethod("PATCH", competitorAccountsIntegration, deployMethodOptions);
    tenantSamlConfig.addMethod("DELETE", competitorAccountsIntegration, deployMethodOptions);

    // Issue #925 Phase 1: Tenant 内 user の CRUD (= 初期 admin だけでなく追加ユーザーを招待できる)。
    // 同 Lambda (competitor-accounts) に相乗りさせ、 Cognito AdminCreate / AdminDelete / ListUsers
    // 権限は Lambda 側で付与済。
    //   /admin/users                 GET=list / POST=invite
    //   /admin/users/{username}      DELETE=remove / PATCH=change role (Issue #17)
    const users = admin.addResource("users");
    users.addMethod("GET", competitorAccountsIntegration, deployMethodOptions);
    users.addMethod("POST", competitorAccountsIntegration, deployMethodOptions);
    const usersById = users.addResource("{username}");
    usersById.addMethod("DELETE", competitorAccountsIntegration, deployMethodOptions);
    usersById.addMethod("PATCH", competitorAccountsIntegration, deployMethodOptions);

    // Issue #1292: Tenant Admin 向け監査ログ read / CSV export。
    // EventApi handler 側の `/admin/audit-log*` route と同じ EventApi integration に公開する。
    // API Gateway resource が無いと request は Lambda に届かず、Gateway 自身の 403 に CORS
    // header が付かないため browser では response body ではなく "Failed to fetch" になる。
    const auditLog = admin.addResource("audit-log");
    auditLog.addMethod("GET", eventIntegration, deployMethodOptions);
    auditLog.addResource("export").addMethod("GET", eventIntegration, deployMethodOptions);

    // Issue #2410 Slice 2: イベント中の DynamoDB キャパ監視 (TenantAdmin のみ、GET=read)。
    // Issue #2680: 同じ resource に POST (= SSM runbook 起動でキャパ変更) を追加。
    // EventApi handler 側の `/admin/capacity` route と同じ EventApi integration に公開する
    // (resource が無いと Gateway 403 に CORS が付かず browser が "Failed to fetch" になる、
    // Issue #1292 audit-log と同じ理由)。
    const capacity = admin.addResource("capacity");
    capacity.addMethod("GET", eventIntegration, deployMethodOptions);
    capacity.addMethod("POST", eventIntegration, deployMethodOptions);

    // Issue #2231 (ADR-035): per-tenant runtime feature-flag overrides, served by the same
    // EventApi handler as /admin/audit-log and /admin/capacity.
    //   GET  /feature-flags        readable by any tenant role (gates UI tabs for all roles)
    //   PUT  /admin/feature-flags  TenantAdmin-only full-replace of the override set
    // Both Gateway resources must exist or the request 403s before reaching the Lambda with no
    // CORS header, which the console surfaces as "フィーチャーフラグの取得に失敗しました" — the
    // same failure mode as the #1292 audit-log / #2410 capacity routes above.
    this.restApi.root
      .addResource("feature-flags")
      .addMethod("GET", eventIntegration, deployMethodOptions);
    admin.addResource("feature-flags").addMethod("PUT", eventIntegration, deployMethodOptions);

    // Issue #1312: per-tenant SAML IdP CRUD route。 Application Plane (silo / Lite) のみ有効。
    //   /tenant/idp                  GET=list / POST=create
    //   /tenant/idp/{idpId}          GET=detail / PATCH=update / DELETE=remove
    //
    // 同 Cognito authorizer を共有して JWT claim 由来 tenantId で越境防止 (= idp-handler 側で
    // `resolveScope` が claim から tenantId を取り、 SamlIdpsTable の `pk = tenantId` で固定)。
    // pooled tier (= UserPool 共有) で誤起動すると cross-tenant 副作用が出るため、 handler の
    // `IDP_TIER_GUARD` env が `"silo"` 以外なら 503 を返す fail-closed guard で防ぐ。
    if (props.samlIdpLambda) {
      const idpIntegration = this.proxyIntegrationFor(
        "ApiGatewayInvokeSamlIdpRoutes",
        props.samlIdpLambda,
      );
      const tenant = this.restApi.root.addResource("tenant");
      const idp = tenant.addResource("idp");
      idp.addMethod("GET", idpIntegration, deployMethodOptions);
      idp.addMethod("POST", idpIntegration, deployMethodOptions);
      const idpById = idp.addResource("{idpId}");
      idpById.addMethod("GET", idpIntegration, deployMethodOptions);
      idpById.addMethod("PATCH", idpIntegration, deployMethodOptions);
      idpById.addMethod("DELETE", idpIntegration, deployMethodOptions);
    }
  }
}
