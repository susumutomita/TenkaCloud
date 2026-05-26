import {
  CloudWatchClient,
  type CloudWatchClientConfig,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

/**
 * Issue #1352 (parent #1336): CloudWatch metric emission helper for
 * operator-facing dashboards / alarms.
 *
 * Why a new helper instead of reusing `external-id-audit-handler/repository.ts`:
 *
 *   `external-id-audit` already publishes `TenkaCloud/CompetitorAccounts` with
 *   the `RotationAge` metric. Reusing that adapter would tangle two unrelated
 *   metric namespaces in one repository module. This helper is namespaced
 *   `TenkaCloud/{env}` (= `TenkaCloud/development` / `TenkaCloud/production`
 *   / `TenkaCloud/Lite` for Lite mode) and is callable from any handler that
 *   crosses the operator dashboard surface (deploy / scoring / participant).
 *
 *   Adapter shape matches `external-id-audit-handler/repository.ts` (= same
 *   `Pick<CloudWatchClient, "send">` injectable + module-scope cached client)
 *   so the harness rule `handler-no-direct-sdk-import` keeps holding.
 *
 * Metric catalog (= the four the operator dashboard subscribes to):
 *
 *   `deploy.duration_ms` — per problem deploy wall-clock from
 *      `startDeployment` to terminal status (= success / failed / timeout).
 *      Unit: Milliseconds. Dimensions: TenantId / ProblemId / Outcome.
 *
 *   `deploy.outcome` — counter (= Value: 1) for every terminal deploy.
 *      Unit: Count. Dimensions: TenantId / ProblemId / Outcome.
 *      Outcome ∈ {success, failed, timeout}. Operator alarm: SUM(failed) /
 *      SUM(success+failed+timeout) > 10% over 15 min.
 *
 *   `scoring.flag_submission_rate` — counter for flag submissions seen by
 *      the scoring loop. Unit: Count. Dimensions: TenantId / ProblemId.
 *      Operator dashboard: SUM(Period=1m) — flat at 0 over event window
 *      means scoring is silently dead.
 *
 *   `scoring.disruption_detection_rate` — counter for disruption checks
 *      that detected an outage. Unit: Count. Dimensions: TenantId /
 *      ProblemId / DisruptionId. Operator dashboard: stacked SUM by
 *      DisruptionId — spike correlates with deliberate competitor attack
 *      vs flaky probe.
 *
 *   All 4 share the same `Environment` dimension so a single dashboard
 *   filters by env (= development vs production vs Lite).
 *
 * env footprint: 1 env var added (`TENKACLOUD_METRIC_ENV`). Empty / unset
 * downgrades to no-op (= same shape as `audit-log.ts` env guard), so old
 * stacks without the env wired still deploy cleanly. The harness #1310
 * Lambda env 3KB rule is therefore not affected — the only added bytes are
 * the env name itself (= 23 bytes) and the env value (= length of "Lite" /
 * "development" / "production", ≤ 11 bytes).
 *
 * fail-safe: PutMetricData failure does **not** propagate. Metric loss is
 * accepted (= operator dashboard goes blank, alarm goes into Insufficient
 * Data) over breaking the business operation.
 */

const METRIC_NAMESPACE_PREFIX = "TenkaCloud";

export type DeployOutcome = "success" | "failed" | "timeout";

export interface MetricClient {
  send: CloudWatchClient["send"];
}

export interface OperatorMetricsContext {
  /**
   * env discriminator (= `development` / `production` / `Lite`). Resolved
   * from `TENKACLOUD_METRIC_ENV`, falling back to `DEPLOY_ENVIRONMENT`,
   * then `"development"`. Used as both the namespace suffix (=
   * `TenkaCloud/Lite`) and the `Environment` dimension on every metric.
   */
  readonly environment: string;
  readonly client: MetricClient;
}

let cachedClient: CloudWatchClient | undefined;

function resolveEnvironment(): string {
  const explicit = process.env.TENKACLOUD_METRIC_ENV ?? "";
  if (explicit.length > 0) return explicit;
  const fallback = process.env.DEPLOY_ENVIRONMENT ?? "";
  if (fallback.length > 0) return fallback;
  return "development";
}

/**
 * Module-scope production client. Lambda warm invokes reuse the same socket
 * pool. Tests inject their own via the `client` option to keep the
 * adapter pure (= same pattern as `external-id-audit-handler/repository.ts`).
 */
export function getOperatorMetricsContext(): OperatorMetricsContext | undefined {
  // 明示 env が無いケースは `TENKACLOUD_METRIC_ENV` の値しか手がかりが無い。
  // 旧 stack (= env 未配線) では `TENKACLOUD_METRIC_ENV` が空文字 → metric emission
  // を no-op に落とす。 `audit-log.ts` の getEnv と同じ fail-safe デザイン。
  const explicit = process.env.TENKACLOUD_METRIC_ENV ?? "";
  if (explicit.length === 0) return undefined;
  if (!cachedClient) {
    cachedClient = new CloudWatchClient({} satisfies CloudWatchClientConfig);
  }
  return {
    environment: resolveEnvironment(),
    client: cachedClient,
  };
}

function buildNamespace(environment: string): string {
  return `${METRIC_NAMESPACE_PREFIX}/${environment}`;
}

interface BaseDimensions {
  readonly tenantId: string;
  readonly problemId: string;
}

async function publish(
  ctx: OperatorMetricsContext,
  metricName: string,
  value: number,
  unit: "Milliseconds" | "Count",
  dimensions: readonly { Name: string; Value: string }[],
  timestamp: Date,
): Promise<void> {
  try {
    await ctx.client.send(
      new PutMetricDataCommand({
        Namespace: buildNamespace(ctx.environment),
        MetricData: [
          {
            MetricName: metricName,
            Value: value,
            Unit: unit,
            Timestamp: timestamp,
            Dimensions: [...dimensions, { Name: "Environment", Value: ctx.environment }],
          },
        ],
      }),
    );
  } catch (err) {
    // metric 欠落は primary 業務 logic より重要度が低い。 throw しない。
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[operator-metrics] PutMetricData failed", { metricName, message });
  }
}

export interface DeployOutcomeArgs extends BaseDimensions {
  readonly outcome: DeployOutcome;
  readonly durationMs: number;
  readonly timestamp?: Date;
}

/**
 * Emit `deploy.duration_ms` (Milliseconds) and `deploy.outcome` (Count=1)
 * together. Operator dashboard pairs them to read latency × outcome ratio.
 */
export async function emitDeployOutcome(
  ctx: OperatorMetricsContext | undefined,
  args: DeployOutcomeArgs,
): Promise<void> {
  if (!ctx) return;
  const timestamp = args.timestamp ?? new Date();
  const dimensions = [
    { Name: "TenantId", Value: args.tenantId },
    { Name: "ProblemId", Value: args.problemId },
    { Name: "Outcome", Value: args.outcome },
  ];
  await publish(ctx, "deploy.duration_ms", args.durationMs, "Milliseconds", dimensions, timestamp);
  await publish(ctx, "deploy.outcome", 1, "Count", dimensions, timestamp);
}

export interface FlagSubmissionArgs extends BaseDimensions {
  readonly count?: number;
  readonly timestamp?: Date;
}

/**
 * Emit `scoring.flag_submission_rate` (Count). One call per submission, or
 * batch with `count` if the scoring loop aggregates. Operator dashboard
 * sums by problem to spot silent scoring death (= flat 0 over event window).
 */
export async function emitFlagSubmission(
  ctx: OperatorMetricsContext | undefined,
  args: FlagSubmissionArgs,
): Promise<void> {
  if (!ctx) return;
  const timestamp = args.timestamp ?? new Date();
  await publish(
    ctx,
    "scoring.flag_submission_rate",
    args.count ?? 1,
    "Count",
    [
      { Name: "TenantId", Value: args.tenantId },
      { Name: "ProblemId", Value: args.problemId },
    ],
    timestamp,
  );
}

export interface DisruptionDetectionArgs extends BaseDimensions {
  readonly disruptionId: string;
  readonly count?: number;
  readonly timestamp?: Date;
}

/**
 * Emit `scoring.disruption_detection_rate` (Count). One call per disruption
 * detection (= probe found target down). Dimensions include `DisruptionId`
 * so operator can stack-chart by category to spot deliberate vs flaky.
 */
export async function emitDisruptionDetection(
  ctx: OperatorMetricsContext | undefined,
  args: DisruptionDetectionArgs,
): Promise<void> {
  if (!ctx) return;
  const timestamp = args.timestamp ?? new Date();
  await publish(
    ctx,
    "scoring.disruption_detection_rate",
    args.count ?? 1,
    "Count",
    [
      { Name: "TenantId", Value: args.tenantId },
      { Name: "ProblemId", Value: args.problemId },
      { Name: "DisruptionId", Value: args.disruptionId },
    ],
    timestamp,
  );
}

/** Exported for unit tests. */
export const __test__ = {
  buildNamespace,
  resolveEnvironment,
};
