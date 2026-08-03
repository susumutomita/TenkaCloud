import * as path from "node:path";
import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import type { IProject } from "aws-cdk-lib/aws-codebuild";
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
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface ParticipantPortalLambdaProps {
  /**
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * `DeploymentsRead` inline policy も付与しない — 参加者の deployment / coordination /
   * score-event 読み書きは repository seam (`resolveDeploymentsRepository`) が SQL executor
   * 直結で処理する ({@link eventsTable} と同じ条件)。
   */
  readonly deploymentsTable?: ITable;
  /**
   * Events table (ADR-006 Notifications で参照)。
   * `GET /portal/me/notifications` が `PK=EVENT#<eventId>` で `dynamodb:Query`。
   *
   * [Issue #2440 / ADR-049 §5.1 Phase A5] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `EVENTS_TABLE_NAME` も EventsRead IAM も付与しない — notifications / feature-flags は
   * repository seam (entrypoint 注入の control-data runtime) が SQL executor 直結で処理する。
   */
  readonly eventsTable?: ITable;
  /**
   * ADR-012 Phase 3.A: Endpoint registry テーブル。
   * `/portal/me/problems/:problemId/endpoints` 系 route が読み書きする。
   *
   * [Issue #2442 / Phase C1] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * `EndpointsRW` inline policy も付与しない — override 読み書きは repository seam
   * (`resolveProblemEndpointsRepository`) が SQL executor 直結で処理する
   * ({@link eventsTable} と同じ条件)。
   */
  readonly endpointsTable?: ITable;
  /**
   * `{ [problemId]: { kind, flagOutputKey, points, ... } }` 形の scoring 設定。
   * `discoverProblemsScoring` で metadata.json から自動収集して synth 時に注入する。
   * 競技者が submit-flag したとき、この map を参照して採点する。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  /**
   * Issue #2191: spoiler-bearing explanations. Bundled into this backend Lambda only;
   * never injected into the participant browser bundle.
   */
  readonly problemsWriteups?: Readonly<Record<string, unknown>>;
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
  /**
   * Deploy CodeBuild `Project`。`GET /portal/me/deploy-logs` (deploy-logs.ts) が この project の
   * build を `codebuild:BatchGetBuilds` で引き、 その CloudWatch log group を `logs:GetLogEvents`
   * で stream するため、 project ARN + log-group ARN を least-privilege grant として使う。
   */
  readonly deployCodeBuildProject?: IProject;
  /**
   * Issue #2291: Lambda 経路 (`deployViaLambda` ON) の deploy 進捗を書く jobId stream の log group。
   * present のときだけ、 `GET /portal/me/deploy-logs` (deploy-logs.ts) が jobId stream を
   * `logs:GetLogEvents` で read できるよう read-only grant (`DeployJobLogsRead`) + `DEPLOY_JOB_LOG_GROUP`
   * env を付与する。 未指定 (= CodeBuild 経路 / flag OFF) では追加せず、 synth は byte 互換。
   */
  readonly deployJobLogGroup?: ILogGroup;
  /**
   * [Issue #2440 / ADR-049 §5.1 Phase A5] control-plane data backend (dynamodb|turso)。
   * notifications / feature-flags の repository seam
   * (entrypoint 注入の control-data runtime) がこの env を読む。default (未指定 / `dynamodb`) は env を足さず
   * byte 互換。`EventApiLambda` と同型の注入パターン。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
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

    const deploymentsTable = props.deploymentsTable;

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        // Issue #2441: 純 SQL backend では table 自体が無いので policy を足さない (repository
        // seam が SQL executor 直結で処理する。`eventsTable`/`EventsRead` と同じ pattern)。
        ...(deploymentsTable
          ? {
              DeploymentsRead: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: ["dynamodb:Query"],
                    resources: [
                      deploymentsTable.tableArn,
                      `${deploymentsTable.tableArn}/index/GSI1`,
                      `${deploymentsTable.tableArn}/index/GSI2`,
                    ],
                  }),
                  // 競技者の表示名 (`displayTeamName`) 更新のみ。テーブル全体に対する
                  // UpdateItem だが、Lambda コードは GSI2 経由で取得した自分の行しか
                  // 触らないので、実質的な書き込み対象は teamLoginKey 所有者の 1 行に限られる。
                  new PolicyStatement({
                    actions: ["dynamodb:UpdateItem"],
                    resources: [deploymentsTable.tableArn],
                  }),
                  // #745: writeScoreEvent (= submit-flag handler が flag 正解時に PK=`DEPLOYMENT#${jobId}`
                  // / SK=`EVENT#${ts}#${ulid}` で score event 行を append) が PutItem を発行する。
                  // この grant が無いと AccessDenied で silent skip され、 UI で 「加点済だが履歴 0 件」
                  // の矛盾が発生していた (= CloudWatch logs で確認済)。
                  new PolicyStatement({
                    actions: ["dynamodb:PutItem"],
                    resources: [deploymentsTable.tableArn],
                  }),
                ],
              }),
            }
          : {}),
        // ADR-006 Notifications: Events table の partition Query 権限 + 単一行 GetItem。
        // GetItem は Issue #1005 で導入された event-gate.ts (= submit-flag / hint reveal
        // が共有する scoring gate) が PK=EVENT#<id> / SK=META 1 行を `dynamodb:GetItem` で
        // 引くために必要。 grant が漏れていると AccessDenied で getEventGate が undefined を
        // 返し、 fail-closed で `scoring_not_started` に倒れて Event は採点中なのに flag 提出
        // が「競技はまだ開始していません」 で reject されていた。
        // 書き込みは event-handler / health-check 側に閉じる (= participant は read-only)。
        // Issue #2440: 純 SQL backend では table 自体が無いので policy を足さない。
        ...(props.eventsTable
          ? {
              EventsRead: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: ["dynamodb:Query", "dynamodb:GetItem"],
                    resources: [props.eventsTable.tableArn],
                  }),
                ],
              }),
            }
          : {}),
        // ADR-012 Phase 3.A: Endpoint registry の override 行 R/W。
        // PutItem / DeleteItem / Query で 1 (tenant, team, problem, slot) を扱う。
        // Issue #2442: 純 SQL backend では table 自体が無いので policy を足さない (repository
        // seam が SQL executor 直結で処理する。`eventsTable`/`EventsRead` と同じ pattern)。
        ...(props.endpointsTable
          ? {
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
            }
          : {}),
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
        // Bug fix: participant deploy-log streaming needs read access to the deploy CodeBuild
        // project's builds + its log group.
        // EN: `GET /portal/me/deploy-logs` (deploy-logs.ts) resolves a team's deploy build via
        // `codebuild:BatchGetBuilds` (to read `build.logs.groupName`/`streamName`) and then reads
        // the stream with `logs:GetLogEvents`. The participant role granted neither, so the route
        // returned AccessDenied in production. Grant read-only, scoped to the deploy project ARN
        // and its `/aws/codebuild/<projectName>` log group only (no `*`).
        // JA: `GET /portal/me/deploy-logs` (deploy-logs.ts) は competitor の deploy build を
        // `codebuild:BatchGetBuilds` で解決し (`build.logs` の group/stream 取得)、 その log stream を
        // `logs:GetLogEvents` で読む。 participant role に両権限が無く 本番で AccessDenied になっていた。
        // deploy project ARN と その `/aws/codebuild/<projectName>` log group に scope した read-only
        // のみ付与する (`*` 不使用)。
        ...(props.deployCodeBuildProject
          ? {
              DeployLogsRead: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: ["codebuild:BatchGetBuilds"],
                    resources: [props.deployCodeBuildProject.projectArn],
                  }),
                  new PolicyStatement({
                    actions: ["logs:GetLogEvents"],
                    // CodeBuild default CloudWatch logging writes to
                    // `/aws/codebuild/<projectName>`; the trailing `:*` scopes to every log
                    // stream in that group (deploy-logs.ts reads the stream name dynamically).
                    resources: [
                      stack.formatArn({
                        service: "logs",
                        resource: "log-group",
                        resourceName: `/aws/codebuild/${props.deployCodeBuildProject.projectName}:*`,
                        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                      }),
                    ],
                  }),
                ],
              }),
            }
          : {}),
        // Issue #2291: Lambda 経路の deploy 進捗を read する grant。 `deployJobLogGroup` が渡された
        // (= deployViaLambda ON) ときだけ inline policy を足す。 flag OFF では spread が空 = 追加なし
        // (synth byte 互換)。 read-only の `logs:GetLogEvents` を job log group の全 stream (`:*`) に scope。
        ...(props.deployJobLogGroup
          ? {
              DeployJobLogsRead: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: ["logs:GetLogEvents"],
                    resources: [`${props.deployJobLogGroup.logGroupArn}:*`],
                  }),
                ],
              }),
            }
          : {}),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/participant-handler/index.ts"),
      // 巨大 bundle (= 当時 externalModules:[] で AWS SDK / Hono / zod を全部内包、 約 33MB) の
      // cold start init が Lambda の 10s INIT 予算を超えると、 init が invoke phase に持ち越され
      // function timeout に達して 502 (`INIT_REPORT ... Phase: invoke Status: timeout`)。 sign-in が
      // 502 になる症状の原因。 旧 10s は全 handler 中で最短で最も脆かった。 29s に広げて、 万一
      // init が invoke に持ち越しても完走できる余裕を持たせる。 #2864 で bundle は 387,263 bytes
      // まで縮んだが、 短縮は live での cold start 再測定を伴って別途判断する (= 推測で縮めない)。
      timeout: Duration.seconds(29),
      // Issue #672: bundle が 33MB と巨大 (= AWS SDK / Hono / zod 等が含まれる) だった時代の値。
      // 256MB は OOM、 512MB は OOM しないが ARM の CPU 割当が memory 比例のため cold start init が
      // 遅く、 10s INIT 予算を超えて 502 になることがあった。 1024MB に拡張して CPU を倍増し、 init を
      // 予算内に収める (steady state の Max Memory Used は 136MB 程度なので memory 容量目的ではなく
      // CPU 目的)。 抜本策としていた bundle 縮小 (= Node 22 runtime 同梱の @aws-sdk を
      // externalModules 化) は #2864 で実施済 (3,000,031 → 387,263 bytes)。 縮小後も CPU 割当は
      // memory 比例のままなので、 引き下げは live 再測定の根拠が出るまで行わない。
      memorySize: 1024,
      role,
      environment: {
        // Issue #2441: 純 SQL backend では table 自体が無いので env も足さない。
        ...(deploymentsTable ? { DEPLOYMENTS_TABLE_NAME: deploymentsTable.tableName } : {}),
        // Issue #2440: 純 SQL backend では table が無いので env も足さない。
        ...(props.eventsTable ? { EVENTS_TABLE_NAME: props.eventsTable.tableName } : {}),
        // Issue #2442: 純 SQL backend では table が無いので env も足さない。
        ...(props.endpointsTable
          ? { PROBLEM_ENDPOINTS_TABLE_NAME: props.endpointsTable.tableName }
          : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        // [Issue #2440]: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
        // Issue #2291: deploy-logs.ts が runtime に process.env で読む job log group 名 (= jobId stream
        // の親 group)。 deployViaLambda ON のときだけ注入し、 flag OFF では env そのものが無い
        // (= deploy-logs.ts は従来どおり empty entries を返す = byte 互換)。 esbuild define ではなく
        // 通常の runtime env (CFn token = log group 名) なので plain conditional spread で足す。
        ...(props.deployJobLogGroup
          ? { DEPLOY_JOB_LOG_GROUP: props.deployJobLogGroup.logGroupName }
          : {}),
      },
      // Issue #1158: 旧 #810 の gzip+base64 env 圧縮では問題追加で 4 KB を再度超える。
      // esbuild define で build 時に literal 置換し env を 0 化する。 handler は
      // process.env を読む既存コードのまま (= build 後に literal JSON が埋まる)。
      bundlingDefine: {
        "process.env.BATTLE_PROBLEMS_SCORING": JSON.stringify(
          JSON.stringify(props.problemsScoring),
        ),
        "process.env.BATTLE_PROBLEMS_WRITEUPS": JSON.stringify(
          JSON.stringify(props.problemsWriteups ?? {}),
        ),
        "process.env.PROBLEM_ENDPOINTS": JSON.stringify(JSON.stringify(props.problemsEndpoints)),
      },
    });

    // [Issue #2440]: turso backend が Turso auth token を読むための SSM SecureString
    // read 権限。 未配線 (= dynamodb default) なら付与しない (`EventApiLambda` と同型)。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${stack.partition}:ssm:${stack.region}:${
              stack.account
            }:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }

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
