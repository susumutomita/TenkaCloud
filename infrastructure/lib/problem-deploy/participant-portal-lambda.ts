import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
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
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface ParticipantPortalLambdaProps {
  readonly deploymentsTable: ITable;
  /**
   * Events table (ADR-006 Notifications で参照)。
   * `GET /portal/me/notifications` が `PK=EVENT#<eventId>` で `dynamodb:Query`。
   */
  readonly eventsTable: ITable;
  /**
   * ADR-012 Phase 3.A: Endpoint registry テーブル。
   * `/portal/me/problems/:problemId/endpoints` 系 route が読み書きする。
   */
  readonly endpointsTable: ITable;
  /**
   * `{ [problemId]: { kind, flagOutputKey, points, ... } }` 形の scoring 設定。
   * `discoverProblemsScoring` で metadata.json から自動収集して synth 時に注入する。
   * 競技者が submit-flag したとき、この map を参照して採点する。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  /**
   * ADR-012 Phase 3.A: `{ [problemId]: ProblemEndpointSlot[] }` 形の endpoint 宣言。
   * `discoverProblemsEndpoints` で metadata.json から自動収集して synth 時に注入する。
   * GET /endpoints が default URL を CFn output から read-through 算出するため参照。
   */
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  /**
   * SSM SecureString path segment for tenant ExternalId lookup
   * (`/{environmentName}/tenants/{tenantId}/external-id`).
   */
  readonly environmentName: string;
}

/**
 * Participant Portal backend Lambda。Function URL (AuthType=NONE) で公開し、
 * `Authorization: Bearer <teamLoginKey>` を Lambda 内で検証する。
 *
 * IAM は最小限: participant state tables, tenant ExternalId SSM read, and the first
 * AssumeRole hop into the competitor deploy role. CFn/EventBridge write paths stay out.
 */
export class ParticipantPortalLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: ParticipantPortalLambdaProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        DeploymentsRead: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                props.deploymentsTable.tableArn,
                `${props.deploymentsTable.tableArn}/index/GSI1`,
                `${props.deploymentsTable.tableArn}/index/GSI2`,
              ],
            }),
            // 競技者の表示名 (`displayTeamName`) 更新のみ。テーブル全体に対する
            // UpdateItem だが、Lambda コードは GSI2 経由で取得した自分の行しか
            // 触らないので、実質的な書き込み対象は teamLoginKey 所有者の 1 行に限られる。
            new PolicyStatement({
              actions: ["dynamodb:UpdateItem"],
              resources: [props.deploymentsTable.tableArn],
            }),
            // #745: writeScoreEvent (= submit-flag handler が flag 正解時に PK=`DEPLOYMENT#${jobId}`
            // / SK=`EVENT#${ts}#${ulid}` で score event 行を append) が PutItem を発行する。
            // この grant が無いと AccessDenied で silent skip され、 UI で 「加点済だが履歴 0 件」
            // の矛盾が発生していた (= CloudWatch logs で確認済)。
            new PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [props.deploymentsTable.tableArn],
            }),
          ],
        }),
        // ADR-006 Notifications: Events table の partition Query 権限 + 単一行 GetItem。
        // GetItem は Issue #1005 で導入された event-gate.ts (= submit-flag / hint reveal
        // が共有する scoring gate) が PK=EVENT#<id> / SK=META 1 行を `dynamodb:GetItem` で
        // 引くために必要。 grant が漏れていると AccessDenied で getEventGate が undefined を
        // 返し、 fail-closed で `scoring_not_started` に倒れて Event は採点中なのに flag 提出
        // が「競技はまだ開始していません」 で reject されていた。
        // 書き込みは event-handler / health-check 側に閉じる (= participant は read-only)。
        EventsRead: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Query", "dynamodb:GetItem"],
              resources: [props.eventsTable.tableArn],
            }),
          ],
        }),
        // ADR-012 Phase 3.A: Endpoint registry の override 行 R/W。
        // PutItem / DeleteItem / Query で 1 (tenant, team, problem, slot) を扱う。
        EndpointsRW: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                "dynamodb:Query",
                "dynamodb:PutItem",
                "dynamodb:DeleteItem",
                "dynamodb:GetItem",
              ],
              resources: [props.endpointsTable.tableArn],
            }),
          ],
        }),
        ConsoleSso: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["ssm:GetParameter"],
              resources: [ssmArn],
            }),
            new PolicyStatement({
              actions: ["kms:Decrypt"],
              resources: ["*"],
              conditions: {
                StringLike: { "kms:EncryptionContext:PARAMETER_ARN": ssmArn },
              },
            }),
            new PolicyStatement({
              actions: ["sts:AssumeRole"],
              resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = new NodejsFunction(this, "Function", {
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handlers/participant-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      // Issue #672: bundle が 33MB と巨大 (= AWS SDK / Hono / zod 等が含まれる) で
      // 256MB だと Init Duration 1693ms で OOM → 502 Internal Server Error。
      // 512MB に拡張 (= cold start 後の steady state Max Memory Used は 136MB 程度)。
      memorySize: 512,
      role,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        PROBLEM_ENDPOINTS_TABLE_NAME: props.endpointsTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
        // Issue #1158: 旧 #810 の gzip+base64 env 圧縮では問題追加で 4 KB を再度超える。
        // esbuild define で build 時に literal 置換し env を 0 化する。 handler は
        // process.env を読む既存コードのまま (= build 後に literal JSON が埋まる)。
        define: {
          "process.env.BATTLE_PROBLEMS_SCORING": JSON.stringify(
            JSON.stringify(props.problemsScoring),
          ),
          "process.env.PROBLEM_ENDPOINTS": JSON.stringify(JSON.stringify(props.problemsEndpoints)),
        },
      },
    });

    this.url = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        // ADR-012 Phase 3.A: DELETE は endpoint override 解除 (= default に戻す) で必要。
        allowedMethods: [HttpMethod.GET, HttpMethod.PATCH, HttpMethod.POST, HttpMethod.DELETE],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: Duration.minutes(10),
      },
    });
  }
}
