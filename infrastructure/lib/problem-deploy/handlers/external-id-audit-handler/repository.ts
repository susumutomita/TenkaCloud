import {
  CloudWatchClient,
  type CloudWatchClientConfig,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { CompetitorAccountItem } from "../competitor-accounts-handler/types.js";

/**
 * Issue #1237 / SOLID enforcement: SDK adapter for the
 * `external-id-audit-handler` Lambda.
 *
 * The handler `index.ts` must not import `@aws-sdk/*` directly (see
 * `.claude/harness/src/rules/handler-no-direct-sdk-import.ts`). This module
 * owns:
 *
 *   - Construction of the `CompetitorAccounts` DDB Scan command + paging.
 *   - Construction of the CloudWatch `PutMetricData` command + dimension
 *     marshalling.
 *   - Construction of the module-scope clients used by the warm Lambda invoke
 *     path (= cold start fan-out is amortised across invocations).
 *
 * The handler stays free of AWS SDK types: it depends on the
 * `CompetitorAccountsRepository` / `RotationAgeMetricsRepository` interfaces
 * and on the `Repositories` factory that wires the production clients.
 *
 * Behaviour parity (= no runtime change vs the previous in-handler
 * implementation):
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

export interface CompetitorAccountsScanPage {
  /** projection-applied subset of CompetitorAccountItem (tenantId / awsAccountId / rotatedAt / createdAt). */
  readonly items: readonly Partial<CompetitorAccountItem>[];
  /** opaque pagination cursor (DDB `LastEvaluatedKey`); `undefined` once iteration completes. */
  readonly nextCursor?: Record<string, unknown>;
}

export interface CompetitorAccountsRepository {
  /**
   * Scan one page of `CompetitorAccounts`. Caller drives the loop using the
   * returned `nextCursor` to stay agnostic of DDB-specific paging shapes.
   */
  scanPage(opts: {
    readonly tableName: string;
    readonly cursor?: Record<string, unknown>;
  }): Promise<CompetitorAccountsScanPage>;
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

export function createCompetitorAccountsRepository(
  ddb: Pick<DynamoDBDocumentClient, "send">,
): CompetitorAccountsRepository {
  return {
    async scanPage({ tableName, cursor }) {
      const out = await ddb.send(
        new ScanCommand({
          TableName: tableName,
          ProjectionExpression: "tenantId, awsAccountId, rotatedAt, createdAt",
          ExclusiveStartKey: cursor,
        }),
      );
      return {
        items: (out.Items ?? []) as Partial<CompetitorAccountItem>[],
        nextCursor: out.LastEvaluatedKey as Record<string, unknown> | undefined,
      };
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
 * pool — keep the constructors outside the request path.
 */
let cachedRepositories: Repositories | undefined;

export function composeRepositories(): Repositories {
  if (!cachedRepositories) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const cw = new CloudWatchClient({} satisfies CloudWatchClientConfig);
    cachedRepositories = {
      competitorAccounts: createCompetitorAccountsRepository(ddb),
      rotationAgeMetrics: createRotationAgeMetricsRepository(cw),
    };
  }
  return cachedRepositories;
}
