import { RestApi } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import type { CustomApiKey } from "../interfaces/custom-api-key";
import type { IdentityDetails } from "../interfaces/identity-details";

interface ApiGatewayProps {
  tenantId: string;
  isPooledDeploy: boolean;
  idpDetails: IdentityDetails;
  apiKeyBasicTier: CustomApiKey;
  apiKeyStandardTier: CustomApiKey;
  apiKeyPremiumTier: CustomApiKey;
  apiKeyPlatinumTier: CustomApiKey;
}

/**
 * テナントの REST API のプレースホルダ。
 *
 * ProtoShip では `POST /apps` 系で auth-proxy + per-app Lambda を spawn する設計
 * だったが、TenkaCloud は GameDay / JAM 専用なので auth-proxy / sample / per-app
 * Lambda は不要。本ファイルはまず空の RestApi を立て、Phase 2 で GameDay 固有の
 * route (events, problems, scoring, leaderboard 等) を足していく。
 *
 * RestApi にメソッドが 1 つも無いと CFn の deployment が作れないので、dummy root
 * GET を置いておく (Mock integration で常に 200)。
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

    // 1 メソッド以上が必要。Phase 2 で GameDay route が追加されたら不要になる。
    this.restApi.root.addMethod("GET", undefined, { apiKeyRequired: false });
  }
}
