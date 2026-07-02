import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { type FunctionUrl, FunctionUrlAuthType, HttpMethod } from "aws-cdk-lib/aws-lambda";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface CoordinationDispatcherLambdaProps {
  /** team-login-key 認証 (GSI2 Query) + coordination state 行 (PK=COORD#...) の Get/Put 先。 */
  readonly deploymentsTable: ITable;
  /**
   * `buildParticipantSharedResources` が `EVENTS_TABLE_NAME` env を要求するため渡す。 coordination
   * route は events を読まない (= IAM も付与しない)。 共有 builder の env 要件を満たすためだけの配線。
   */
  readonly eventsTable: ITable;
  /** `buildParticipantSharedResources` が要求する `DEPLOY_ENVIRONMENT`。 coordination では未使用。 */
  readonly environmentName: string;
  /**
   * [ADR-030 Phase 3 / #1420] `{ [problemId]: { plugin } }`。 問題が宣言する coordination plugin の
   * module path。 scope resolver が team→moduleRef を解決するのに使う (= `PROBLEM_COORDINATION` env)。
   * 未宣言の問題はキー無し。 省略時は空 (= 全 route `not_configured`)。
   */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  /**
   * [ADR-030 Phase 3b / #1420] synth-bundle 済み coordination plugin (.mjs) を置く S3 bucket。
   * dispatcher は `coordination/<problemId>.mjs` を runtime download → `import()` する。 read-only。
   * 省略時は importer 未配線 → 全 route `unavailable`。
   */
  readonly pluginBucket?: IBucket;
}

/**
 * ADR-030 Phase 2 (#1420): inter-team coordination dispatch 専用 Lambda。
 *
 * coordination route (`POST/GET /portal/me/coordination/*`) を participant-portal Lambda から
 * **本 Lambda へ分離**する。 participant-portal Lambda は AWS Console SSO / CLI 資格情報発行のため
 * `sts:AssumeRole`(競技者 federation) + `ssm:GetParameter` + `kms:Decrypt`(ExternalId 復号) を持つ。
 * 将来 Phase 3 で未信頼の問題同梱 plugin を in-process 動的実行しても、 本 Lambda は Deployments
 * テーブルの coordination / team-lookup 行しか触れない最小 IAM のため、 競技者資格情報・他テナント
 * データ・ExternalId に **構造的に到達できない** (ADR-030 S2 = blast radius を IAM で封じる)。
 *
 * Function URL は AuthType=NONE で公開し、 `Authorization: Bearer <teamLoginKey>` を handler 内で検証する。
 * plugin の実 import (S3 materialize) は Phase 3 の seam。 現状は load 不可 → `not_configured` / `unavailable`。
 */
export class CoordinationDispatcherLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: CoordinationDispatcherLambdaProps) {
    super(scope, id);

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        // team-login-key 認証 (= GSI2 Query) + coordination state 行 (PK=COORD#...) の Get/Put。
        // ADR-030 S2: sts:AssumeRole / ssm:GetParameter / kms:Decrypt は **意図的に付与しない**
        // (= 未信頼 plugin が競技者資格情報・ExternalId に到達する経路を IAM 上に存在させない)。
        CoordinationRW: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                props.deploymentsTable.tableArn,
                `${props.deploymentsTable.tableArn}/index/GSI2`,
              ],
            }),
            new PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [props.deploymentsTable.tableArn],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/coordination-dispatcher-handler/index.ts"),
      timeout: Duration.seconds(10),
      memorySize: 512,
      role,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        // 共有 builder (buildParticipantSharedResources) の env 要件。 coordination では未使用。
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        // ADR-030 Phase 3b: plugin .mjs を materialize する S3 bucket。 未指定なら importer 未配線。
        ...(props.pluginBucket
          ? { COORDINATION_PLUGIN_BUCKET: props.pluginBucket.bucketName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
      // ADR-030 Phase 3 config layer: coordination catalog を build 時 literal 置換 (env 4KB 回避、
      // scoring/disruptions と同方式)。 未宣言なら `{}` → scope resolver は全 team で not_configured。
      bundlingDefine: {
        "process.env.PROBLEM_COORDINATION": JSON.stringify(
          JSON.stringify(props.problemsCoordination ?? {}),
        ),
      },
    });

    // ADR-030 Phase 3b: plugin bundle bucket の read-only。 sts/ssm/kms は依然付与しないため、
    // 動的 load した未信頼 plugin の到達範囲は coordination state 行 + 自身の bundle に限定される。
    props.pluginBucket?.grantRead(this.fn);

    this.url = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.GET, HttpMethod.POST],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: Duration.minutes(10),
      },
    });
  }
}
