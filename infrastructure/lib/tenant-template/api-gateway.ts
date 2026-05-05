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

    // /deployments/{jobId}
    const deployments = this.restApi.root.addResource("deployments");
    const deployment = deployments.addResource("{jobId}");
    deployment.addMethod("GET", deployIntegration, deployMethodOptions);
    deployment.addMethod("DELETE", deployIntegration, deployMethodOptions);
  }
}
