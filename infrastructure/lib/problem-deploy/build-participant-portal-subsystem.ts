import { CfnOutput } from "aws-cdk-lib";
import type { IProject } from "aws-cdk-lib/aws-codebuild";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { CoordinationDispatcherLambda } from "./coordination-dispatcher-lambda.js";
import { CoordinationPluginBundle } from "./coordination-plugin-bundle.js";
import {
  DEFAULT_DEV_MOCK_RUNTIME_CONFIG,
  ParticipantPortalHosting,
  type ParticipantPortalRuntimeConfig,
} from "./participant-portal-hosting.js";
import { ParticipantPortalLambda } from "./participant-portal-lambda.js";

export interface BuildParticipantPortalSubsystemArgs {
  /**
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。
   */
  readonly deploymentsTable?: Table;
  /**
   * [Issue #2440] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。
   */
  readonly eventsTable?: Table;
  /**
   * [Issue #2442 / Phase C1] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。
   */
  readonly endpointsTable?: Table;
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  readonly problemsWriteups: Readonly<Record<string, unknown>>;
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  readonly problemsCoordination: Readonly<Record<string, unknown>>;
  readonly problemsCoordinationBundles: Readonly<Record<string, string>>;
  readonly environmentName: string;
  readonly runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock";
  readonly region: string;
  /**
   * Deploy CodeBuild `Project`。`GET /portal/me/deploy-logs` が競技者の deploy build ログを
   * stream するのに、 portal Lambda role へ この project の build + log group への read-only を
   * least-privilege で付与するために渡す (`ParticipantPortalLambda` が grant を組み立てる)。
   */
  readonly deployCodeBuildProject?: IProject;
  /**
   * Issue #2291: Lambda 経路 (`deployViaLambda` ON) の deploy 進捗を書く jobId stream の log group。
   * present のときだけ portal Lambda に `logs:GetLogEvents` read scope + `DEPLOY_JOB_LOG_GROUP` env を
   * 付与する。 未指定 (= CodeBuild 経路 / flag OFF) では追加 grant/env なし (= synth byte 互換)。
   */
  readonly deployJobLogGroup?: ILogGroup;
  /**
   * control-plane data backend は `ParticipantPortalLambda` にのみ渡す。
   * `CoordinationDispatcherLambda` は最小 IAM を維持するため Turso env/IAM を持たせない。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

export interface ParticipantPortalSubsystemOutputs {
  readonly participantPortalLambda: IFunction;
  readonly participantPortalUrl: string;
  /**
   * [#2324] scoring-driven coordination tick の実行先。 採点 Lambda が per-minute pass で
   * tick 対象を集めて本 Lambda を async Invoke し、 plugin の runTick を最小 IAM の dispatcher 内で走らせる
   * (資格情報分離)。 caller が `grantInvoke` + function name env を配線するため公開する。
   */
  readonly coordinationDispatcherLambda: IFunction;
}

/**
 * Issue #2220: extracted verbatim from `ProblemDeployBackendStack`'s constructor (formerly
 * lines 511-572, guarded by `if (props.participantPortal)`) to shrink the constructor. `scope`
 * MUST be the stack instance itself (all construct IDs below are unprefixed, exactly as they
 * were inline) — moving this to a nested construct would change every logical ID beneath it
 * (data-loss-class REPLACE on the portal Lambda / CloudFront distribution). Caller decides
 * whether to call this at all (mirrors the original `if (props.participantPortal)` guard).
 *
 * Issue #1420: inter-team coordination dispatch を participant-portal Lambda
 * (sts:AssumeRole / ssm / kms 保持) から分離し、 coordination state 行しか触れない最小 IAM の
 * 専用 Lambda で動かす。 未信頼の問題同梱 plugin を in-process 実行しても competitor 資格情報・
 * 他テナントデータに到達できない。
 * coordination plugin を宣言した問題があれば、synth-bundle 済み .mjs を専用 S3 bucket に
 * 配置し、dispatcher が runtime に download して dynamic import する。0 件なら bucket は作らない。
 */
