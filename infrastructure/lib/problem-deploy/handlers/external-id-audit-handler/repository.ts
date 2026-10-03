import {
  CloudWatchClient,
  type CloudWatchClientConfig,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { CompetitorAccountItem } from "../competitor-accounts-handler/types.js";

/**
 * Issue #1237 / SOLID enforcement: SDK adapter for the
 * `external-id-audit-handler` Lambda.
 *
 * The handler `index.ts` must not import `@aws-sdk/*` directly — routing stays
 * separate from infrastructure concerns. This module owns:
 *
 *   - Construction of the CloudWatch `PutMetricData` command + dimension
 *     marshalling.
 *   - Construction of the module-scope clients used by the warm Lambda invoke
 *     path (= cold start fan-out is amortised across invocations).
 *
 * The handler stays free of AWS SDK types: it depends on the
 * `CompetitorAccountsRepository` / `RotationAgeMetricsRepository` interfaces
 * and on the `Repositories` factory that wires the production clients.
 *
 * [Issue #2442 / Phase C2] The `CompetitorAccounts` Scan itself moved behind
 * the control-data repository seam (`resolveCompetitorAccountsRepository`),
 * so this module no longer constructs a `ScanCommand` directly — it delegates
 * to `CompetitorAccountsRepository.forEachCompetitorAccountPage` (the B3
 * per-page callback pattern), which is transparent to the `dynamodb` /
 * `turso` backend selection.
 *
 * Behaviour parity (= no runtime change vs the previous in-handler
 * implementation) on the `dynamodb` backend:
 *
 *   - `ProjectionExpression` keeps `tenantId, awsAccountId, rotatedAt,
 *     createdAt` so the DDB read footprint is unchanged.
 *   - `PutMetricData` keeps `Namespace = TenkaCloud/CompetitorAccounts`,
 *     `MetricName = RotationAge`, `Unit = None`, `Dimensions = TenantId /
 *     AwsAccountId / Environment` — exactly the values the existing
 *     CloudWatch alarm + dashboard consume.
 *   - `PUT_METRIC_BATCH_SIZE = 1000` matches the AWS PutMetricData hard
 *     limit. MVP scale (~150 accounts) fits in one batch; the loop exists
 *     as defence in depth for future scale-out.
 */

const METRIC_NAMESPACE = "TenkaCloud/CompetitorAccounts";
const METRIC_NAME = "RotationAge";

/**
 * PutMetricData は 1 call あたり 1000 datapoint まで。MVP 規模で 1000 を超えることは
 * 無いが、防御的に chunk 化する。
 */
const PUT_METRIC_BATCH_SIZE = 1000;

export interface CompetitorAccountsRepository {
  /**
   * [Issue #2442 / Phase C2] Streams every CompetitorAccounts row's
   * rotation-audit projection (`tenantId` / `awsAccountId` / `rotatedAt` /
   * `createdAt`), one physical page at a time — the B3 per-page callback
   * pattern (mirrors `DeploymentsRepository.forEachCompleteDeploymentPage`).
   * Thin delegate to the control-data seam's
   * `CompetitorAccountsRepository.forEachCompetitorAccountPage`.
   */
  forEachAccountPage(
    onPage: (items: readonly Partial<CompetitorAccountItem>[]) => Promise<void>,
  ): Promise<void>;
}

export interface RotationAgeMetricDatum {
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly ageDays: number;
}

export interface RotationAgeMetricsRepository {
  /**
   * Publish a batch of `(tenantId, awsAccountId, ageDays)` datapoints to the
   * `TenkaCloud/CompetitorAccounts` namespace. Internally chunks into the
   * 1000-datapoint PutMetricData limit so callers can pass arbitrarily large
   * arrays.
   */
  putRotationAge(opts: {
    readonly datapoints: readonly RotationAgeMetricDatum[];
    readonly environmentName: string;
    readonly timestamp: Date;
  }): Promise<void>;
}

/**
 * Bundles the two repositories so the handler only depends on a single
 * factory. Tests can swap in fakes by passing an alternate `Repositories`
 * object to `runAudit` (= the production `composeRepositories()` is one of
 * many possible implementations).
 */
export interface Repositories {
  readonly competitorAccounts: CompetitorAccountsRepository;
  readonly rotationAgeMetrics: RotationAgeMetricsRepository;
}

export function createCompetitorAccountsRepository(deps: {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
}): CompetitorAccountsRepository {
  return {
    async forEachAccountPage(onPage) {
      const repository = await deps.runtime.resolveCompetitorAccountsRepository({
        ddb: deps.ddb,
        competitorAccountsTableName: deps.tableName,
      });
      await repository.forEachCompetitorAccountPage(onPage);
    },
  };
}

export function createRotationAgeMetricsRepository(
  cw: Pick<CloudWatchClient, "send">,
): RotationAgeMetricsRepository {
  return {
    async putRotationAge({ datapoints, environmentName, timestamp }) {
      if (datapoints.length === 0) return;
      for (let i = 0; i < datapoints.length; i += PUT_METRIC_BATCH_SIZE) {
        const slice = datapoints.slice(i, i + PUT_METRIC_BATCH_SIZE);
        await cw.send(
          new PutMetricDataCommand({
            Namespace: METRIC_NAMESPACE,
            MetricData: slice.map((d) => ({
              MetricName: METRIC_NAME,
              Value: d.ageDays,
              Unit: "None",
              Timestamp: timestamp,
              Dimensions: [
                { Name: "TenantId", Value: d.tenantId },
                { Name: "AwsAccountId", Value: d.awsAccountId },
                { Name: "Environment", Value: environmentName },
              ],
            })),
          }),
        );
      }
    },
  };
}

/**
 * Module-scope production clients. Lambda warm invokes reuse the same socket
 * pool — keep the constructors outside the request path. `tableName` is a
 * per-invoke input (from the env, resolved by the handler), so only the
 * clients themselves are memoized here; `composeRepositories` is cheap to
 * re-call every invoke.
 */
let cachedDdb: DynamoDBDocumentClient | undefined;
let cachedCloudWatch: CloudWatchClient | undefined;

export function composeRepositories(runtime: ControlDataRuntime, tableName: string): Repositories {
  cachedDdb ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  cachedCloudWatch ??= new CloudWatchClient({} satisfies CloudWatchClientConfig);
  return {
    competitorAccounts: createCompetitorAccountsRepository({ runtime, ddb: cachedDdb, tableName }),
    rotationAgeMetrics: createRotationAgeMetricsRepository(cachedCloudWatch),
  };
}
