import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { CustomApiKey } from "../interfaces/custom-api-key";
import type { IdentityDetails } from "../interfaces/identity-details";

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
   * `LambdaIntegration` で本 Lambda を invoke する。
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
   * `ProblemDeployBackendStack.microserviceMigrationRegistrationApiLambda` のクロススタック参照
   * (Issue #606 Phase 2)。`/problems/microservice-migration-battle/endpoints` route を proxy する。
   */
  microserviceMigrationRegistrationApiLambda: IFunction;
  apiKeyBasicTier: CustomApiKey;
  apiKeyStandardTier: CustomApiKey;
  apiKeyPremiumTier: CustomApiKey;
  apiKeyPlatinumTier: CustomApiKey;
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

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    this.restApi = new RestApi(this, `TenantAPI-${props.tenantId}`, {
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, "TenantCognitoAuthorizer", {
      cognitoUserPools: [props.userPool],
      authorizerName: `TenantAuth-${props.tenantId}`,
    });

    const deployIntegration = new LambdaIntegration(props.deployApiLambda);
    const deployMethodOptions = {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    } as const;

    // /problems/{problemId}
    const problems = this.restApi.root.addResource("problems");
    const problem = problems.addResource("{problemId}");
    problem.addResource("deploy").addMethod("POST", deployIntegration, deployMethodOptions);
    problem.addResource("deployments").addMethod("GET", deployIntegration, deployMethodOptions);

    // Issue #606 Phase 2: Microservice Migration Battle 専用の endpoint 登録 routes。
    //   /problems/microservice-migration-battle/endpoints  POST=登録 / GET=一覧 + 観測結果
    // tenant API GW の Cognito JWT authorizer を共有。registration Lambda 自体は
    // ProblemDeployBackendStack 側に置き、本 API GW は LambdaIntegration で proxy する。
    const microserviceMigrationIntegration = new LambdaIntegration(
      props.microserviceMigrationRegistrationApiLambda,
    );
    const microserviceMigrationProblem = problems.addResource("microservice-migration-battle");
    const microserviceMigrationEndpoints = microserviceMigrationProblem.addResource("endpoints");
    microserviceMigrationEndpoints.addMethod(
      "POST",
      microserviceMigrationIntegration,
      deployMethodOptions,
    );
    microserviceMigrationEndpoints.addMethod(
      "GET",
      microserviceMigrationIntegration,
      deployMethodOptions,
    );

    // /deployments — tenant 内全 deploy job 一覧 (サイドバー「デプロイ履歴」用)
    // /deployments/{jobId} — 1 件の取得 / 削除
    const deployments = this.restApi.root.addResource("deployments");
    deployments.addMethod("GET", deployIntegration, deployMethodOptions);
    const deployment = deployments.addResource("{jobId}");
    deployment.addMethod("GET", deployIntegration, deployMethodOptions);
    deployment.addMethod("DELETE", deployIntegration, deployMethodOptions);

    // ADR-004 Phase 1+2a/2b: /events — 1 競技イベント = 1 行で teams + problems を持つ
    // /events                          POST  = create   / GET = list
    // /events/{eventId}                GET   = detail   / DELETE = bulk teardown
    // /events/{eventId}/deploy         POST  = bulk deploy (teams × problems を fan-out)
    // /events/{eventId}/schedule       PATCH = 競技開始時刻 (startsAt) を設定 (Phase 2b 追加)
    // /events/{eventId}/end            POST  = Event を ENDED 状態にし採点を停止 (Issue #494)
    // /events/{eventId}/notifications  POST  = 運営 → 競技者 通知 1 件作成 (ADR-006、#553)
    // /events/{eventId}/lock-scoring   POST  = 採点を lock (表彰フェーズ)、DELETE = unlock (#558)
    const eventIntegration = new LambdaIntegration(props.eventApiLambda);
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

    // Issue #459 / ADR-002 Phase 2.1: Competitor Accounts CRUD + verify
    //   /admin/competitor-accounts                                     POST=register, GET=list
    //   /admin/competitor-accounts/{awsAccountId}                      DELETE=remove (last row なら SSM 鍵も掃除)
    //   /admin/competitor-accounts/{awsAccountId}/verify               POST=STS AssumeRole sanity check
    //   /admin/competitor-accounts/{awsAccountId}/rotate-external-id   POST=ExternalId rotation (Issue #596 / Phase 3.1)
    const competitorAccountsIntegration = new LambdaIntegration(props.competitorAccountsApiLambda);
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
  }
}
