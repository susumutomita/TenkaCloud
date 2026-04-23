import { RestApi } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import type { CustomApiKey } from "../interfaces/custom-api-key";
import type { IdentityDetails } from "../interfaces/identity-details";

interface ApiGatewayProps {
  apiKeyBasicTier: CustomApiKey;
  apiKeyStandardTier: CustomApiKey;
  apiKeyPremiumTier: CustomApiKey;
  apiKeyPlatinumTier: CustomApiKey;
  tenantId: string;
  isPooledDeploy: boolean;
  idpDetails: IdentityDetails;
}

/**
 * Per-tenant REST API のプレースホルダ。ref はここに Lambda Authorizer + Usage Plan +
 * microservice methods (Product/Order) を全部入れていたが、TenkaCloud は GameDay/JAM の
 * microservice 群 (problem/gameday/scoring/leaderboard 等) をテナント別 Application Plane で
 * 動かすため、本 RestApi は単なる繋ぎとして残している。
 * TenantTemplateStack が ApiGatewayUrl を CfnOutput するためだけに必要な空 RestApi。
 */
export class ApiGateway extends Construct {
  public readonly restApi: RestApi;

  constructor(scope: Construct, id: string, _props: ApiGatewayProps) {
    super(scope, id);

    this.restApi = new RestApi(this, `TenantAPI-${_props.tenantId}`, {
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    // RestApi にメソッドが 1 つも無いと CloudFormation が deployment を作れないので、
    // dummy root GET を空で置いておく。auth-proxy に置き換えるまでの繋ぎ。
    // Mock integration: 常に 200 を返すだけ。
    this.restApi.root.addMethod("GET", undefined, { apiKeyRequired: false });
  }
}
