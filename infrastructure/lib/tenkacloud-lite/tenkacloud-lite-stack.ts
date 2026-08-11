import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { buildAppPlaneCore } from "../app-plane-core/index.js";
import { dataTableRemovalPolicy } from "../problem-deploy/data-table-removal-policy.js";
import { SamlIdpsTable } from "../problem-deploy/saml-idps-table.js";
import type { SamlIdpConfig } from "../tenant-template/saml-identity-providers.js";

/**
 * Issue #778: TenkaCloud Lite mode の専用 stack。
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
  /**
   * Issue #1340 Phase 2: opt-in per-tenant SAML IdP 群 (= env `TENANT_SAML_IDPS` を parse 済)。
   * Lite mode は単一 tenant の 1 UserPool 固定なので、 silo / per-tenant deploy と同じ扱いで
   * attach できる (= pooled 経路は持たない)。 未指定 / 空配列なら従来 Cognito local auth + MFA のみ。
   */
  readonly samlIdps?: readonly SamlIdpConfig[];
  /**
   * Issue #1340 Phase 2: federated 管理者 allowlist (`provider/email`)。 `samlIdps` 設定時のみ意味を持つ。
   * 空配列 = federated sign-in 全拒否 (fail-safe)。
   */
  readonly samlAdminAllowlist?: readonly string[];
  /** Issue #2230: runtime-config.json に焼く SPA feature flag override (未設定 = key なし)。 */
  readonly features?: Readonly<Record<string, boolean>>;
  /**
   * [Issue #2442] control-plane data backend
   * (dynamodb|turso)。 純 SQL (`turso`) のときは
   * `SamlIdpsTable` を synth しない (= DynamoDB standing cost をゼロにする A5/B6/C1-C4 と同じ
   * 条件)。 default 未指定 / `dynamodb` は既存 CFn と byte 互換。
   */
  readonly controlDataBackend?: string;

  /**
   * [Issue #2959] control-data DDB table を stack 削除後も残すか。未指定 / false は
   * DESTROY (= 既定)。`AppConfig.retainDataTables` をそのまま渡す。
   */
  readonly retainDataTables?: boolean;
  /** [Issue #2442 / Phase C5] Public remote libSQL URL — `controlDataBackend` が turso のとき必須。 */
  readonly tursoDatabaseUrl?: string;
  /** [Issue #2442 / Phase C5] Turso auth token を格納する SSM SecureString parameter 名。 */
  readonly tursoAuthTokenParameterName?: string;
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
  /**
   * Issue #1340 Phase 2: tenant UserPool ID (= 文字列、 sign-in audit Lambda の EventBridge
   * rule filter に渡す cross-stack ref 用)。 Lite mode で SAML attach した tenant UserPool への
   * sign-in event を別 stack が listen するためのフック。
   */
  public readonly tenantUserPoolId: string;
  /**
   * Issue #1340 Phase 2: per-tenant SAML HRD directory。 SAML 未設定なら空 object。
   * 既に runtime-config.json に焼かれているため stack 外公開は cross-stack 配線テスト用。
   */
  public readonly samlIdpDirectory: Readonly<Record<string, readonly string[]>>;

  constructor(scope: Construct, id: string, props: TenkaCloudLiteStackProps) {
    super(scope, id, props);

    // Lite mode は SBT の tier API key (= basic / standard / premium / platinum SSM
    // Parameter) を使わない。 ApiGateway construct は CustomApiKey 4 つを必須引数で
    // 受けるので、 placeholder 文字列を渡して Usage Plan が作られても dormant な状態に
    // する (= Lite で API key 経路を使わない方針、 Phase 4-5 で ApiGateway 側に
    // apiKeyConfig?: undefined を許容する path を追加する想定)。
    const liteApiKeyPlaceholder = `tenkacloud-lite-${props.environment}-placeholder`;
    const dummyLookup = (): string => liteApiKeyPlaceholder;

    // Issue #1312: SAML IdP CRUD 用 DDB Table を本 stack で立て、 AppPlaneCore に渡す。
    // helper は `attachSamlIdpLambda: true` 受け取り時に同 stack 内で `SamlIdpLambda` を立て、
    // ApiGateway に `/tenant/idp*` route を配線する (= UserPool と SAML IdP Lambda を同 stack
    // 同居させて cross-stack cyclic dependency を避ける契約)。
    //
    // [Issue #2442 / Phase C5] `controlDataBackend` が純 SQL (`turso`) のときは本 table を
    // **synth しない** (= `undefined`) — DynamoDB standing cost をゼロにする A5/B6/C1-C4 と同じ
    // 条件。 IdP CRUD API 自体は `attachSamlIdpLambda: true` を常に渡すため table の有無に
    // 関わらず提供され続ける (= repository seam 経由で SQL executor に直結する)。
    const pureSql = props.controlDataBackend === "turso";
    const samlIdps = pureSql
      ? undefined
      : new SamlIdpsTable(this, "SamlIdps", {
          removalPolicy: dataTableRemovalPolicy(props.retainDataTables),
        });

    const appPlane = buildAppPlaneCore(this, {
      features: props.features,
      tenantId: LITE_TENANT_ID,
      tenantName: LITE_TENANT_NAME,
      environment: props.environment,
      isPooledDeploy: false,
      deployApiLambda: props.deployApiLambda,
      eventApiLambda: props.eventApiLambda,
      competitorAccountsApiLambda: props.competitorAccountsApiLambda,
      samlIdpsTable: samlIdps?.table,
      attachSamlIdpLambda: true,
      controlDataBackend: props.controlDataBackend,
      tursoDatabaseUrl: props.tursoDatabaseUrl,
      tursoAuthTokenParameterName: props.tursoAuthTokenParameterName,
      participantPortalUrl: props.participantPortalUrl,
      competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
      // Issue #1340 Phase 2: env-driven SAML attach (Lite mode は単一 tenant なので
      // pooled / silo の判定不要、 そのまま渡す)。 未指定なら no-op。
      samlIdps: props.samlIdps ?? [],
      samlAdminAllowlist: props.samlAdminAllowlist ?? [],
      // Issue #1327: Lite mode は 1 tenant 専用 (tenantId="local") なので全 user が
      // 暗黙に TenantAdmin。 Cognito Pre-Token Generation trigger で JWT 発行時に
      // `custom:userRole=TenantAdmin` + `custom:tenantId=local` を注入し、
      // SAML IdP / 監査ログ ページの `requireRole(c, [TENANT_ADMIN_ROLE])` を成立させる。
      // SaaS mode (= TenantTemplateStack) では本 flag は未指定 (= attach なし)。
      liteAdminClaimsInjection: true,
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
    this.tenantUserPoolId = appPlane.identityProvider.tenantUserPool.userPoolId;
    this.samlIdpDirectory = appPlane.samlIdpDirectory;

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
