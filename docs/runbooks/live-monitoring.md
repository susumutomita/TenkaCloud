# Live monitoring

> Japanese: [live-monitoring.ja.md](./live-monitoring.ja.md)

| Attribute | Value |
|---|---|
| Audience | On-call operator (the person who keeps the platform healthy during the event) |
| When to use | Continuously from event start to event end. Pair with [incident response](./incident-response.md) at every triage decision. |
| Estimated time | Continuous; expect one focused tab on the scoreboard and one on dashboards |
| Output | An event timeline showing what was observed, what was acted on, and what was deferred to teardown |

The operator's job during the event is not to fix problems — it is to **observe quickly, classify accurately, and only then act**. Every action taken under pressure on a live platform risks making it worse. This runbook is the structure that keeps the observe-classify-act loop tight.

## Three tabs to keep open

| Tab | URL | What you watch for |
|---|---|---|
| Scoreboard | Participant portal scoreboard view | Sudden score drops, teams stuck at zero, anomalous spikes |
| Operator dashboard | Application Admin Console deploy / scoring view | Stuck deployments, scoring lag, notification delivery |
| Deploy trace | CloudWatch Logs Insights filtered by `jobId` (see [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md)) | Per-team deploy failures, CFn rollback events |

If you only have screen real estate for two tabs, drop "operator dashboard" and keep scoreboard + deploy trace. The scoreboard is the participant's experience; the deploy trace is the platform's truth.

## What "healthy" looks like

| Signal | Healthy state | Action threshold |
|---|---|---|
| Per-team scoring tick | Updating every polling interval (uptime: every minute; flag: on submission) | If a team has not advanced for 10 minutes, suspect a stuck endpoint |
| Per-team deploy status | `CREATE_COMPLETE` for every selected problem | Any team stuck in `CREATE_IN_PROGRESS` past 15 minutes is suspicious |
| Notification delivery | `info` and `warning` reach the portal within the polling tick (currently 5 seconds, see [`docs/operations/notifications.md`](../operations/notifications.md)) | If a sent notification does not appear in 30 seconds, treat as broken |
| Lambda error rate | Near zero | Any sustained non-zero rate (more than 5 errors / minute) on the deploy worker or scoring Lambda triggers triage |

## Triage decision: redeploy needed vs single-team issue

Operators frequently waste time fixing one team's symptom when the root cause affects every team. Use this decision tree.

```
Observation: a team reports their endpoint is down.
│
├── Are other teams also seeing it down?
│   ├── YES → Platform-wide issue. Open [incident response](./incident-response.md).
│   │         Do NOT redeploy individual stacks until you understand the cause.
│   │
│   └── NO  → Single-team issue. Check the team's deploy trace.
│             │
│             ├── Stack in CREATE_FAILED / ROLLBACK_COMPLETE state?
│             │   → Yes. Single-team redeploy is the right action.
│             │
│             ├── Stack in CREATE_COMPLETE but endpoint unreachable?
│             │   → Yes. Likely a team-induced misconfiguration (they
│             │     edited the resource). Tell them; do not redeploy
│             │     blind — that erases their progress.
│             │
│             └── Cannot tell?
│                 → Open [incident response](./incident-response.md).
│                   Document before acting.
```

The most common mistake is reflexive redeploy. Redeploying a team's stack erases their state. If a participant submitted a flag and the scoring already counted it, a redeploy may invalidate the work that produced the flag.

## Scoreboard watch points

Look for shapes, not absolute numbers.

| Shape | Likely interpretation | First check |
|---|---|---|
| One team flat at zero | They cannot log in or their stack failed to deploy | Confirm their login first ([participant onboarding](./participant-onboarding.md)) before assuming a platform fault |
| All teams flat for the last 5 minutes | Scoring loop is stuck | Check the scoring Lambda invocation count and error rate |
| One team's score drops backward | Uptime scoring penalty fired — check whether their endpoint went down | Their endpoint dropped; legitimate scoring behavior |
| All teams' scores drop backward simultaneously | Health check Lambda misfired or AWS region-level disruption | Open [incident response](./incident-response.md) immediately |

## Notification policy during live monitoring

Use notifications sparingly. The participant portal poll interval is 5 seconds; over-notifying creates fatigue. See [ADR-006](../architecture/adr-006-notifications.html) for the design choices.

- Send `info` when you change something the participant should know about but they do not need to react. Example: "Scoring resumed after the 14:30 maintenance pause."
- Send `warning` only when participants must take action or risk losing time. Example: "Endpoint health check paused for 5 minutes from 15:00."
- Hard limit of five `warning` messages per event. If you exceed five, you are using `warning` for items that should be `info`.

## Recording the event timeline

For every observation and action, append one line to the event timeline:

```
HH:MM | observed | scoreboard shows team-A flat for 8 minutes
HH:MM | acted    | inspected team-A deploy trace, found CFn ROLLBACK_COMPLETE
HH:MM | acted    | initiated redeploy via Application Admin Console
HH:MM | observed | team-A scoring resumed
```

This timeline is the input to the post-event review and to any incident postmortem.

## If it goes wrong

| Symptom | First response | Escalation |
|---|---|---|
| Scoreboard is frozen for everyone | Check the scoring Lambda invocation count and error rate first. Send an `info` notification within 60 seconds. | Open [incident response](./incident-response.md) under "scoring not updating". |
| You cannot tell whether it is the platform or one team | Default to platform-wide investigation. The cost of investigating a non-issue is much lower than the cost of redeploying a team blindly. | [incident response](./incident-response.md). |
| You sent the wrong `warning` notification | You cannot edit or delete a notification (see [`docs/operations/notifications.md`](../operations/notifications.md)). Send a follow-up `info` immediately to correct it. | If the wrong notification caused participants to act, document it in the event timeline and post-event report. |
| Participants flood the support channel | Pin the question routing table from [participant onboarding](./participant-onboarding.md). Triage from oldest to newest. | If volume exceeds operator capacity, send an `info` "we are investigating, expect updates every 10 minutes" and keep the cadence. |
| You are unsure whether to act | Do not act. Observe for another minute, ask the facilitator, and only then act. | [incident response](./incident-response.md) — every entry has a "1st response" branch that lets you act safely. |

## Related runbooks and ADRs

- Previous: [pre-event checklist](./pre-event-checklist.md), [dry run](./dry-run.md), [participant onboarding](./participant-onboarding.md).
- Use together with: [incident response](./incident-response.md) — open the matching incident type when you act.
- After event: [teardown](./teardown.md).
- Background: [ADR-006: Notifications](../architecture/adr-006-notifications.html), [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html), [`docs/operations/deploy-trace.md`](../operations/deploy-trace.md), [`docs/operations/notifications.md`](../operations/notifications.md).
