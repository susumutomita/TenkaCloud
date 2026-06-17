# Pre-event checklist

> Japanese: [pre-event-checklist.ja.md](./pre-event-checklist.ja.md)

| Attribute | Value |
|---|---|
| Audience | Facilitator (the person who owns event delivery end-to-end) |
| When to use | Three staged sessions before the event: T-7 days, T-1 day, T-0 morning |
| Estimated time | 30 min per セッション (90 min total across the three sessions) |
| Output | A green checklist that lets you start the event on time |

The checklist is split into three sessions because some items (budget alarm provisioning, IdP wiring) need lead time, while others (URL distribution) only make sense the morning of.

> **Hard gate:** Before the event runs in production, you must have completed the [dry run](./dry-run.md) within the previous 7 days. The T-7 checklist row "Dry run scheduled" enforces this.

## T-7 days: foundations

### AWS environment readiness

- [ ] AWS account chosen for the event has at least one IAM admin user available to the operator on call.
- [ ] `infrastructure/environments/<env>/.env` exists and `make env-check-lite` (Lite mode) or `make env-check` (SaaS mode) returns no error.
- [ ] Billing alarm is configured for the event AWS account with a threshold appropriate for the planned problem catalog (a single Lite-mode event typically stays under the AWS Free Tier 25 RCU/WCU window enforced by the `DynamoDbLowCapacity` aspect, but per-team CFn stacks add cost).
- [ ] Source bundle bucket exists (`make deploy` creates it automatically; to pre-create it, run `bash scripts/prepare-source-bundle.sh`).

### Deploy mode decision

- [ ] Choose Lite vs SaaS mode. Default to Lite unless you must run more than one tenant. See [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) for the comparison.
- [ ] Document the choice in the event run sheet so on-call operators do not guess at midnight.

### Problem catalog selection

- [ ] Pick 1 to 5 problems from [`problems/CATALOG.md`](../../problems/CATALOG.md). Validate each with `bun run scripts/tenkacloud-problem.ts validate <id>`.
- [ ] Sanity-check the scoring kind mix (one `flag`, one `uptime-multi`, etc.). Avoid running 3 simultaneous `phased-polling` problems on your first event.
- [ ] Confirm the problem catalog version (`problems/` submodule SHA) is pinned in the event run sheet.

### Team and participant list

- [ ] Final team list (team name, expected member count, contact email) is collected and reviewed.
- [ ] Decide whether each team brings their own AWS account or rents one from the organizer. Brought-by-team requires the team to roll out `infrastructure/templates/competitor-bootstrap.yaml` in advance.
- [ ] Participant list is captured in the event run sheet.

### Authentication and access

- [ ] If using federated SSO for the Application Admin Console, the IdP wiring is done. See [`docs/operations/application-plane-saml-setup.md`](../operations/application-plane-saml-setup.md).
- [ ] If using Cognito-only, the participant login key distribution channel (email, Slack DM, printed card) is decided.

### Communication channels

- [ ] Primary participant support channel (Slack workspace, Discord, in-room MC) is provisioned.
- [ ] Secondary escalation channel (operator phone, on-call rotation) is documented.
- [ ] Status notification template drafted for [ADR-006: Notifications](../architecture/adr-006-notifications.html) `info` and `warning` severities (no more than five `warning` per event — see the ADR for the rationale).

### Dry run scheduled (hard gate)

- [ ] [Dry run](./dry-run.md) date is fixed and on the calendar within the next 7 days, with a real test of the same problem catalog you will use at the event.

### backup and restore posture

- [ ] [backup and restore posture](./backup-restore.md) has been reviewed against the event type.
- [ ] Paid events explicitly accept the current "retained DynamoDB tables, no PITR" posture, or are blocked on a user-owned infrastructure proposal before payment/sign-off.
- [ ] Event run sheet records the Git commit, problem catalog SHA, deploy mode, region, tenant ID, event ID, team list, and fallback media location.

## T-1 day: final wiring

### Deploy verification

