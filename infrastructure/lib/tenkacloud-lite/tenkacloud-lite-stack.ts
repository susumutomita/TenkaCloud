import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { buildAppPlaneCore } from "../app-plane-core/index.js";

/**
 * Issue #778 ADR-016 Phase 3: TenkaCloud Lite mode の専用 stack。
 *
 * AppPlaneCore (tenantId=local) を 1 つ立てて Application Admin Console + tenant API
 * + Cognito Hosted UI を自己完結で deploy する。 ControlPlaneStack / BootstrapTemplateStack
 * / ServerlessSaaSPipeline / AdminConsoleInsightStack には依存しない (= SBT のフル機能を
 * 持ち込まない、 競技者 1 tenant 固定で OSS / Product Hunt 向け体験を整える)。
 *
 * ProblemDeployBackendStack (= 問題 deploy backend + Participant Portal) は本 stack の
 * 外で兄弟 stack として立て、 deployApiLambda / eventApiLambda /
 * competitorAccountsApiLambda / participantPortalUrl を cross-stack で渡し込む。
 * ProblemDeployBackend は `eventBusArn` を undefined にして local EventBus に倒すと
 * Lite mode で完結する (= Phase 2 で導入した optional 化、 PR-#791)。
 *
 * Phase 4 (= 後続 PR) で CLI runner (`scripts/tenkacloud-lite.ts`) が本 stack +
 * ProblemDeployBackend stack を 1 コマンドで deploy する経路を整備する。
 */
export interface TenkaCloudLiteStackProps extends StackProps {
  /** 環境名 (= development / staging / production)。 IdentityProvider が UserPool domain prefix に使う。 */
  readonly environment: string;
  /**
   * ProblemDeployBackendStack の DeployApi Lambda。 tenant API の `POST /problems/:id/deploy`
   * が cross-stack 経由で invoke する (= 既存 Full mode と同 wiring)。
   */
  readonly deployApiLambda: IFunction;
  /** ProblemDeployBackendStack の EventApi Lambda。 tenant API の `/events*` route が invoke。 */
  readonly eventApiLambda: IFunction;
  /** ProblemDeployBackendStack の CompetitorAccountsApi Lambda。 tenant API の `/admin/competitor-accounts*` route が invoke。 */
  readonly competitorAccountsApiLambda: IFunction;
  /** Participant Portal の CloudFront URL (= application-admin-console の runtime-config に注入)。 */
  readonly participantPortalUrl?: string;
  /**
   * Issue #1053: 競技者向け CFn bootstrap template (`competitor-bootstrap.yaml`) の S3 URL。
   * `ProblemDeployBackendStack.competitorBootstrapTemplateUrl` を cross-stack ref で受け取り、
   * `buildAppPlaneCore` 経由で `ApplicationAdminConsoleHosting` の runtime-config に焼く。
   */
  readonly competitorBootstrapTemplateUrl: string;
  // Issue #1066: SAML IdP 連携は廃止 (= MFA 必須化 #1035 で代替)。
}

/**
 * Lite mode が固定的に使う tenantId / tenantName。
 *
 * Lite mode は 1 tenant 専用なので、 SBT の動的 tenant 作成 (= TenantTemplateStack の
 * pooled / silo 切替) を必要としない。 frontend が `tenantId === "local"` を判定 signal
 * として使う場面が出てきたら、 ここの値を起点に分岐する。
 */
const LITE_TENANT_ID = "local" as const;
const LITE_TENANT_NAME = "TenkaCloud Lite" as const;

export class TenkaCloudLiteStack extends Stack {
  /** application-admin-console の CloudFront URL (= CLI が `tenkacloud lite up` 完了時に echo する)。 */
  public readonly applicationAdminConsoleUrl: string;
  /** Cognito Hosted UI domain URL (= 競技者 onboarding 用)。 */
  public readonly cognitoDomainUrl: string;
  /** tenant API の REST URL。 frontend が deploy / event CRUD に使う。 */
  public readonly tenantApiUrl: string;

  constructor(scope: Construct, id: string, props: TenkaCloudLiteStackProps) {
    super(scope, id, props);

    // Lite mode は SBT の tier API key (= basic / standard / premium / platinum SSM
    // Parameter) を使わない。 ApiGateway construct は CustomApiKey 4 つを必須引数で
    // 受けるので、 placeholder 文字列を渡して Usage Plan が作られても dormant な状態に
    // する (= Lite で API key 経路を使わない方針、 Phase 4-5 で ApiGateway 側に
    // apiKeyConfig?: undefined を許容する path を追加する想定)。
    const liteApiKeyPlaceholder = `tenkacloud-lite-${props.environment}-placeholder`;
    const dummyLookup = (): string => liteApiKeyPlaceholder;

    const appPlane = buildAppPlaneCore(this, {
      tenantId: LITE_TENANT_ID,
      tenantName: LITE_TENANT_NAME,
      environment: props.environment,
      isPooledDeploy: false,
      deployApiLambda: props.deployApiLambda,
      eventApiLambda: props.eventApiLambda,
      competitorAccountsApiLambda: props.competitorAccountsApiLambda,
      participantPortalUrl: props.participantPortalUrl,
      competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
      apiKeyConfig: {
        ssmParameterNames: {
          basic: { keyId: `${liteApiKeyPlaceholder}-basic-id`, value: liteApiKeyPlaceholder },
          standard: { keyId: `${liteApiKeyPlaceholder}-standard-id`, value: liteApiKeyPlaceholder },
          premium: { keyId: `${liteApiKeyPlaceholder}-premium-id`, value: liteApiKeyPlaceholder },
          platinum: { keyId: `${liteApiKeyPlaceholder}-platinum-id`, value: liteApiKeyPlaceholder },
        },
        ssmLookup: dummyLookup,
      },
    });

    this.applicationAdminConsoleUrl = appPlane.applicationAdminConsoleUrl;
    this.cognitoDomainUrl = appPlane.identityProvider.cognitoDomainUrl;
    this.tenantApiUrl = appPlane.apiGateway.restApi.url;

    new CfnOutput(this, "ApplicationAdminConsoleUrl", {
      value: this.applicationAdminConsoleUrl,
      description:
        "TenkaCloud Lite の Application Admin Console URL (= CLI `tenkacloud lite up` 完了時に echo)。",
    });
    new CfnOutput(this, "CognitoDomainUrl", {
      value: this.cognitoDomainUrl,
      description:
        "Lite Cognito Hosted UI base URL (= competitor が OAuth Code+PKCE で login する)。",
    });
    new CfnOutput(this, "TenantApiUrl", {
      value: this.tenantApiUrl,
      description:
        "Lite tenant API URL (= application-admin-console / participant-portal から叩く)。",
    });
    new CfnOutput(this, "TenantId", {
      value: LITE_TENANT_ID,
      description:
        "Lite は 1 tenant 固定 (= `local`)。 frontend が tenant 切替 UI を出さない signal。",
    });
  }
}
