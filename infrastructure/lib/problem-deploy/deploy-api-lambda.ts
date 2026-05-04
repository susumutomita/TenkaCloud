import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { IRole } from "aws-cdk-lib/aws-iam";
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
  readonly eventBusName: string;
  /**
   * Lambda が引き受ける execution role。`DeployWorkerRole` (DDB CRUD + EventBus
   * PutEvents + cross-account AssumeRole) を流用して IAM 重複を避ける。
   */
  readonly executionRole: IRole;
  /**
   * tenantId として handler に渡す `DEFAULT_TENANT_ID` env。Cognito JWT authorizer
   * 結線時に JWT claim ベースに差し替える。
   */
  readonly defaultTenantId?: string;
}

/**
 * 問題 deploy 起動用 Lambda + Function URL。AWS_IAM 認証で公開する。
 *
 * 認証は AWS_IAM (SigV4)。フロントエンド連携は API Gateway HTTP API + Cognito
 * authorizer に差し替えてから行う。
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
      role: props.executionRole,
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
        // Lambda runtime は aws-sdk v2 のみ同梱、v3 (@aws-sdk/*) は bundle が必要
        externalModules: [],
      },
    });

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
