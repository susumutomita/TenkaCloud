import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import type { ControlDataBackendProps } from "./build-api-lambdas.js";
import type { ControlDataTablesOutputs } from "./build-control-data-tables.js";
import { GenericScoringLambda } from "./generic-scoring-lambda.js";
import { OpsMonitoring, type OpsMonitoringConfig } from "./ops-monitoring.js";

export interface BuildScoringSubsystemArgs {
  readonly tables: ControlDataTablesOutputs;
  readonly eventBus: IEventBus;
  readonly controlDataBackendProps: ControlDataBackendProps;
  readonly environmentName: string;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  readonly problemsPhases?: Readonly<Record<string, unknown>>;
  readonly problemsDisruptions?: Readonly<Record<string, unknown>>;
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  /**
   * [#2054 / Issue #2571] Bulk Deploy adapter dispatch 用 runtime catalog。EventApi の
   * 同名 prop と同一 source (= `discoverProblemsRuntime` の戻り値)。
   */
  readonly problemRuntimes?: Readonly<Record<string, unknown>>;
  /**
   * Issue #2406: ops alerting for GenericScoring liveness/errors and monthly cost drift.
   * Undefined means fully dormant: no SNS topic, CloudWatch alarms, or Budget resources.
   */
  readonly opsMonitoring?: OpsMonitoringConfig;
}

export interface ScoringSubsystemOutputs {
  /**
   * Concrete `NodejsFunction` (not `IFunction`): the caller wires the coordination
   * dispatcher via `addEnvironment` after the participant-portal subsystem exists.
   */
  readonly genericScoringFn: NodejsFunction;
  /**
   * [Issue #3151] The ops-alerting construct, when the operator configured one.
   *
   * Returned for the same reason `genericScoringFn` is: the coordination
   * dispatcher does not exist yet at this point in the stack, and its log group
   * is where the state-budget events land. The caller attaches that watch once
   * the participant-portal subsystem has been built.
   */
  readonly opsMonitoring?: OpsMonitoring;
}

/**
 * [#2527 Slice 5] Scoring subsystem: the per-minute generic scoring / reconcile Lambda and
 * its optional ops monitoring (SNS + alarms + Budget) — extracted verbatim from
 * `ProblemDeployBackendStack`'s constructor.
 *
 * `scope` MUST be the stack instance itself (construct IDs below are unprefixed, exactly
 * as they were inline) — moving this to a nested construct would change every logical ID
 * beneath it, same constraint as `buildDeployPipeline`.
 */
export function buildScoringSubsystem(
  scope: Construct,
  args: BuildScoringSubsystemArgs,
): ScoringSubsystemOutputs {
  const { tables } = args;

  // 1 分間隔の Generic Scoring Lambda (旧 HealthCheckLambda の後継)。
  // 2 つの責務を持つ:
  // - 採点 dispatch (= 5 種 builtin kind の handler に dispatch、`flag` は polling では no-op)
  // - Event status auto-transition (#557 #539): DEPLOYING→READY / TEARDOWN→ARCHIVED
  //
  // uptime 問題が無い tenant でも reconcile は要るので **常に instantiate** (= 旧
  // `if (problemsScoring.length > 0)` ガードは撤去のまま継続)。
  const genericScoring = new GenericScoringLambda(scope, "GenericScoring", {
    deploymentsTable: tables.deployments?.table,
    eventsTable: tables.events?.table,
    // Issue #2442: 純 SQL backend では table 自体が無いので undefined を渡す (env/grant を
    // GenericScoringLambda 側で条件化。override 読み取りは repository seam 経由)。
    endpointsTable: tables.endpoints?.table,
    problemsScoring: args.problemsScoring,
    problemsEndpoints: args.problemsEndpoints,
    problemsPhases: args.problemsPhases ?? {},
    // #1422: condition-triggered disruption の eval + in-account 発火。
    problemsDisruptions: args.problemsDisruptions ?? {},
    // [#2324] scoring-driven coordination tick 用の宣言 config (どの problemId が
    // coordination を宣言しているか、 plugin code ではない metadata)。 per-minute pass が tick 対象を
    // 判定し、 実 runTick は最小 IAM の CoordinationDispatcher Lambda へ Invoke で委ねる
    // (= 配線は呼び出し側 constructor の participant-portal subsystem 側)。
    problemsCoordination: args.problemsCoordination ?? {},
    // [#1665] operator-fired disruption の active 採点効果を tick で解決する (read-only)。
    // Issue #2442: 純 SQL backend では table 自体が無いので undefined を渡す (env/grant を
    // GenericScoringLambda 側で条件化。 disruption 読み取りは repository seam 経由)。
    disruptionsTable: tables.disruptions?.table,
    // scheduled auto-teardown が bulkTeardownEvent で cross-account role を解決する (read-only)。
    competitorAccountsTable: tables.competitorAccounts?.table,
    // scheduled auto-deploy が bulkDeployEvent で teams を Query (read-only) +
    // catalog で problemId→problemDir を解決する。
    teamsTable: tables.teams?.table,
    problemsCatalog: args.problemsCatalog,
    // [Issue #2571] scheduled auto-deploy の adapter dispatch 用 runtime catalog。undefined は
    // GenericScoringLambda 側の `?? {}` で空 map に正規化される。
    problemRuntimes: args.problemRuntimes,
    eventBus: args.eventBus,
    // [#1410-1412] 非 AWS runtime status reconciler の credential path 構築用。
    environmentName: args.environmentName,
    // Issue #2440: control-plane data backend。event status reconcile + manual prune tick が
    // repository seam 経由でこの env を読む (= turso 選択時のみ注入)。
    ...args.controlDataBackendProps,
  });

  const opsMonitoring = args.opsMonitoring
    ? new OpsMonitoring(scope, "OpsMonitoring", {
        ...args.opsMonitoring,
        environmentName: args.environmentName,
        genericScoringLambda: genericScoring.fn,
      })
    : undefined;

  return { genericScoringFn: genericScoring.fn, opsMonitoring };
}
