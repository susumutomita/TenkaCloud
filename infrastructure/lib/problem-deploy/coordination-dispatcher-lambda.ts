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
import { controlDataRuntimeEnv, grantTursoAuthTokenRead } from "./control-data-backend-env.js";

export interface CoordinationDispatcherLambdaProps {
  /**
   * team-login-key 認証 (GSI2 Query) + coordination state 行 (PK=COORD#...) の Get/Put 先。
   *
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * `CoordinationRW` inline policy も付与しない — team-login-key 認証 / coordination state は
   * repository seam (`resolveDeploymentsRepository`、`coordination-store.ts` は既に seam 経由) が
   * SQL executor 直結で処理する。
   */
  readonly deploymentsTable?: ITable;
  /**
   * `buildParticipantSharedResources` が読む `EVENTS_TABLE_NAME` env の source。 coordination
   * route は events を読まない (IAM は付与しない)。 [Issue #2440]
   * `controlDataBackend` が純 SQL (`turso`) のとき `ProblemDeployBackendStack` は本
   * table を synth しない (= `undefined`)。 その場合 env も注入しない (= shared builder は
   * env 不在でも空文字にフォールバックするだけで dispatcher の挙動に影響しない)。
   */
  readonly eventsTable?: ITable;
  /** `buildParticipantSharedResources` が要求する `DEPLOY_ENVIRONMENT`。 coordination では未使用。 */
  readonly environmentName: string;
  /**
   * [#1420] `{ [problemId]: { plugin } }`。 問題が宣言する coordination plugin の
   * module path。 scope resolver が team→moduleRef を解決するのに使う (= `PROBLEM_COORDINATION` env)。
   * 未宣言の問題はキー無し。 省略時は空 (= 全 route `not_configured`)。
   */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  /**
   * [#1420] synth-bundle 済み coordination plugin (.mjs) を置く bucket。
   * dispatcher は `coordination/<problemId>.mjs` を runtime download → `import()` する。 read-only。
   * 省略時は importer 未配線 → 全 route `unavailable`。
   */
  readonly pluginBucket?: IBucket;
  /**
   * [Issue #3152] Bucket holding immutable submission artifacts (proofs,
   * ciphertexts, transcripts). The dispatcher reads and writes ONLY under
   * `coordination/`, and only its own withdrawals delete.
   *
   * A separate bucket from {@link pluginBucket} on purpose: this process
   * dynamically imports the plugin bundle as code, and giving it write access to
   * the bucket it imports code from would let a plugin bug reach every future
   * match rather than just its own.
   *
   * Absent when the deployment has no artifact bucket — the handler then refuses
   * an operation carrying a body rather than accepting and discarding it.
   */
  readonly artifactBucket?: IBucket;
  /**
   * [Issue 486] control-plane data backend. `deploymentsTable` の docstring が言うとおり、純 SQL
   * (`turso`) では table を synth せず repository seam が SQL executor 直結で処理する設計だが、その
   * executor は `CONTROL_DATA_BACKEND` / `TURSO_*` env が無いと組み立てられない。これらを渡さないまま
   * table だけ落としていたため、純 Turso の deploy では dispatcher が table 名も Turso 設定も持たず、
   * `resolveDeploymentsRepository` が dynamodb 分岐に落ちて毎 request throw していた
   * (`dynamodb backend requires ddb/deploymentsTableName.`) — coordination plugin を使う battle が
   * まるごと `not_configured` になり、Contract が 1 件も供給されなかった。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Issue #1420: inter-team coordination dispatch 専用 Lambda。
 *
 * coordination route (`POST/GET /portal/me/coordination/*`) を participant-portal Lambda から
 * **本 Lambda へ分離**する。 participant-portal Lambda は AWS Console SSO / CLI 資格情報発行のため
 * `sts:AssumeRole`(競技者 federation) + `ssm:GetParameter` + `kms:Decrypt`(ExternalId 復号) を持つ。
 * 問題同梱 plugin はレビュー済み catalog bundle だけを trusted code として本 Lambda の process 内で
 * 動的実行する。plugin は Lambda の environment と execution role を共有し、DynamoDB backend では
 * Deployments table 全体への Query / GetItem / PutItem / UpdateItem / ConditionCheckItem と
 * GSI1 / GSI2 全体への Query 権限を持つ。tenant ごとの
 * IAM isolation はないため、catalog review と publish control が plugin の trust boundary になる。
 *
 * Function URL は AuthType=NONE で公開し、 `Authorization: Bearer <teamLoginKey>` を handler 内で検証する。
 * plugin bucket が指定されれば S3 から materialize して import し、未指定時は fail closed で
 * `not_configured` / `unavailable` を返す。
 */
export class CoordinationDispatcherLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: CoordinationDispatcherLambdaProps) {
    super(scope, id);

