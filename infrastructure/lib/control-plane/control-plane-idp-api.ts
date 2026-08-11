import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import { type HttpApi, HttpMethod, type IHttpRouteAuthorizer } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { controlDataRuntimeEnv } from "../problem-deploy/control-data-backend-env.js";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface ControlPlaneIdpApiProps {
  /**
   * SBT `ControlPlaneAPI` の HttpApi。 `/admin/idp*` route を **同 API に相乗り** させる
   * (= admin-console が `config.apiBaseUrl` (= tenant CRUD と同じ origin) にそのまま投げる契約)。
   */
  readonly httpApi: HttpApi;
  /**
   * SBT `ControlPlaneAPI.jwtAuthorizer` (= `tenantsAuthorizer`)。
   *
   * SBT の HttpApi は `corsPreflight` だけを設定して生成されており **`defaultAuthorizer` を持たない**
   * (`@cdklabs/sbt-aws` control-plane-api.js)。 したがって route ごとに明示的に渡す必要があり、
   * 渡し忘れた route は **無認証で公開される** — 直そうとしている 404 より悪い。 test 側は route の
   * 存在ではなく `AuthorizationType: "JWT"` を assert して固定する。
   */
  readonly authorizer: IHttpRouteAuthorizer;
  /**
   * Control Plane UserPool (= SBT `CognitoAuth` が作る System Admin pool)。 handler は
   * `CONTROL_PLANE_USER_POOL_ID` env で受け、 cognito-adapter が本 pool に対して
   * `CreateIdentityProvider` 等を mutate する。
   */
  readonly userPool: IUserPool;
  /**
   * System scope (`pk = "SYSTEM"`) の IdP store。 `controlDataBackend` が純 SQL (`turso`) のときは
   * `ControlPlaneStack` が table を synth しない (= `undefined`) — その場合 env も grant も足さず、
   * repository seam (`createSeamIdpStore` → `resolveSamlIdpsRepository`) が Turso executor 経由で
   * 処理する。 resolver は table 名の有無ではなく `CONTROL_DATA_BACKEND` で分岐するため、
   * 純 SQL 経路で table 名が空でも runtime は正しく SQL 側に落ちる。
   */
  readonly samlIdpsTable?: Table;
  /** control-plane data backend (dynamodb|turso)。 default は env を足さず byte 互換。 */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL (turso backend のみ)。 */
  readonly tursoDatabaseUrl?: string;
  /** libSQL auth token を持つ SSM SecureString parameter 名 (turso backend のみ)。 */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Control Plane SAML IdP CRUD API (`/admin/idp*`) — Issue #1293 の CDK 配線。
 *
 * handler (`control-plane/handlers/idp-handler/index.ts`) と test は #1293 で揃っていたが、
 * どの construct からも instantiate されておらず SaaS には `/admin/idp` API が存在しなかった。
 * admin-console の「ID プロバイダ」画面は `CDK_PARAM_FEATURES={"samlSso":true}` だけで開くため、
 * フラグが UI を点けて API を点けない状態になり、 ブラウザには `Failed to fetch` としか出なかった
 * (API Gateway は未マッチ 404 に CORS header を付けないため、 preflight を通った本 request が
 * CORS エラーに化ける = PR-683 と同じ失敗)。
 *
 * SaaS 固有の理由で `problem-deploy/saml-idp-lambda.ts` (Application Plane / Lite 用) を
 * 再利用せず別 construct にしている:
 *   - env 名が違う (`CONTROL_PLANE_USER_POOL_ID` vs `TENANT_USER_POOL_ID`)
 *   - Control Plane は system scope 固定で `IDP_TIER_GUARD` を持たない
 *   - Lite の synth 出力を変えないため、共有 construct にはしない
 * IAM statement の重複だけは {@link samlIdpCognitoCrudStatement} / {@link tursoSsmReadStatement}
 * に集約して drift を防ぐ (= `controlDataBackendEnv` と同じ集約方針)。
 *
 * route は `features.samlSso` で gate **しない**。 gate すると feature flag は
 * `AdminConsoleRuntimeConfigStack` 経由で UI に、 `AppConfig` 経由で infra に届く 2 経路になり、
 * runtime-config だけ再 deploy した瞬間に「UI 点灯 + API 不在」= 今回のバグが再生産される。
 * Lite が `attachSamlIdpLambda: true` を無条件に渡しているのと同じ扱い (= parity)。
 */
export class ControlPlaneIdpApi extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ControlPlaneIdpApiProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/idp-handler/index.ts"),
      // SAML CRUD は admin 操作のみで極低 QPS / 短時間 (= saml-idp-lambda.ts と同 sizing)。
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        // 純 SQL backend では table 自体が無いので env も足さない (handler 側は optional 扱い)。
        ...(props.samlIdpsTable ? { SAML_IDPS_TABLE_NAME: props.samlIdpsTable.tableName } : {}),
        CONTROL_PLANE_USER_POOL_ID: props.userPool.userPoolId,
        ...controlDataRuntimeEnv(props),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // DDB: 全 CRUD 経路 (list / get / put / delete) で R+W が必要。純 SQL backend では grant なし。
    props.samlIdpsTable?.grantReadWriteData(this.fn);

    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(tursoSsmReadStatement(stack, props.tursoAuthTokenParameterName));
    }

    this.fn.addToRolePolicy(samlIdpCognitoCrudStatement(stack));

    const integration = new HttpLambdaIntegration("ControlPlaneIdpIntegration", this.fn);

    // handler (routes.ts) が生やす path は `/admin/idp`, `/admin/idp/healthz`, `/admin/idp/:idpId`。
    // `{idpId}` が healthz も拾い、 Hono が raw path で再 routing するので 2 route で全経路を覆う。
    //
    // **authorizer を必ず対で渡すこと**: SBT の HttpApi に defaultAuthorizer は無いため、
    // 省略した route は無認証で `/admin/idp` を晒す。
    props.httpApi.addRoutes({
      path: "/admin/idp",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration,
      authorizer: props.authorizer,
    });
    props.httpApi.addRoutes({
      path: "/admin/idp/{idpId}",
      methods: [HttpMethod.GET, HttpMethod.PATCH, HttpMethod.DELETE],
      integration,
      authorizer: props.authorizer,
    });
  }
}

/**
 * Cognito IdP CRUD grant。 IAM resource は具体 UserPool ARN ではなく同 account / region 配下の
 * wildcard で、 実 pool の絞り込みは runtime の `CONTROL_PLANE_USER_POOL_ID` env
 * (cognito-adapter) が行う — `competitor-accounts-api-lambda.ts` / `saml-idp-lambda.ts` と同 pattern。
 */
export function samlIdpCognitoCrudStatement(stack: Stack): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
      "cognito-idp:CreateIdentityProvider",
      "cognito-idp:UpdateIdentityProvider",
      "cognito-idp:DescribeIdentityProvider",
      "cognito-idp:DeleteIdentityProvider",
      "cognito-idp:ListIdentityProviders",
    ],
    resources: [`arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/*`],
  });
}

/** turso backend が auth token を読むための SSM SecureString read 権限 (未配線なら付与しない)。 */
export function tursoSsmReadStatement(stack: Stack, parameterName: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["ssm:GetParameter"],
    resources: [
      `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/${parameterName.replace(/^\/+/, "")}`,
    ],
  });
}
