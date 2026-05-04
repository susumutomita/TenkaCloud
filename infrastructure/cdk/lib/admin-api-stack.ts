import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface AdminApiStackProps extends cdk.StackProps {
  /** Cognito UserPool issuer URL (例: https://cognito-idp.<region>.amazonaws.com/<pool-id>) */
  readonly jwtIssuer: string;
  /** Cognito UserPool client ID — JWT audience として検証される */
  readonly jwtAudience: string;
  /** AdminConsole CloudFront origin (例: https://xxx.cloudfront.net)。CORS で許可。
   *  まだ未設定の場合は dev origin のみ許可する。 */
  readonly adminConsoleOrigin?: string;
  /** DynamoDB プロビジョン値 (memory: on-demand 禁止) */
  readonly dynamoReadCapacity?: number;
  readonly dynamoWriteCapacity?: number;
}

/**
 * Control Plane 向け Admin API Stack。
 *
 * **目的**: AdminWeb (CloudFront) から各 microservice を **API Gateway 経由で** 呼び出せるようにする。
 *
 * **セキュリティ設計**:
 * 1. **API Gateway Cognito JWT Authorizer** — Lambda 起動前に gateway 層で JWT 検証。
 *    トークン無し/無効な request は Lambda に到達しない。
 * 2. **CORS は CloudFront origin と localhost dev のみ許可** — `*` 不可。
 * 3. **各 Lambda は個別 IAM Role** — service の DynamoDB のみ許可、`lambda:InvokeFunction` 一切付けない。
 *    service 間で互いを直接 invoke することはできない。
 * 4. **service 間通信は API Gateway 経由のみ** — 必要になったら IAM_AUTH route を別途追加。
 *
 * **deploy 前提**: 各 microservice の `dist/lambda/` (bun build した bundle) が存在すること。
 * install.sh が phase 0 で build する。
 */
export class AdminApiStack extends cdk.Stack {
  /** Shared DynamoDB table — exposed for cross-stack ref (ProblemDeployPipelineStack 等). */
  public readonly controlPlaneTable: Table;

  constructor(scope: Construct, id: string, props: AdminApiStackProps) {
    super(scope, id, props);

    // ── Shared DynamoDB Table ──────────────────────────────
    // ADR-007 (multi-tenant isolation) の single-table design。PK/SK にテナント ID を含める。
    // memory: DynamoDB は必ず provisioned (on-demand 禁止)。
    const table = new Table(this, "ControlPlaneTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: props.dynamoReadCapacity ?? 1,
      writeCapacity: props.dynamoWriteCapacity ?? 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });
    // GSI1: テナント別クエリ (AGENTS.md の DB 設計参照)
    this.controlPlaneTable = table;
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      readCapacity: props.dynamoReadCapacity ?? 1,
      writeCapacity: props.dynamoWriteCapacity ?? 1,
    });

    // ── HTTP API Gateway ──────────────────────────────────
    const allowedOrigins = ["http://localhost:13000"];
    if (props.adminConsoleOrigin) {
      allowedOrigins.push(props.adminConsoleOrigin);
    }

    const httpApi = new HttpApi(this, "AdminHttpApi", {
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        allowCredentials: false,
        maxAge: cdk.Duration.seconds(300),
      },
    });

    const authorizer = new HttpJwtAuthorizer("CognitoAuthorizer", props.jwtIssuer, {
      jwtAudience: [props.jwtAudience],
    });

    // ── Lambda 群 (microservice ごと) ──────────────────────
    // path-prefix table is mirrored in client/AdminWeb/lib/api/admin-api-client.ts.
    // Keep them in sync.
    const microservices = [
      { name: "tenant-management", pathPrefix: "/tenant-management" },
      { name: "problem-service", pathPrefix: "/problem" },
      { name: "gameday-service", pathPrefix: "/gameday" },
      { name: "battle-service", pathPrefix: "/battle" },
      { name: "scoring-service", pathPrefix: "/scoring" },
      { name: "leaderboard-service", pathPrefix: "/leaderboard" },
    ] as const;

    const microserviceRoot = path.resolve(__dirname, "..", "..", "..", "server", "microservices");

    for (const svc of microservices) {
      const distDir = path.join(microserviceRoot, svc.name, "dist", "lambda");
      const fn = new LambdaFunction(this, `${toPascal(svc.name)}Function`, {
        runtime: Runtime.NODEJS_20_X,
        handler: "lambda.handler",
        code: Code.fromAsset(distDir),
        memorySize: 512,
        timeout: cdk.Duration.seconds(30),
        logRetention: RetentionDays.ONE_WEEK,
        environment: {
          NODE_ENV: "production",
          DYNAMODB_TABLE_NAME: table.tableName,
          // 各 service の auth middleware が JWT 検証に使う (Cognito issuer)
          JWKS_URI: `${props.jwtIssuer}/.well-known/jwks.json`,
          JWT_ISSUER: props.jwtIssuer,
          JWT_AUDIENCE: props.jwtAudience,
          // CORS (Hono 側) は API Gateway より緩いと意味が無いので合わせる
          ALLOWED_ORIGIN: props.adminConsoleOrigin ?? "",
        },
      });

      // 各 Lambda は **共有 table の R/W のみ** 許可。`lambda:InvokeFunction` は与えない →
      // service 間で勝手に invoke できない。
      table.grantReadWriteData(fn);

      // path-prefix で route。`/{prefix}/{proxy+}` を full proxy として登録。
      httpApi.addRoutes({
        path: `${svc.pathPrefix}/{proxy+}`,
        methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE],
        integration: new HttpLambdaIntegration(`${toPascal(svc.name)}Integration`, fn),
        authorizer,
      });

      // /health だけは authorizer 無し (CloudWatch synthetics 等から到達できるように)
      httpApi.addRoutes({
        path: `${svc.pathPrefix}/health`,
        methods: [HttpMethod.GET],
        integration: new HttpLambdaIntegration(`${toPascal(svc.name)}HealthIntegration`, fn),
      });

      new cdk.CfnOutput(this, `${toPascal(svc.name)}FunctionName`, {
        value: fn.functionName,
      });
    }

    new cdk.CfnOutput(this, "AdminApiUrl", {
      value: httpApi.apiEndpoint,
      description: "Admin API HTTP API Gateway URL。AdminWeb の runtime-config.json に adminApiUrl として注入する。",
    });
    new cdk.CfnOutput(this, "ControlPlaneTableName", {
      value: table.tableName,
    });
  }
}

function toPascal(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
