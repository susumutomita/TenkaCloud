# Capacity pressure & throttling response

> 日本語: [capacity-pressure.ja.md](./capacity-pressure.ja.md)

| Attribute | Value |
|---|---|
| Audience | On-call operator (whoever receives the Free-Tier / capacity-pressure alarms) |
| When to use | On a `tenkacloud-freetier-*` / `tenkacloud-health-*` alarm, or a CostBudget 80 / 100 percent notification |
| Time | 5–15 min triage per alarm; longer if a scale-up decision is involved |
| Output | One timeline line per alarm: the observed number / the classification (false alarm / transient / actionable) / the action taken (including "nothing") |

[`free-tier-alarms.ts`](../../infrastructure/lib/observability/free-tier-alarms.ts) and `CostBudget` **detect** capacity and cost pressure. This runbook defines the **response** side. An alarm says "observe and classify", not "act now" — scaling in a panic pushes you past the Free Tier and burns cost for nothing. As in [live-monitoring](./live-monitoring.md), keep the order **observe → classify → (only then) act**.

## Alarm catalog

| Alarm name | Meaning | Default threshold | Likely cause |
|---|---|---|---|
| `tenkacloud-freetier-lambda-<fn>` | Daily Lambda invocations exceed ~80 percent of the Free Tier (1M/month) | 26,666 / day | runaway polling / retry loop / more participants than expected |
| `tenkacloud-health-lambda-errors-<fn>` | Daily Lambda error count exceeds the threshold | 50 / day | deploy failure / missing permission / downstream fault |
| `tenkacloud-health-apigw-5xx-<api>` | Daily API Gateway 5XX count exceeds the threshold | 50 / day | backend Lambda exception / timeout |
| `tenkacloud-freetier-ddb-read-<table>` | Daily ConsumedReadCapacityUnits exceed the threshold | 100,000 / day | reads concentrated on the 1 RCU ceiling (throttle zone) |
| `tenkacloud-freetier-ddb-write-<table>` | Daily ConsumedWriteCapacityUnits exceed the threshold | 100,000 / day | writes concentrated on the 1 WCU ceiling (throttle zone) |
| CostBudget 80 / 100 percent | Monthly cost reaches 80 / 100 percent of the ceiling (SNS email) | monthly budget | a resource has left the Free Tier |

Every threshold is overridable per environment via CDK props (`lambdaDailyInvocationThreshold`, etc.). See the source constant comments for the rationale of each default.

## Triage

1. **Observe**: from the alarm name, identify the target (Lambda / API / table) and read its recent trend in CloudWatch metrics and the [`ObservabilityStack`](../../infrastructure/lib/observability/) dashboard. Distinguish a one-off spike from a sustained climb.
2. **Classify**:
   - **False alarm / transient**: a single spike that already settled → record only, take no action.
   - **Expected load**: a normal rise from more participants → proceed to the scale decision below.
   - **Anomaly**: a retry loop / cascading errors / abnormal requests from one team → stop the cause (pair with [incident-response](./incident-response.ja.md)).
3. **Act**: only after the classification is settled, take the minimum necessary action.

## Response per alarm

### DynamoDB capacity (`tenkacloud-freetier-ddb-read/write-*`)

The `DynamoDbLowCapacity` aspect pins every table to **PROVISIONED 1 RCU / 1 WCU** (to stay inside the 25/25 Free Tier). When read/write exceeds the sustained ceiling of one unit (~1 req/sec), DynamoDB **throttles**. First decide whether the throttling is actually harmful:

- **The SDK's retries absorb it** (no user impact) → do nothing. Throttling is the intended cost-saving behaviour.
- **Throttling delays scoring ticks / deploys** (user impact) → **deliberately** raise the capacity of the affected table.

> ⚠️ Raising capacity is **manual today**. Runtime-adjustable capacity (the `[INFRA]` child of [#1431](https://github.com/susumutomita/TenkaCloud/issues/1431)) is not yet implemented. Current procedure:
>
> 1. In `infrastructure/lib/cdk-aspect/`, review the `DynamoDbLowCapacity` scope and either exclude the table or raise its capacity (owner review required).
> 2. Run `make diff` and confirm the change is **a PROVISIONED-value change only** (not a table replacement).
> 3. Anything above the 25 RCU/WCU Free Tier is **billed**. Trade it against the CostBudget headroom: raise it only for the event window and return it to 1/1 at teardown.

Switching to `PAY_PER_REQUEST` (on-demand) is **forbidden** (`DynamoDbLowCapacity` blocks it — it makes cost unpredictable).

### Lambda invocations (`tenkacloud-freetier-lambda-*`)

Approaching the 1M req/month Free Tier. First suspect a **runaway**:

- Is the frontend polling interval as expected? (Because we use polling rather than SSE/WebSocket, invocations scale straightforwardly with participants × interval.)
- Is the EventBridge-driven reconciliation ([ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html)) firing too often?
- Is there a retry storm? (Does it co-fire with the errors alarm?)

For a legitimate participant increase, invocations are linear and **settle on their own when the event ends** — usually no action is needed.

### Lambda errors / API Gateway 5XX (`tenkacloud-health-*`)

A **health** alarm, not a capacity one. Filter CloudWatch Logs Insights by `jobId` etc. ([deploy-trace](../operations/deploy-trace.md)) and identify the exception. If it is deploy-related, merge into [incident-response](./incident-response.ja.md).

### CostBudget 80 / 100 percent

Monthly cost is approaching the ceiling. Use Cost Explorer to see the per-service breakdown and identify the resource that **left the Free Tier** (most often a forgotten DDB capacity raise from above, or unexpected data transfer). On 100 percent, tear down unnecessary resources to the extent that stops the billing.

## Escalation

- User-impacting throttling / errors lasting more than 15 minutes → escalate to the owner and get approval for the capacity raise (a billing decision).
- After the event, **always return the raised capacity to 1/1** (a forgotten raise is the single biggest driver of next month's cost).

## Related

- [live-monitoring](./live-monitoring.md) — the continuous monitoring loop during an event
- [incident-response](./incident-response.ja.md) — incident classification and response
- [`free-tier-alarms.ts`](../../infrastructure/lib/observability/free-tier-alarms.ts) — alarm definitions (source of truth for thresholds)
- [#1431](https://github.com/susumutomita/TenkaCloud/issues/1431) — runtime-adjustable capacity (the `[INFRA]` child this runbook assumes)
