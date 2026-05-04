import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  type FunctionUrl,
  FunctionUrlAuthType,
  HttpMethod,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface DeployApiLambdaProps {
  readonly deploymentsTableName: string;
  readonly deploymentsTableArn: string;
  readonly eventBusName: string;
  readonly eventBusArn: string;
  /**
   * 暫定 (PR-C): `DEFAULT_TENANT_ID` env として handler に渡される。
   * 将来 Cognito JWT authorizer に差し替える際、JWT claim から取り出す形に置き換える。
   */
  readonly defaultTenantId?: string;
}

/**
 * 問題 deploy 起動用の HTTP API。
 *
 * 構成:
 *   - NodejsFunction: lib/problem-deploy/handlers/deploy-handler/index.ts を esbuild で bundle
 *   - Lambda Function URL: AWS_IAM 認証 (PR-C 暫定)。本物の TenantAdmin 認証は後段 PR で
 *     API Gateway HTTP API + Cognito authorizer に差し替える
 *
 * 環境変数:
 *   DEPLOYMENTS_TABLE_NAME / DEPLOY_EVENT_BUS_NAME / DEFAULT_TENANT_ID
 *
 * IAM:
 *   - DDB: Deployments table の PutItem / Query (PR-C は Put のみ使う)
 *   - EventBridge: 与えられた event bus への PutEvents
 */
export class DeployApiLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: DeployApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/deploy-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTableName,
        DEPLOY_EVENT_BUS_NAME: props.eventBusName,
        DEFAULT_TENANT_ID: props.defaultTenantId ?? "unknown-tenant",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        // aws-sdk v3 modules は Lambda runtime には同梱されないので bundle に含める。
        externalModules: [],
      },
    });

    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:GetItem"],
        resources: [props.deploymentsTableArn, `${props.deploymentsTableArn}/index/*`],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["events:PutEvents"],
        resources: [props.eventBusArn],
      }),
    );

    this.url = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.POST, HttpMethod.GET],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: Duration.minutes(10),
      },
    });
  }
}
