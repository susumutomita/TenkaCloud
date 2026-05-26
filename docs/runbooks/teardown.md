# Teardown

> Japanese: [teardown.ja.md](./teardown.ja.md)

| Attribute | Value |
|---|---|
| Audience | Operator (the person responsible for closing the event cleanly) |
| When to use | Within 24 hours after the announced event end. Do not let teardown drift; orphan resources keep billing. |
| Estimated time | 60 minutes for a typical Lite-mode event; longer if multiple teams have orphaned resources |
| Output | Every event stack is `DELETE_COMPLETE` or explicitly archived; audit log export is saved; competitor IAM roles are documented as deprovisioned |

The teardown runbook closes the loop opened by [pre-event checklist](./pre-event-checklist.md). It exists because the most expensive failure mode is a leftover Lambda or DDB table billing for a year after the event ended.

## Three required outputs

| # | Output | Why it matters |
|---|---|---|
| 1 | Every event-scoped CFn stack is `DELETE_COMPLETE`, or moved to a documented "Force ARCHIVED" state with a written reason | Cost containment. Orphans cost money. |
| 2 | Audit log export is captured (CloudTrail / scoring history / notification log) | SOC2 evidence and post-event review. Audit logs must survive the teardown of the platform itself. |
| 3 | Each competitor IAM role is confirmed deprovisioned (or scheduled to expire) | Security. Cross-account trust without an active event is an unnecessary attack surface. |

## Step-by-step

### Step 0: confirm the event is really ended (5 min)

- [ ] Scoring loop is stopped (operator dashboard shows no active scoring jobs).
- [ ] No participant is mid-submission. Send one final `info` notification: "Event closed at HH:MM. Submissions after this time are not scored."
- [ ] Wait for any in-flight deploy to complete (`make ops-health` shows zero IN_PROGRESS jobs) before initiating teardown — tearing down mid-deploy creates orphans.

### Step 1: collect audit evidence first (10 min)

Do this **before** you start destroying things. Once stacks are deleted, some logs become harder to retrieve.

- [ ] Export CloudTrail events for the event window to S3 (the production AWS environment should already be configured to ship CloudTrail; if not, capture manually). This is the primary SOC2 evidence.
- [ ] Export the scoring history. The scoring DynamoDB tables retain history until DDB TTL fires; copy the relevant team and event records out of band.
- [ ] Export the notification log from the Events table. Notifications cannot be edited or deleted (see [ADR-006](../architecture/adr-006-notifications.html)), so the table is authoritative.
- [ ] Save the [live monitoring](./live-monitoring.md) event timeline to the same archive folder.

### Step 2: tear down per-team problem stacks (15 min)

For each team and each deployed problem:

- [ ] Initiate teardown via the Application Admin Console teardown action or `make destroy-battles BATTLES="problems/<category>/<id>" TEAM_SLUG=<slug>` for the Lite-mode local path.
- [ ] Confirm `deploy.cfn.delete.succeeded` in the deploy trace.
- [ ] Confirm the stack is `DELETE_COMPLETE` in the team's AWS account (cross-account DescribeStack from the operator, or ask the team to confirm).

> **Force ARCHIVED procedure.** If a team's stack is stuck in `DELETE_FAILED` or `UPDATE_ROLLBACK_FAILED`, follow this manual sequence:
>
> 1. Inspect the failure: open the CFn stack in the team's AWS account and read the failed event reasons.
> 2. Manually delete the blocking resources (most often S3 buckets with content, EIPs in use, or ENIs attached to deleted security groups). Document each manual delete in the teardown report.
> 3. Re-run `delete-stack` from the operator after the blocker is removed.
> 4. If the stack still cannot delete, mark it `ARCHIVED` in the event run sheet with the date and the resource list left behind. The team account owner is responsible for follow-up. **Never leave it "I will check later" — write it down.**

### Step 3: tear down the platform (15 min)

- [ ] Lite mode: `make destroy` (runs `bun run scripts/tenkacloud-lite.ts down`). Confirm both `AppPlaneCore` and `ProblemDeployBackend` reach `DELETE_COMPLETE`.
- [ ] SaaS mode: `make destroy-saas` (runs `scripts/cleanup.sh`). This script is intentionally idempotent — if a prior attempt left partial state, re-run it.
- [ ] Confirm the source bundle S3 bucket is empty or scheduled for lifecycle deletion (the bucket itself may persist between events; the bundle inside is what costs).

### Step 4: deprovision competitor IAM roles (10 min)

The [competitor-bootstrap.yaml](../../infrastructure/templates/competitor-bootstrap.yaml) IAM Role is rolled out one time in each competitor account. After the event:

- [ ] For each team account, ask the team to delete the IAM Role stack OR confirm a documented retention window (e.g., "kept until the next event in 4 weeks").
- [ ] Record the disposition (deleted, retained-until-DATE) in the event run sheet for SOC2 evidence.
- [ ] If a team retains the role, confirm the ExternalId is rotated before the next event. Reusing the same ExternalId across separated events weakens the AssumeRole guarantee.

### Step 5: cost check (5 min)

- [ ] Open AWS Cost Explorer for the event AWS account and confirm the cost curve flattens within 24 hours of teardown.
- [ ] If cost continues to accrue, return to Step 2 — there is an orphan resource somewhere.

### Step 6: file post-event issues (5 min)

- [ ] Open one GitHub issue per gap surfaced during the event or teardown (broken problem, slow scoring, manual-delete required during Force ARCHIVED).
- [ ] Link each issue to the parent commercial-launch epic (#1336) where applicable.

## If it goes wrong

| Symptom | First response | Escalation |
|---|---|---|
| A stack will not delete (`DELETE_FAILED`) | Follow the Force ARCHIVED procedure in Step 2. Do not loop on `delete-stack` without fixing the blocker. | If you cannot identify the blocker, escalate to the team account owner with a list of stuck resources. |
| Audit log export is incomplete | Stop teardown until the audit evidence is captured. The platform must outlive the platform itself for SOC2 purposes. | If CloudTrail was not enabled, file an immediate fix-forward issue; do not silently accept incomplete evidence. |
| Cost continues to accrue after teardown | An orphan resource exists. Walk the AWS Cost Explorer service-by-service to find it. | If you cannot find it within 60 minutes, escalate with the AWS account owner. |
| Team did not delete the competitor IAM role | Record retention window explicitly and rotate the ExternalId before the next event. | If the team is unreachable, document the open trust path as a known risk; do not silently leave it. |
| Multiple stacks stuck in DELETE_FAILED simultaneously | Likely a region-wide AWS issue or a missed dependency. Wait 30 minutes, retry; otherwise consult the [incident response](./incident-response.md) Section 4 (CFn ROLLBACK) for context. | Escalate as a platform-wide post-incident; the design assumption in [ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) is that state eventually converges — give it time. |

## Closing the loop

- File a post-event review thread (separate from per-issue follow-ups) describing what worked, what failed, and what to change in the next [pre-event checklist](./pre-event-checklist.md) cycle.
- Update this runbook if you discovered a teardown gap not covered here. The runbook is the source of truth for the next operator.

## Related runbooks and ADRs

- Previous: [pre-event checklist](./pre-event-checklist.md), [dry run](./dry-run.md), [participant onboarding](./participant-onboarding.md), [live monitoring](./live-monitoring.md), [incident response](./incident-response.md).
- Background: [ADR-006: Notifications](../architecture/adr-006-notifications.html) (notification log must be captured before teardown), [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) (state converges asynchronously; wait before forcing).
