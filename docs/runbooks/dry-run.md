# Dry run

> Japanese: [dry-run.ja.md](./dry-run.ja.md)

| Attribute | Value |
|---|---|
| Audience | Operator (the person who will be on-call during the real event) |
| When to use | Within 7 days before the real event. Hard prerequisite, not optional. |
| Estimated time | 90 minutes start to finish |
| Output | A signed-off dry-run report listing every gap found and either fixed or accepted in writing |

The dry run exists because the only failure modes that matter on event day are the ones nobody anticipated. Running through the entire flow once on the same configuration you will ship is the cheapest way to discover them.

> **Do not skip the dry run.** If the schedule does not allow a dry run, reschedule the event. The [pre-event checklist T-7 row](./pre-event-checklist.md#dry-run-scheduled-hard-gate) treats this as a hard gate.

## Scope of the dry run

The dry run must exercise the same path the participants will exercise.

| Layer | What you deploy or invoke | Why it matters |
|---|---|---|
| Platform | Lite mode (`make deploy`) or SaaS mode (`make deploy-saas`) for the event environment | Catches IAM / Cognito / DNS issues at the platform layer before the event |
| Problem catalog | Every problem you plan to deliver at the event, deployed to one rehearsal team | Catches CFn template drift, region restrictions, account quota issues |
| Participant flow | Log into the participant portal, accept the problem, submit a flag / observe scoring | Catches scoring kind misconfiguration, missing portal slots, broken endpoints |
| Operator flow | Send `info` and `warning` notifications, observe via [`docs/operations/notifications.md`](../operations/notifications.md) | Catches notification path failures and the ADR-006 polling delay surprises |
| Teardown | Tear down the rehearsal team's stacks via the participant portal teardown UI | Catches the teardown failure modes that are hardest to recover from after the real event |

If a problem cannot be exercised end-to-end during the dry run, treat the problem as not ready and drop it from the event catalog.

## Step-by-step

### Step 0: pre-flight (10 min)

- [ ] Confirm the dry-run AWS environment matches the production event environment (same region, same Lite vs SaaS choice, same problem catalog pin).
- [ ] `make harness && make before-commit` green on the branch under test.
- [ ] Free up a rehearsal team AWS account with `infrastructure/templates/competitor-bootstrap.yaml` already rolled out (or use the organizer-rented account flow).

### Step 1: platform deploy (15 min)

- [ ] Run `make deploy` (Lite) or `make deploy-saas` (SaaS).
- [ ] Wait for every stack to reach `CREATE_COMPLETE` / `UPDATE_COMPLETE`.
- [ ] Capture the output URLs (`make lite-portal-url`, `make lite-console-url`, or the SaaS Admin Console URL).

**If it goes wrong:** A failed stack is the most expensive thing to discover on event day. If a stack fails here, debug the root cause and re-run the dry run from Step 0. Do not work around it with manual fixes that the production deploy will not have.

### Step 2: deploy each selected problem (20 min)

- [ ] For each problem you plan to run, file a `DeployRequested` event (Application Admin Console UI is the supported entry point).
- [ ] Observe the deploy chain trace using [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md). Confirm `deploy.cfn.deploy.succeeded` appears within the expected window.
- [ ] Verify the resulting stack name, region, and resource list in the rehearsal team's AWS account match what the template intended.

**If it goes wrong:** Capture the failing CFn stack events into the dry-run report. If the failure is region-specific, decide before the real event whether to drop the problem or change the region.

### Step 3: participant portal flow (15 min)

- [ ] Open the participant portal URL and log in with a dummy team account.
- [ ] Confirm every deployed problem renders the expected dashboard slots.
- [ ] Submit a flag (for `flag` scoring), wait for the polling tick (uptime / phased-polling scoring), or trigger the attack (`attack-detection` scoring). Confirm the scoreboard reflects the result.

**If it goes wrong:** Mismatched scoring rendering is a signal that the `metadata.json` scoring kind does not match the template behavior. Fix the metadata, not the platform.

### Step 4: operator flow (10 min)

- [ ] Open the Application Admin Console as the organizer.
- [ ] Send one `info` and one `warning` notification.
- [ ] Confirm both appear in the participant portal within one polling tick (5 seconds, see [`docs/operations/notifications.md`](../operations/notifications.md)).
- [ ] Confirm dashboards (CloudWatch, scoreboard) update as expected.

### Step 5: teardown (15 min)

- [ ] Initiate teardown for each deployed problem via the operator UI.
- [ ] Confirm each stack reaches `DELETE_COMPLETE` and `deploy.cfn.delete.succeeded` appears in the deploy trace.
- [ ] Confirm no leftover resources (S3 buckets, ENIs, EBS volumes) remain in the rehearsal team's account. See [teardown runbook](./teardown.md) for the audit procedure.

### Step 6: write the report (5 min)

- [ ] Record every gap (broken problem, slow scoring, confusing portal copy, missing notification) in the dry-run report.
- [ ] Decide for each gap whether to fix it before the event, or accept the risk and explain why.

## If it goes wrong (overall)

| Symptom | First response | Escalation |
|---|---|---|
| Multiple problems fail to deploy | The dry run is signaling that the production deploy will too. Stop here and triage with [incident response](./incident-response.md). | Postpone the event if you cannot resolve every failed problem before T-1. |
| Scoring kind does not match what participants will see | Update the problem `metadata.json` and re-run the dry run for that problem only. | If you cannot fix it before T-1, drop the problem from the event catalog. |
| Teardown leaves orphaned resources | Document the resource type and the manual cleanup path in the [teardown runbook](./teardown.md). | If the orphaned resources cost money, escalate the cleanup with the team account owner. |
| Notification delivery is broken | Check the EventBridge bus ARN wiring per [ADR-014](../architecture/adr-014-eventbridge-driven-state-reconciliation.html). | If you cannot fix it before T-1, the event must run without notifications; brief the facilitator. |

## Related runbooks and ADRs

- Previous: [pre-event checklist](./pre-event-checklist.md) (T-7 gate).
- Next: [participant onboarding](./participant-onboarding.md), [live monitoring](./live-monitoring.md).
- During event: [incident response](./incident-response.md).
- After event: [teardown](./teardown.md).
- Background: [ADR-006: Notifications](../architecture/adr-006-notifications.html), [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html), [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md).
