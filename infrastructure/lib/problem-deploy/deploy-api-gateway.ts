import { CfnOutput, Stack } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface DeployApiGatewayProps {
  /** Cognito User Pool ID (e.g. ap-northeast-1_AbCdEfGhI) */
  readonly cognitoUserPoolId: string;
  /** Cognito User Pool client ID — JWT audience として要求する */
  readonly cognitoClientId: string;
  /** 既存 Deploy API Lambda */
  readonly deployHandler: IFunction;
  /** CORS 許可 origins (UI が CloudFront / localhost から fetch してくる) */
  readonly corsAllowOrigins: readonly string[];
}

/**
 * Deploy API の認証付き公開エンドポイント。HTTP API + Cognito JWT authorizer で
 * `custom:tenantId` 付きの id_token を持っている caller のみ Lambda に到達する。
 *
 * Function URL (AWS_IAM) は ops 用にそのまま残し、本 API Gateway は UI / 外部
 * 呼び出し用の主経路。tenantId は authorizer.jwt.claims["custom:tenantId"] から
 * Lambda 側で取り出す (`handlers/deploy-handler/auth.ts`)。
 *
 * **multi-tenant 化 defer**: 現在は単一 User Pool を信頼する。テナントごとに
 * Pool が分かれる本番形態では custom Lambda authorizer + tenant pool registry
 * (DDB) に置き換える。後続 PR で対応。
 */
export class DeployApiGateway extends Construct {
  public readonly httpApi: HttpApi;
  public readonly authorizer: HttpJwtAuthorizer;

  constructor(scope: Construct, id: string, props: DeployApiGatewayProps) {
    super(scope, id);

    const { region } = Stack.of(this);
    const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${props.cognitoUserPoolId}`;

    this.authorizer = new HttpJwtAuthorizer("DeployJwtAuthorizer", issuerUrl, {
      jwtAudience: [props.cognitoClientId],
      identitySource: ["$request.header.Authorization"],
    });

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: "TenkaCloud-DeployApi",
      description: "Deploy API for problem deployment (POST/GET).",
      corsPreflight: {
        allowOrigins: [...props.corsAllowOrigins],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowCredentials: false,
        maxAge: undefined,
      },
    });

    const integration = new HttpLambdaIntegration("DeployLambdaIntegration", props.deployHandler);

    const routes: Array<{ path: string; methods: HttpMethod[] }> = [
      { path: "/problems/{problemId}/deploy", methods: [HttpMethod.POST] },
      { path: "/problems/{problemId}/deployments", methods: [HttpMethod.GET] },
      { path: "/deployments/{jobId}", methods: [HttpMethod.GET] },
    ];

    for (const route of routes) {
      this.httpApi.addRoutes({
        path: route.path,
        methods: route.methods,
        integration,
        authorizer: this.authorizer,
      });
    }

    new CfnOutput(this, "DeployApiGatewayUrl", {
      value: this.httpApi.apiEndpoint,
      description: "Deploy API HTTP API endpoint (Cognito JWT required).",
    });
  }
}
