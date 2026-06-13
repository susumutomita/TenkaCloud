# Observability and failure diagnosis

> Issue: [#1352](https://github.com/susumutomita/TenkaCloud/issues/1352) (parent: [#1336](https://github.com/susumutomita/TenkaCloud/issues/1336))
> Audience: on-call operator running a paid TenkaCloud event
> Sibling docs: [`deploy-trace.md`](./deploy-trace.md) (= per-job triage), `docs/runbooks/incident-response.md` (= remediation playbook, tracked under #1351)

This page is the operator-facing reference for **what to watch during the event** and **where to look first when something fails**. It pins the structured-log shape, the CloudWatch metric catalog, the saved Insights queries, and a short failure-diagnosis runbook.

## 1. Structured log shape

Every operator-visible event from the Lambda layer emits a single JSON line via the helper at `infrastructure/lib/problem-deploy/handlers/shared/structured-log.ts`. The shape is **pinned by unit tests** (`infrastructure/test/problem-deploy/structured-log.test.ts`):

```json
{
  "level": "info | warn | error",
  "ts": "2026-05-26T12:34:56.000Z",
  "component": "problem-deploy",
  "eventName": "<domain>.<resource>.<verb>",
  "action": "create_deployment",
  "status": "started | succeeded | failed | timeout | skipped",
  "tenantId": "tenant-1",
  "teamId": "team-A",
  "problemId": "hello-world",
  "durationMs": 1234,
  "errorCode": "AccessDeniedError"
}
```

### Naming conventions

| Field | Convention | Example |
| --- | --- | --- |
| `eventName` | `<domain>.<resource>.<verb>` (dot-separated, prefix-greppable) | `deploy.stack.create` / `scoring.flag.submit` / `participant.portal.login` |
| `action` | snake_case verb that maps to operator runbook entry | `create_deployment`, `submit_flag`, `assume_competitor_role` |
| `status` | One of the 5 enum values (= filterable in alarms) | `failed` triggers paged response, `timeout` triggers wait + retry |
| `errorCode` | Stable short identifier (= Error class name when from SDK) | `AccessDenied`, `ValidationError`, `ThrottlingException` |
| `errorMessage` | Clamped to 240 chars to cap CloudWatch ingest cost | (free-form, redaction-safe) |

### Secret redaction (= same allowlist as #1297 audit log)

The helper uses an **allowlist-only** filter (`FIELD_ALLOWLIST` in `structured-log.ts`). Caller-supplied keys outside that set — including secret-shaped names like `password` / `accessKey` / `externalId` / `presignedUrl` / `cookie` / `authorization` / `samlMetadata` / `idToken` / `accessToken` / `refreshToken` / `clientSecret` — are **silently dropped**. Non-primitive values (nested object / array / Date / function) are also dropped, mirroring `redactForAudit` shallow semantics so a future contributor cannot accidentally widen the leak surface.

## 2. CloudWatch metric catalog

Emitted from Lambda code via `infrastructure/lib/problem-deploy/handlers/shared/operator-metrics.ts`. Namespace is `TenkaCloud/{env}` (= `TenkaCloud/Lite` for Lite mode, `TenkaCloud/production` for hosted production). Empty `TENKACLOUD_METRIC_ENV` env value downgrades emission to no-op so old stacks without the env wired still deploy cleanly.

| Metric | Unit | Dimensions | Operator use |
| --- | --- | --- | --- |
| `deploy.duration_ms` | Milliseconds | TenantId, ProblemId, Outcome, Environment | Watch p95 latency per problem; alert if > 8 min |
| `deploy.outcome` | Count | TenantId, ProblemId, Outcome, Environment | Outcome ∈ {success, failed, timeout}. Alarm: `SUM(failed) / SUM(success+failed+timeout) > 10%` over 15 min |
| `scoring.flag_submission_rate` | Count | TenantId, ProblemId, Environment | Flat 0 over event window = silent scoring death |
| `scoring.disruption_detection_rate` | Count | TenantId, ProblemId, DisruptionId, Environment | Spike per `DisruptionId` correlates with deliberate competitor attack vs flaky probe |

### Suggested CloudWatch alarms

- **Deploy failure rate > 10%** — `(SUM deploy.outcome WHERE Outcome=failed) / (SUM deploy.outcome)` over 15 min, threshold 0.1. Indicates competitor account misconfig or platform regression.
- **Event API 5xx rate > 1%** — Standard API Gateway `5XXError` / `Count` on the EventApi stage, over 5 min. Indicates handler crash or DDB throttle.
- **Scoring silent** — `SUM scoring.flag_submission_rate` over 10 min < 1 during an active event window. Indicates the scoring Lambda stopped reading the event stream.

## 3. CloudWatch Logs Insights — saved queries

Drop these into the Logs Insights saved-queries panel of the AWS account hosting the platform.

### Query 1: Deploy slow path (= jobs that took > 5 minutes)

```text
fields @timestamp, tenantId, teamId, problemId, durationMs, status, errorCode
| filter eventName like /^deploy\./ and status in ["succeeded", "failed", "timeout"]
| filter durationMs > 300000
| sort durationMs desc
| limit 50
```

Sort by `durationMs desc` to find which problem template is the slowest under real load. Pair with the `deploy.duration_ms` metric chart for cohort comparison.

### Query 2: Participant 4xx (= portal calls failing on the client side)

```text
fields @timestamp, tenantId, teamId, problemId, eventName, action, status, errorCode, errorMessage
| filter eventName like /^participant\./
| filter status = "failed"
| sort @timestamp desc
| limit 100
```

Reveals which team / which portal action is rejecting. Common `errorCode` values point straight at the runbook section below: `Unauthorized` -> Cognito setup, `NotFound` -> problem teardown raced, `ValidationError` -> portal version drift.

### Query 3: Failed CFn stack (= competitor-account-side rollback)

```text
fields @timestamp, tenantId, teamId, problemId, stackStatus, errorCode, errorMessage
| filter eventName = "deploy.stack.create" or eventName = "deploy.stack.describe"
| filter status = "failed" or stackStatus like /ROLLBACK/ or stackStatus like /FAILED/
| sort @timestamp desc
| limit 50
```

Cross-reference with `deploy-trace.md` Query B (= shell-side `deploy.cfn.deploy.failed`) to pin whether the rollback originated in CFn itself or in our Lambda gating.

### Common log groups to attach

- `/aws/lambda/<problem-deploy stack>-DeployApiFunction*`
- `/aws/lambda/<problem-deploy stack>-EventApiFunction*`
- `/aws/lambda/<problem-deploy stack>-DeployWorkerFunction*`
- `/aws/lambda/<problem-deploy stack>-GenericScoringFunction*`
- `/aws/lambda/<problem-deploy stack>-ParticipantApiFunction*`

## 4. Failure diagnosis runbook

The three event-day failure modes that overlap with this issue (full step-by-step playbook lives under the runbooks directory tracked by #1351):

### 4.1. DeployCreateRequested event disappeared (= "I clicked deploy and nothing happened")

1. **EventBridge bus** — Open the `default` (or `tenkacloud-*` custom) bus in the CloudWatch metrics console; check the `MatchedEvents` metric for the rule routing to the Deploy Worker. Zero matches = rule disabled or filter pattern mismatch.
2. **DLQ** — Check the `ProblemDeployDeadLetterQueue` SQS metric `ApproximateNumberOfMessagesVisible`. Non-zero means the worker rejected the event; pull one message to inspect the failure reason.
3. **Worker Lambda logs** — Run **Query 3** above; if the worker never received the event, the failure is upstream (= EventBridge rule). If it received and failed, the failure is downstream (= AssumeRole or CFn).

### 4.2. DDB throttle (= sudden slowness across all admin actions)

1. **Provisioned capacity** — Open the table in DDB console; check `ReadThrottleEvents` / `WriteThrottleEvents`. Any non-zero count means traffic exceeded 1 RCU / 1 WCU (= `DynamoDbLowCapacity` Aspect, per AGENTS.md).
2. **Scan pattern** — Run query: `filter eventName like /^deploy\./ | stats count() by action`. A `list_*` action spiking out of proportion = O(N) scan replacing a Query. Fix is to add a GSI or to switch to PK-scoped Query.
3. **Mitigation** — Burst capacity can carry short spikes. If the pattern is persistent (= the same scan every poll cycle), open an issue and add a covering GSI. **Do not switch the table to on-demand** — that violates the Free Tier budget.

### 4.3. Cognito sign-in failure (= participant cannot log in)

1. **User pool client** — Confirm the client ID in `runtime-config.json` matches the deployed pool (= mismatch is the #1 cause after a redeploy).
2. **Hosted UI domain** — Try the hosted UI URL directly in a private window. A 404 means the domain is not provisioned for this stage / region.
3. **Callback URL** — Open the user pool app client -> "Hosted UI" tab. The `Callback URL` list must contain the **exact** participant portal origin (CloudFront URL or `localhost:5175` for dev). Off-by-one slash = redirect_mismatch error.
4. **Logs** — Run **Query 2** above with `filter errorCode = "Unauthorized"` to see if the Lambda authorizer is rejecting the JWT (= different failure from Cognito sign-in itself).

## 5. Local dev parity

The same helper runs in `make dev`. Open the Lambda Local Runtime console (= `bun run dev` in `infrastructure/`) and the same JSON lines appear on stdout. CloudWatch is not the gate during development; the gate is the test (`bun run test test/problem-deploy/structured-log.test.ts`) which pins the wire shape so the operator query never drifts from the producer.

## 6. Related ADRs and issues

- [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) — why this issue uses polling-friendly logs and metrics rather than SSE
- [Issue #768](https://github.com/susumutomita/TenkaCloud/issues/768) — `trace-log.ts` (= per-job triage helper, sibling of this one)
- [Issue #1297](https://github.com/susumutomita/TenkaCloud/issues/1297) — audit log redaction allowlist (same pattern as `redactFields` here)
- [Issue #1310](https://github.com/susumutomita/TenkaCloud/issues/1310) — Lambda env 3KB harness budget (= this issue stays under it; helpers are pure code with 1 optional env)
- [Issue #1336](https://github.com/susumutomita/TenkaCloud/issues/1336) — parent commercial-event launch readiness epic
