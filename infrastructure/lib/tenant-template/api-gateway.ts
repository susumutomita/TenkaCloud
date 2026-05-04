import * as path from "node:path";
import { Arn, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  LambdaIntegration,
  ResponseType,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import type { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import type { CustomApiKey } from "../interfaces/custom-api-key";
import type { IdentityDetails } from "../interfaces/identity-details";

/** Broker Entra (External Identities) plumbing for the AppsApiHandler. */
export interface BrokerEntraProps {
  /** SSM SecureString containing broker Entra Graph credentials JSON. */
  readonly graphParameterName?: string;
  /** SSM String prefix for per-tenant broker profile pointers. */
  readonly tenantConfigPrefix?: string;
  /** Microsoft Entra applicationTemplate ID for the broker Enterprise Application. */
  readonly applicationTemplateId?: string;
}

interface ApiGatewayProps {
  tenantId: string;
  isPooledDeploy: boolean;
  idpDetails: IdentityDetails;
  /**
   * アプリ管理 API を認可する Cognito UserPool (per-tenant)。
   * application-admin-console が保持する JWT を検証する。
   */
  userPool: IUserPool;
  /**
   * 同 UserPool の UserPoolClient。AppsApiHandler が per-app Lambda の Function URL を
   * callback URL に追加するために UpdateUserPoolClient を叩く。
   */
  userPoolClient: IUserPoolClient;
  /**
   * Cognito Hosted UI の base URL。per-app Lambda に env で渡す (OIDC flow で使用)。
   */
  cognitoDomainUrl: string;
  readonly brokerEntra?: BrokerEntraProps;
  /**
   * AppsTable の billing mode。
   *   - `PROVISIONED` (default): `appsTableReadCapacity` / `appsTableWriteCapacity` を使う
   *   - `PAY_PER_REQUEST`: capacity 指定は無視される
   * caller (bin) が `environments/<env>/config.json` の `dynamoDbConfig.billingMode` から読み出す。
   */
  readonly appsTableBillingMode?: BillingMode;
  /**
   * AppsTable provisioned read/write capacity。**caller (bin) で config.json + env から読む** 設計
   * のため Stack 側に default fallback を置かない (default 発生源を単一箇所に閉じる)。
   * `appsTableBillingMode = PROVISIONED` 時のみ使用。
   */
  readonly appsTableReadCapacity?: number;
  readonly appsTableWriteCapacity?: number;
  apiKeyBasicTier: CustomApiKey;
  apiKeyStandardTier: CustomApiKey;
  apiKeyPremiumTier: CustomApiKey;
  apiKeyPlatinumTier: CustomApiKey;
}

/**
 * テナントの Application 管理 API (#40-b / #40-c)。
 *
 *   - POST   /apps            : auth-proxy Lambda を per-app に動的作成 + Function URL
 *                               払い出し + Cognito callback URL 追加 + DDB put
 *   - GET    /apps            : 自テナントの登録アプリ一覧
 *   - DELETE /apps/{appId}    : per-app Lambda 削除 + callback URL 除外 + DDB delete
 *
 * Authorizer は per-tenant の Cognito UserPool。JWT の `custom:tenantId` を
 * backend Lambda が読み、自テナントの item のみ操作できるよう制御する。
 *
 * auth-proxy 本体 (apps/auth-proxy/dist/lambda) は Asset として CDK staging bucket に
 * 自動アップロードされ、backend Lambda が CreateFunction 時に S3Bucket/S3Key として参照する。
 *
 * Apps DDB table は (tenantId, appId) composite key。silo stack では tenantId は
 * 固定値だが、pooled stack で複数テナントが共存するケースに備え同じ schema を使う。
 */
export class ApiGateway extends Construct {
  public readonly restApi: RestApi;
  public readonly appsTable: Table;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    // memory: コスト 0 原則。default は PROVISIONED 1/1 (Free Tier の 25 RCU/WCU 枠内)。
    // training/demo 用途で write < 1 RPS 想定なので throttling リスクは無視できる。
    // billing mode / capacity は config.json (`dynamoDbConfig`) + .env で override 可能。
    const appsTableBillingMode = props.appsTableBillingMode ?? BillingMode.PROVISIONED;
    this.appsTable = new Table(this, "AppsTable", {
      partitionKey: { name: "tenantId", type: AttributeType.STRING },
      sortKey: { name: "appId", type: AttributeType.STRING },
      billingMode: appsTableBillingMode,
      // capacity は PROVISIONED のときだけ指定 (PAY_PER_REQUEST と同時指定は CDK でエラー)
      ...(appsTableBillingMode === BillingMode.PROVISIONED
        ? {
            readCapacity: props.appsTableReadCapacity,
            writeCapacity: props.appsTableWriteCapacity,
          }
        : {}),
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // auth-proxy の Lambda zip を CDK asset として staging。backend Lambda が
    // CreateFunction 時に S3Bucket/S3Key として参照する。install.sh が
    // apps/auth-proxy を bun build してこのパスに dist/lambda を配置する想定。
    const authProxyAsset = new Asset(this, "AuthProxyAsset", {
      path: path.join(__dirname, "..", "..", "..", "apps", "auth-proxy", "dist", "lambda"),
    });

    // per-app auth-proxy Lambda 用の共通 execution role (テナント内の全 app で共有)。
    // OIDC client + JIT invitation のため SSM SecureString (broker creds) を読む。
    const perAppLambdaRole = new Role(this, "PerAppLambdaRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
      description: `Execution role for per-app auth-proxy Lambdas (tenant ${props.tenantId})`,
    });
    // JIT invitation: per-app Lambda が broker creds を SSM から取って Microsoft
    // Graph で invite するために必要。読み取りは broker-entra path 配下のみに scope。
    if (props.brokerEntra?.graphParameterName) {
      perAppLambdaRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ssm:GetParameter"],
          resources: [
            Arn.format(
              {
                service: "ssm",
                resource: "parameter",
                resourceName: "TenkaCloud/broker-entra/*",
              },
              Stack.of(this),
            ),
          ],
        }),
      );
    }

    this.restApi = new RestApi(this, `TenantAPI-${props.tenantId}`, {
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    // Cognito Authorizer が 401/403 を返すとき、API Gateway は Lambda を呼ばない =
    // CORS ヘッダが無くなる。GatewayResponse で 4xx / 5xx 全てに CORS ヘッダを
    // 差し込んで、ブラウザ側が「no Access-Control-Allow-Origin」で死なないように
    // する (Chrome の Failed to fetch 対策)。
    for (const [id, type] of [
      ["Default4xx", ResponseType.DEFAULT_4XX],
      ["Default5xx", ResponseType.DEFAULT_5XX],
    ] as const) {
      this.restApi.addGatewayResponse(id, {
        type,
        responseHeaders: {
          "Access-Control-Allow-Origin": "'*'",
          "Access-Control-Allow-Headers": "'Content-Type,Authorization'",
        },
      });
    }

    const authorizer = new CognitoUserPoolsAuthorizer(this, "AppsApiAuthorizer", {
      cognitoUserPools: [props.userPool],
    });

    const handler = new LambdaFunction(this, "AppsApiHandler", {
      runtime: Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        APPS_TABLE: this.appsTable.tableName,
        AUTH_PROXY_BUCKET: authProxyAsset.s3BucketName,
        AUTH_PROXY_KEY: authProxyAsset.s3ObjectKey,
        PER_APP_LAMBDA_ROLE_ARN: perAppLambdaRole.roleArn,
        COGNITO_DOMAIN: props.cognitoDomainUrl,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        USER_POOL_ID: props.userPool.userPoolId,
        ...(props.brokerEntra?.graphParameterName
          ? { BROKER_ENTRA_GRAPH_PARAMETER_NAME: props.brokerEntra.graphParameterName }
          : {}),
        ...(props.brokerEntra?.tenantConfigPrefix
          ? { BROKER_ENTRA_TENANT_CONFIG_PREFIX: props.brokerEntra.tenantConfigPrefix }
          : {}),
        ...(props.brokerEntra?.applicationTemplateId
          ? { BROKER_ENTRA_APPLICATION_TEMPLATE_ID: props.brokerEntra.applicationTemplateId }
          : {}),
      },
      code: Code.fromAsset(path.join(__dirname, "runtime", "apps-api-handler")),
    });
    this.appsTable.grantReadWriteData(handler);
    authProxyAsset.grantRead(handler);

    // per-app Lambda 作成・削除・Function URL 管理に必要な権限。
    //   - silo stack (isPooledDeploy = false、tenantId = 特定 UUID):
    //     同 tenant 配下の function 名 (TenkaCloud-app-{tenantId}-*) に scope
    //   - pooled stack (isPooledDeploy = true): 同 handler が複数テナントの
    //     function を扱う (function 名には JWT claim の実 tenantId が入る)
    //     ので TenkaCloud-app-* 全体に広げる必要がある。ビジネスロジック側
    //     (handler の tenantId 抽出) で tenant 境界は保つ
    const functionArnPattern = props.isPooledDeploy
      ? "arn:aws:lambda:*:*:function:TenkaCloud-app-*"
      : `arn:aws:lambda:*:*:function:TenkaCloud-app-${props.tenantId}-*`;
    handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:UpdateFunctionConfiguration",
          "lambda:CreateFunctionUrlConfig",
          "lambda:DeleteFunctionUrlConfig",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:TagResource",
          // waitUntilFunctionActiveV2 / waitUntilFunctionUpdatedV2 が
          // 内部で呼ぶ Read 系 (Pending / InProgress の状態遷移確認用)
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
        ],
        resources: [functionArnPattern],
      }),
    );
    handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [perAppLambdaRole.roleArn],
      }),
    );
    // Cognito UserPoolClient の callback URL 更新
    handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "cognito-idp:CreateIdentityProvider",
          "cognito-idp:DescribeIdentityProvider",
          "cognito-idp:DescribeUserPoolClient",
          "cognito-idp:UpdateIdentityProvider",
          "cognito-idp:UpdateUserPoolClient",
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );
    if (props.brokerEntra?.graphParameterName || props.brokerEntra?.tenantConfigPrefix) {
      const ssmParamArn = (name: string) =>
        Arn.format(
          { service: "ssm", resource: "parameter", resourceName: name.replace(/^\/+/, "") },
          Stack.of(this),
        );
      const tenantConfigPrefix = props.brokerEntra.tenantConfigPrefix ?? "/TenkaCloud/tenants";
      const graphParamName =
        props.brokerEntra.graphParameterName ??
        "/TenkaCloud/broker-entra/profiles/default/graph-credentials";
      handler.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ssm:GetParameter"],
          resources: [
            ssmParamArn("TenkaCloud/broker-entra/*"),
            ssmParamArn(`${tenantConfigPrefix}/*/broker-entra/config`),
            ssmParamArn(graphParamName),
          ],
        }),
      );
    }

    const integration = new LambdaIntegration(handler);
    const methodOptions = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer,
    };

    const apps = this.restApi.root.addResource("apps");
    apps.addMethod("POST", integration, methodOptions);
    apps.addMethod("GET", integration, methodOptions);

    const appItem = apps.addResource("{appId}");
    appItem.addMethod("DELETE", integration, methodOptions);
  }
}
