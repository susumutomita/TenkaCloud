import * as path from "node:path";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type { UserPool } from "aws-cdk-lib/aws-cognito";
import { LambdaVersion, UserPoolOperation } from "aws-cdk-lib/aws-cognito";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";

export interface LiteAdminClaimsLambdaProps {
  /**
   * Lite mode UserPool。 本 Lambda は Pre-Token Generation trigger として attach され、
   * JWT 発行直前に `custom:userRole = "TenantAdmin"` + `custom:tenantId = "local"` を注入する。
   */
  readonly userPool: UserPool;
}

/**
 * Issue #1327: Lite mode 専用の Cognito Pre-Token Generation Lambda construct。
 *
 * ## なぜ別 construct か
 * SaaS mode の UserPool には絶対 attach しない (= SBT 経路の role 割り当てを汚さない)。
 * オプトイン flag (`liteAdminClaimsInjection`) で TenkaCloudLiteStack だけが本 construct を
 * 立てるよう scope を絞る。 IdentityProvider 直下に書くと SaaS / Lite の分岐が増えるため、
 * Lite 専用構築物として独立させる。
 *
 * ## IAM / env / network
 * 本 Lambda は event を mutate して返すだけ (= 外部 service call 不要)。 IAM 追加権限・
 * env / VPC は不要。 timeout 5s / memory 128MB で十分 (Cognito の sync invoke 上限 5s も満たす)。
 *
 * ## addTrigger の挙動 (= V2 trigger / #1358)
 * `userPool.addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, fn, LambdaVersion.V2_0)`
 * は CFn 上で UserPool の `LambdaConfig.PreTokenGenerationConfig` を本 Lambda の ARN +
 * `LambdaVersion: V2_0` で設定し、 同時に Cognito service principal が本 Lambda を invoke
 * するための resource-based policy も自動追加する。 V2 trigger を指定することで Cognito 側は
 * V2 event shape (= `claimsAndScopeOverrideDetails.idTokenGeneration` を読む経路) で
 * Lambda を呼び出し、 ID token / access token の双方に custom claim を inject 可能になる。
 * V1 trigger (= `PRE_TOKEN_GENERATION`) は access token のみ override 可能で、 Application Plane
 * handler が読む ID token に claim が乗らないため使用しない (= #1358 root cause)。
 */
export class LiteAdminClaimsLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: LiteAdminClaimsLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      logGroup: new LogGroup(this, "FunctionLogGroup", {
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "./handlers/pre-token-generation/index.ts"),
      handler: "handler",
      // Cognito Pre-Token Generation trigger は sync invoke で 5s が上限。 Lambda の
      // timeout を 5s に揃え、 cold start で trigger が timeout して JWT 発行が失敗する
      // 経路を避ける (= warm 化された後は数 ms で完了)。
      timeout: Duration.seconds(5),
      memorySize: 128,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    // UserPool に Pre-Token Generation V2 trigger として bind する。 これにより
    //   - UserPool.LambdaConfig.PreTokenGenerationConfig.LambdaArn が fn ARN を指す
    //   - UserPool.LambdaConfig.PreTokenGenerationConfig.LambdaVersion = "V2_0"
    //   - fn の resource-based policy に Cognito 経由の invoke 権限が自動追加される
    // が同時に行われる。 V2 を指定することで handler は V2 event shape
    // (= `claimsAndScopeOverrideDetails`) を返し、 ID token / access token の双方に
    // custom claim が乗る (= #1358 fix の根幹)。
    props.userPool.addTrigger(
      UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      this.fn,
      LambdaVersion.V2_0,
    );
  }
}
