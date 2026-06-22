import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  type FunctionUrl,
  FunctionUrlAuthType,
  HttpMethod,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";

export interface EvalApiLambdaProps {
  /** run / evaluation を記録する DDB テーブル。 */
  readonly runsTable: Table;
  /** クリアコード署名鍵を置いた SSM SecureString のパラメータ名 (operator が事前作成)。 */
  readonly signingSecretParamName: string;
}

/**
 * Issue #1973: endpoint-eval バックエンド Lambda。
 *
 * Function URL (AuthType=NONE) で公開する。 run 作成は無アカウント前提 (= 参加登録なし) なので
 * API Gateway + Cognito を挟まず、 participant-portal と同じ Function URL 方式にする。
 * 評価は `*.workers.dev` 等への外向き fetch を行うので VPC には入れない (= NAT 不要、 issue 準拠)。
 */
export class EvalApiLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: EvalApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handlers/eval-handler/index.ts"),
      handler: "handler",
      // 1 評価で複数 probe を順に外部 fetch する (既定 5s/probe)。 余裕を見て 60s。
      timeout: Duration.seconds(60),
      // AWS SDK / Hono / zod を内包する bundle のため CPU 確保目的で 1024MB (participant と同方針)。
      memorySize: 1024,
      environment: {
        EVAL_RUNS_TABLE_NAME: props.runsTable.tableName,
        ENDPOINT_EVAL_SIGNING_SECRET_PARAM: props.signingSecretParamName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    props.runsTable.grantReadWriteData(this.fn);

    const ssmArn = Stack.of(this).formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: props.signingSecretParamName.replace(/^\//, ""),
    });
    this.fn.addToRolePolicy(
      new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [ssmArn] }),
    );
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringLike: { "kms:EncryptionContext:PARAMETER_ARN": ssmArn } },
      }),
    );

    this.url = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.GET, HttpMethod.POST],
        allowedHeaders: ["content-type"],
        maxAge: Duration.minutes(10),
      },
    });
  }
}
