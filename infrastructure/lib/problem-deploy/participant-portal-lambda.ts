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
import {
  Architecture,
  type FunctionUrl,
  FunctionUrlAuthType,
  HttpMethod,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

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
   * `ConsoleViewerRole` の ARN。AWS Console federation login URL 発行のため
   * Lambda が `sts:AssumeRole` する。caller side で IAM grant も付与する。
   */
  readonly consoleViewerRoleArn: string;
}

/**
 * Participant Portal backend Lambda。Function URL (AuthType=NONE) で公開し、
 * `Authorization: Bearer <teamLoginKey>` を Lambda 内で検証する。
 *
 * IAM は最小限: Deployments テーブルと GSI2 への Query 権限のみ。Worker / API
 * Lambda が持つ CFn AssumeRole / EventBridge / DDB 書き込み権限は付与しない。
 */
export class ParticipantPortalLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: ParticipantPortalLambdaProps) {
    super(scope, id);

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
        // ADR-006 Notifications: Events table の partition Query 権限のみ。
        // 書き込みは event-handler / health-check 側に閉じる (= participant は read-only)。
        EventsRead: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Query"],
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
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/participant-handler/index.ts"),
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
        BATTLE_PROBLEMS_SCORING: JSON.stringify(props.problemsScoring),
        PROBLEM_ENDPOINTS: JSON.stringify(props.problemsEndpoints),
        CONSOLE_VIEWER_ROLE_ARN: props.consoleViewerRoleArn,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node22",
        sourceMap: true,
        externalModules: [],
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