    const deploymentsTable = props.deploymentsTable;

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        // DynamoDB backend では Deployments table / GSI1 / GSI2 全体への Query と、table 全体への
        // GetItem / PutItem / UpdateItem / ConditionCheckItem を許可する。handler は認証と
        // coordination state に使うが、IAM は key や tenant を絞らないため、同一 process の
        // plugin も同じ権限を共有する。
        // [Issue #3123] UpdateItem は tick の TTL 延長 (`touchCoordinationState`) に要る。
        // PutItem を既に持つ role にとって権限の拡大ではない (同じ行を丸ごと上書きできる)
        // が、state / version を読まずに `expiresAt` だけ動かせるので、 tick が in-flight な
        // optimistic lock を壊さずに retention を延ばせる。 DeleteItem は付けない —
        // namespace の削除は event を所有する経路 (event-api / generic-scoring) の責務。
        // #3194: GSI1 は採点対象の一覧、ConditionCheckItem は同じ run/state の採点配信の条件。
        // TransactWriteItems の IAM は内包する Put/Update/ConditionCheck の action で判定される。
        // https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html
        // sts:AssumeRole / ssm:GetParameter / kms:Decrypt は意図的に付与しない。
        // Issue #2441: 純 SQL backend では table 自体が無いので policy を足さない。
        ...(deploymentsTable
          ? {
              CoordinationRW: new PolicyDocument({
                statements: [
                  new PolicyStatement({
                    actions: ["dynamodb:Query"],
                    resources: [
                      deploymentsTable.tableArn,
                      `${deploymentsTable.tableArn}/index/GSI1`,
                      `${deploymentsTable.tableArn}/index/GSI2`,
                    ],
                  }),
                  new PolicyStatement({
                    actions: [
                      "dynamodb:GetItem",
                      "dynamodb:PutItem",
                      "dynamodb:UpdateItem",
                      "dynamodb:ConditionCheckItem",
                    ],
                    resources: [deploymentsTable.tableArn],
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
      entry: path.resolve(import.meta.dirname, "handlers/coordination-dispatcher-handler/index.ts"),
      timeout: Duration.seconds(10),
      memorySize: 512,
      role,
      environment: {
        // Issue #2441: 純 SQL backend では table 自体が無いので env も足さない。
        ...(deploymentsTable ? { DEPLOYMENTS_TABLE_NAME: deploymentsTable.tableName } : {}),
        // 共有 builder (buildParticipantSharedResources) の env。 coordination では未使用。
        // Issue #2440: 純 SQL backend では table が無いので env も足さない。
        ...(props.eventsTable ? { EVENTS_TABLE_NAME: props.eventsTable.tableName } : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        // plugin.mjs を materialize する bucket。 未指定なら importer 未配線。
        ...(props.pluginBucket
          ? { COORDINATION_PLUGIN_BUCKET: props.pluginBucket.bucketName }
          : {}),
        // [Issue #3152] 未指定なら handler は artifact を伴う op を loud に拒否する
        // (= 保存できない body を受理して黙って捨てない)。
        ...(props.artifactBucket
          ? { COORDINATION_ARTIFACT_BUCKET: props.artifactBucket.bucketName }
          : {}),
        // 純 SQL backend で repository seam が SQL executor を組み立てるために要る三点。
        // default (`dynamodb`) では helper が空を返すので byte 互換。
        ...controlDataRuntimeEnv(props),
        NODE_OPTIONS: "--enable-source-maps",
      },
      // config layer: coordination catalog を build 時 literal 置換 (env 4KB 回避、
      // scoring/disruptions と同方式)。 未宣言なら `{}` → scope resolver は全 team で not_configured。
      bundlingDefine: {
        "process.env.PROBLEM_COORDINATION": JSON.stringify(
          JSON.stringify(props.problemsCoordination ?? {}),
        ),
      },
    });

    // レビュー済み plugin bundle を読むための bucket access。同一 process で実行する plugin は
    // Lambda role を共有し、DynamoDB backend では table-wide Query / GetItem / PutItem も実行できる。
    props.pluginBucket?.grantRead(this.fn);

    // [Issue #3152] Read/write, scoped to the coordination prefix rather than the
    // whole bucket. Delete is included because this Lambda withdraws its OWN
    // writes: a body whose operation was then rejected is referenced by nothing
    // and would otherwise sit until the bucket's expiry. Removing a whole
    // scope's worth is not this Lambda's job — that belongs to the event and
    // deploy handlers, which own teardown.
    if (props.artifactBucket) {
      role.addToPolicy(
        new PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [props.artifactBucket.arnForObjects("coordination/*")],
        }),
      );
    }

    // Turso auth token を読むための SSM SecureString read。 未配線 (= dynamodb default) では
    // 何も付与しないので、最小 IAM は DynamoDB profile では従来どおり。
    grantTursoAuthTokenRead(this.fn, props.tursoAuthTokenParameterName);

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
