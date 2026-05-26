# Incident response

> Japanese: [incident-response.ja.md](./incident-response.ja.md)

| Attribute | Value |
|---|---|
| Audience | On-call operator (the person triaging an active incident) |
| When to use | When [live monitoring](./live-monitoring.md) sends you here, or when a participant report cannot be resolved within one minute of observation |
| Estimated time | 5 to 30 minutes per incident |
| Output | Either the incident is resolved with a recorded action, or it is escalated with a documented reason |

This runbook covers the four most common incident classes during a hosted event. Each section follows the same shape: **symptoms → 1st response → safe remediation → escalation**. Do not improvise; pick the matching section and follow it.

> **Before you act:** Record one observation line in the event timeline (see [live monitoring](./live-monitoring.md#recording-the-event-timeline)). Every act-without-observe step is how operators make outages worse.

## Section 1: Lambda errors

### Symptoms

- CloudWatch shows a non-zero error rate on the deploy worker, scoring Lambda, or one of the API handlers.
- Operator dashboard shows deployments stuck in `IN_PROGRESS` or scoring loop frozen.
- Participants report stale scoreboard or "deploy never finishes".

### 1st response (under 5 minutes)

1. Confirm which Lambda is erroring. Filter CloudWatch by function name.
2. Read the most recent error log. Look for stack trace, error class, and タイムスタンプ.
3. Classify: is this a transient AWS error (throttling, timeout, networking) or a code-level error (TypeError, deserialization failure)?

### Safe remediation

| Error class | Action |
|---|---|
| Transient AWS error (rate limit, timeout, DNS) | Wait two minutes. Most resolve themselves under retry. Send `info` notification if participants notice. |
| Cold-start latency only | No action; latency is not an incident. Continue [live monitoring](./live-monitoring.md). |
| Code-level error (TypeError, schema validation) | Capture log lines into the event timeline. Do not patch code mid-event; redeploying the platform during a live event is forbidden. Note the affected scoring or deploy path and continue. |
| Repeated `AccessDenied` from AssumeRole | The ExternalId is wrong for that team. Verify the team metadata and re-issue the credentials. |

### Escalation

- If the error rate is sustained more than 5 errors / minute for 5 minutes, send `warning` notification and brief the facilitator.
- If the error affects every team, treat as platform-wide incident and consider pausing scoring until resolved.

## Section 2: DynamoDB throttling

### Symptoms (DynamoDB throttling)

- CloudWatch DynamoDB metric `UserErrors` or `ThrottledRequests` is non-zero.
- Participant portal scoreboard is slow or returns sporadic errors.
- Operator dashboard shows lag between event-time and scoreboard time.

### 1st response (under 5 minutes) — DynamoDB throttling

1. Identify the table being throttled (`Deployments`, `Apps`, `Events`, `TenantMappingTable`, etc.).
2. Check the read / write capacity. Every TenkaCloud table is forced to PROVISIONED 1 RCU / 1 WCU by the [`DynamoDbLowCapacity`](../../infrastructure/lib/cdk-aspect) aspect for AWS Free Tier safety.
3. Decide whether the throttling is caused by participant traffic (legitimate) or by a runaway Lambda (incident).

### Safe remediation — DynamoDB throttling

| Cause | Action |
|---|---|
| Legitimate traffic burst (event spike) | Send `info` notification "scoreboard refresh may be delayed" and wait for the burst to subside. Do not raise capacity in the middle of the event unless every Free Tier guard rail decision has been re-discussed. |
| Runaway Lambda hot-looping | Identify and stop the Lambda invocation source. Most often a misconfigured EventBridge rule firing in a loop. |
| Operator-induced scan / list | Stop the scan. Most operator queries should target specific keys. |

> **Do not** flip the table to `PAY_PER_REQUEST` mid-event. The aspect enforces PROVISIONED 1/1; switching modes requires a CDK change and is forbidden inline.

### Escalation — DynamoDB throttling

- If throttling cannot be relieved in 10 minutes, pause scoring and send `warning` notification before participants notice systematic data loss.
- Document the table and the cause in the event timeline for post-event review.

## Section 3: Cognito sign-in failure

### Symptoms (Cognito sign-in failure)

- Participant reports cannot log in via the participant portal.
- Application Admin Console SSO login fails.
- Operator sees Cognito Hosted UI errors in CloudWatch.

### 1st response (under 5 minutes) — Cognito sign-in failure

1. Confirm the scope: one participant, one team, or all participants.
2. For a single participant: ask them to clear cookies and retry. Verify the participant portal URL has no trailing whitespace.
3. For a single team: check the team's metadata is wired. Confirm SSO IdP configuration if federated.
4. For all participants: this is a platform-wide incident. Treat as Section 4 or as Lambda errors depending on the failure mode.

### Safe remediation — Cognito sign-in failure

| Failure mode | Action |
|---|---|
| Wrong login key (typo, trailing space) | Re-send the correct key over the agreed channel from [participant onboarding](./participant-onboarding.md). |
| Cognito Hosted UI 5xx | Wait 60 seconds and retry. Most Cognito Hosted UI errors are transient. |
| OAuth callback URL mismatch | The participant portal URL changed since deploy. Confirm the callback URL in Cognito matches the current CloudFront URL. Re-deploy is the fix; do not patch Cognito by hand. |
| SAML IdP rejecting the assertion | Check the IdP-side log first. See [`docs/operations/application-plane-saml-setup.md`](../operations/application-plane-saml-setup.md). |
| Account is locked | Cognito locks after multiple failed attempts. Wait 15 minutes or unlock via the AWS Console. |

### Escalation — Cognito sign-in failure

- If multiple teams cannot log in, hold the event and send `warning` notification before announcing further actions.
- If the callback URL is wrong, this is a deploy-time bug — do not attempt to fix in-flight, document and recover via [teardown](./teardown.md).

## Section 4: CloudFormation stack ROLLBACK

### Symptoms (CFn stack ROLLBACK)

- One or more team stacks show `CREATE_FAILED`, `ROLLBACK_IN_PROGRESS`, or `ROLLBACK_COMPLETE` in the operator dashboard or the team account.
- Participant reports their endpoint is unreachable.
- Deploy trace shows `deploy.cfn.deploy.failed`.

### 1st response (under 5 minutes) — CFn stack ROLLBACK

1. Identify the failing stack and the failure reason from CFn stack events.
2. Classify the failure:
   - **Quota** (account-level limit, e.g., VPC, EIP, Lambda)
   - **Region restriction** (service not available in the chosen region)
   - **IAM** (missing permission for the AssumeRole path, often ExternalId-related)
   - **Template defect** (bug in the problem template — should have been caught in [dry run](./dry-run.md))

### Safe remediation — CFn stack ROLLBACK

| Failure class | Action |
|---|---|
| Quota | Request a quota increase or move the team to a different region if the problem allows. Do not work around quota by manually creating resources. |
| Region restriction | Drop the problem for that team or change the region (only if a single-region change is safe per the problem template). |
| IAM | Verify ExternalId, the competitor-bootstrap.yaml IAM role is rolled out, and the participant viewer role has the right policy. AssumeRole into competitor accounts always requires ExternalId; this is a hard invariant (see [CLAUDE.md](../../CLAUDE.md) security section). |
| Template defect | Do not patch in-flight. Drop the problem for the affected teams, send `warning` notification, and capture for post-event fix. |

### Safe redeploy

If you decide to redeploy (single-team only, after the triage in [live monitoring](./live-monitoring.md)):

1. Initiate teardown of the failed stack first (`scripts/delete-battles.sh` or the Application Admin Console teardown action). Confirm `DELETE_COMPLETE` before re-creating.
2. Re-issue `DeployRequested` from the operator UI.
3. Watch the deploy trace for the new `jobId`. Do not declare success until `deploy.cfn.deploy.succeeded` appears.

### Escalation — CFn stack ROLLBACK

- If multiple teams fail simultaneously with the same cause, treat as platform-wide. Pause scoring, send `warning`, and do not redeploy until you understand the cause.
- If ROLLBACK leaves orphaned resources, document and follow up in [teardown](./teardown.md).

## Universal post-incident steps

After every incident:

1. Append the final timeline entries (observed, acted, resolved).
2. Send one `info` notification: "Issue resolved; scoring is current as of HH:MM."
3. File a post-event issue describing the cause, action, and any code-level follow-up.
4. If the incident produced orphan resources or unclear scoring state, escalate to [teardown](./teardown.md) for handling at event end.

## Related runbooks and ADRs

- Use together with: [live monitoring](./live-monitoring.md) — every incident starts from a live monitoring observation.
- After event: [teardown](./teardown.md) — orphan resources from incidents are recovered here.
- Background: [ADR-006: Notifications](../architecture/adr-006-notifications.html) (you cannot edit notifications, so wording matters), [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) (why state converges asynchronously), [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md) (jobId tracing for incidents).
