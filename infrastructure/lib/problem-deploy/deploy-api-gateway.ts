import { CfnOutput, Stack } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface DeployApiCognito {
  readonly userPoolId: string;
  readonly clientId: string;
}

export interface DeployApiGatewayProps {
  readonly cognito: DeployApiCognito;
  readonly deployHandler: IFunction;
  /** UI が CloudFront / localhost dev から fetch するため必須。 */
  readonly corsAllowOrigins: readonly string[];
}

/**
 * Deploy API の認証付き公開エンドポイント。HTTP API + Cognito JWT authorizer で
 * `custom:tenantId` 付き id_token を持つ caller のみ Lambda に到達する。
 *
 * 単一 User Pool を信頼する単純化。複数テナントが各自の Pool を使う構成では
 * custom Lambda authorizer + tenant→pool registry に置き換える。
 */
export class DeployApiGateway extends Construct {
  public readonly httpApi: HttpApi;
  public readonly authorizer: HttpJwtAuthorizer;

  constructor(scope: Construct, id: string, props: DeployApiGatewayProps) {
    super(scope, id);

    const { region } = Stack.of(this);
    const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${props.cognito.userPoolId}`;

    this.authorizer = new HttpJwtAuthorizer("DeployJwtAuthorizer", issuerUrl, {
      jwtAudience: [props.cognito.clientId],
      identitySource: ["$request.header.Authorization"],
    });

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: "TenkaCloud-DeployApi",
      description: "Deploy API for problem deployment.",
      corsPreflight: {
        allowOrigins: [...props.corsAllowOrigins],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
      },
    });

    const integration = new HttpLambdaIntegration("DeployLambdaIntegration", props.deployHandler);

    const routes: Array<{ path: string; methods: HttpMethod[] }> = [
      { path: "/problems/{problemId}/deploy", methods: [HttpMethod.POST] },
      { path: "/problems/{problemId}/deployments", methods: [HttpMethod.GET] },
      { path: "/deployments/{jobId}", methods: [HttpMethod.GET, HttpMethod.DELETE] },
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