export function buildParticipantPortalSubsystem(
  scope: Construct,
  args: BuildParticipantPortalSubsystemArgs,
): ParticipantPortalSubsystemOutputs {
  const portalLambda = new ParticipantPortalLambda(scope, "ParticipantPortalLambda", {
    deploymentsTable: args.deploymentsTable,
    eventsTable: args.eventsTable,
    endpointsTable: args.endpointsTable,
    problemsScoring: args.problemsScoring,
    problemsWriteups: args.problemsWriteups,
    problemsEndpoints: args.problemsEndpoints,
    environmentName: args.environmentName,
    ...(args.deployCodeBuildProject ? { deployCodeBuildProject: args.deployCodeBuildProject } : {}),
    // #2291: only when the Lambda deploy path is on (flag OFF → absent, no extra grant/env).
    ...(args.deployJobLogGroup ? { deployJobLogGroup: args.deployJobLogGroup } : {}),
    // Issue #2440: control-plane data backend (default dynamodb は env を足さず byte 互換)。
    controlDataBackend: args.controlDataBackend,
    ...(args.tursoDatabaseUrl ? { tursoDatabaseUrl: args.tursoDatabaseUrl } : {}),
    ...(args.tursoAuthTokenParameterName
      ? { tursoAuthTokenParameterName: args.tursoAuthTokenParameterName }
      : {}),
  });
  new CfnOutput(scope, "ParticipantPortalApiUrl", {
    value: portalLambda.url.url,
    description: "Participant Portal Lambda Function URL (auth via teamLoginKey bearer).",
  });

  const coordinationBucket = coordinationPluginBucket(scope, args.problemsCoordinationBundles);
  const coordinationDispatcher = new CoordinationDispatcherLambda(scope, "CoordinationDispatcher", {
    deploymentsTable: args.deploymentsTable,
    eventsTable: args.eventsTable,
    environmentName: args.environmentName,
    // config layer: 問題の coordination plugin path を scope resolver へ渡す。
    problemsCoordination: args.problemsCoordination,
    // plugin.mjs を materialize する bucket (宣言問題がある時のみ)。
    ...(coordinationBucket ? { pluginBucket: coordinationBucket } : {}),
  });
  new CfnOutput(scope, "CoordinationDispatcherApiUrl", {
    value: coordinationDispatcher.url.url,
    description:
      "Coordination Dispatcher Lambda Function URL (scoped IAM、 teamLoginKey bearer 認証)。",
  });

  const portal = new ParticipantPortalHosting(scope, "ParticipantPortal");
  const baseConfig =
    args.runtimeConfig === "default-dev-mock"
      ? DEFAULT_DEV_MOCK_RUNTIME_CONFIG(args.region)
      : args.runtimeConfig;
  portal.deployRuntimeConfig({
    ...baseConfig,
    apiBaseUrl: portalLambda.url.url,
    mode: "backend",
    // #1420: 専用 coordination dispatcher の Function URL を portal へ配る (slot が叩く)。
    coordinationApiUrl: coordinationDispatcher.url.url,
  });
  new CfnOutput(scope, "ParticipantPortalUrl", {
    value: portal.distributionUrl,
    description: "Participant Portal CloudFront URL.",
  });

  return {
    participantPortalLambda: portalLambda.fn,
    participantPortalUrl: portal.distributionUrl,
    // [#2324] 採点 Lambda が tick batch を async Invoke する先 (caller が grantInvoke + env)。
    coordinationDispatcherLambda: coordinationDispatcher.fn,
  };
}

/**
 * #1420: coordination plugin を宣言した問題がある時だけ bundle bucket を作る
 * (= 0 件なら undefined を返し、 dispatcher は importer 未配線で全 route not_configured)。
 */
function coordinationPluginBucket(
  scope: Construct,
  bundles: Readonly<Record<string, string>>,
): IBucket | undefined {
  if (Object.keys(bundles).length === 0) return undefined;
  return new CoordinationPluginBundle(scope, "CoordinationPluginBundle", { bundles }).bucket;
}