- [ ] `make harness` and `make before-commit` return green on the branch that pins the event-day configuration.
- [ ] `make deploy` (Lite) or `make deploy-saas` (SaaS) has been re-run within the last 24 hours against the event environment; `make lite-status` or the SaaS install logs show every stack is `CREATE_COMPLETE` / `UPDATE_COMPLETE`.
- [ ] `make ops-health` returns no warning (no orphan Lambdas, no stuck deployments in DDB).

### Per-team setup

- [ ] Per-team AWS account IDs and the ExternalId for each team are populated in the tenant metadata. Without the ExternalId the AssumeRole into the team account will refuse (this is a hard invariant, not a soft check).
- [ ] Participant portal URL (`make lite-portal-url` or the SaaS CloudFront URL) is verified to load and shows the login screen.

### Notification dry run

- [ ] Send one `info` and one `warning` notification through the Application Admin Console and confirm the participant portal renders both within one polling tick (currently 5 seconds, see [`docs/operations/notifications.md`](../operations/notifications.md)).

### Demo data and fallback

- [ ] Pre-recorded fallback screenshots / videos exist for each selected problem in case live AWS becomes unstable.
- [ ] Sample participant login key is verified to work end-to-end.

### Sign-off

- [ ] Facilitator signs off the T-1 checklist in the event run sheet. If a row is red, decide explicitly: fix it tonight or accept the risk in writing.
- [ ] backup/restore sign-off is still accurate after final deploy. If the selected problems or team/account list changed, update the run sheet before kickoff.

## T-0 morning: event-day kickoff

Start 60 to 90 minutes before the announced event start.

### Final platform check

- [ ] Re-run `make ops-health` and confirm zero anomalies.
- [ ] Confirm the participant portal URL still loads (rare DNS / CloudFront propagation issues catch you here).
- [ ] Confirm CloudWatch dashboards for the event environment are open and visible to the on-call operator.

### Participant distribution

- [ ] Distribute participant login keys (or SSO links) using the channel decided on T-7. See [participant onboarding](./participant-onboarding.md) for the talking points.
- [ ] Post the kickoff announcement template to the support channel.
- [ ] Confirm at least one participant per team has successfully logged in before the official start time.

### Operator handoff

- [ ] On-call operator is online and has read [live monitoring](./live-monitoring.md) and [incident response](./incident-response.md).
- [ ] Both pages bookmarked in the operator browser.
- [ ] Phone is unmuted, escalation channel is open.

### Go / no-go decision

- [ ] If three or more participants cannot log in, hold the start and triage with [incident response](./incident-response.md) before announcing the start.
- [ ] Otherwise announce the start and switch to [live monitoring](./live-monitoring.md).

## If it goes wrong

| Symptom | First response | Escalation |
|---|---|---|
| Dry run was skipped because of time pressure | Cancel or postpone the event. There is no safe way to recover from a missed dry run in production. | Inform commercial stakeholders early; better to reschedule than to fail in front of paying participants. |
| `make ops-health` reports anomalies at T-1 | Open [incident response](./incident-response.md), classify the anomaly, and fix the root cause; do not run with known anomalies. | If the anomaly is a stuck deployment, see the "deploy stuck" branch of [incident response](./incident-response.md). |
| Participant cannot log in at T-0 | Check the login key, the participant portal URL, and Cognito status; usually the login key was copy-pasted with a trailing space. | See "participant cannot log in" in [incident response](./incident-response.md). |
| AWS budget alarm fired before the event started | Do not start the event until you understand the cause; a runaway Lambda from a previous dry run is the usual suspect. | If you cannot identify it within 30 minutes, switch to a clean event environment or reschedule. |

## Related runbooks and ADRs

- Next: [dry run](./dry-run.md) — execute it within 7 days of the event.
- During event: [live monitoring](./live-monitoring.md), [incident response](./incident-response.md).
- Recovery posture: [backup and restore posture](./backup-restore.md).
- After event: [teardown](./teardown.md).
- Background: [ADR-006: Notifications](../architecture/adr-006-notifications.html), [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html).
