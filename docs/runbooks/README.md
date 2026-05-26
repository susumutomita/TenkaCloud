# Event-day operations runbooks

> Japanese: [README.ja.md](./README.ja.md)

This directory is the operator-facing playbook for running a small TenkaCloud event end-to-end without relying on maintainer memory. Each runbook is self-contained and lists Audience, When to use, Step-by-step + estimated time, and an "If it goes wrong" branch.

The runbooks assume Lite mode (`make deploy`) as the default, because most paid hosted events are one organizer / one event. SaaS mode notes are called out inline.

## Index

| # | Runbook | Audience | When to use | Estimated time |
|---|---|---|---|---|
| 1 | [Pre-event checklist](./pre-event-checklist.md) | Facilitator | T-7 / T-1 / T-0 staged readiness | 30 min × 3 sessions |
| 2 | [Dry run](./dry-run.md) | Operator | Within 7 days before the event (mandatory) | 90 min |
| 3 | [Participant onboarding](./participant-onboarding.md) | Facilitator | Event-day morning, before kickoff | 20 min |
| 4 | [Live monitoring](./live-monitoring.md) | On-call operator | During the event window | Continuous |
| 5 | [Incident response](./incident-response.md) | On-call operator | Triggered by alarm or participant report | 5 to 30 min per incident |
| 6 | [Teardown](./teardown.md) | Operator | Within 24 hours after the event ends | 60 min |

## How the runbooks cross-link

- [Pre-event checklist](./pre-event-checklist.md) links to [Dry run](./dry-run.md) as the T-7 gate ("you cannot skip the dry run").
- [Live monitoring](./live-monitoring.md) links to [Incident response](./incident-response.md) at the triage decision point.
- [Incident response](./incident-response.md) and [Teardown](./teardown.md) both cross-link back to [Live monitoring](./live-monitoring.md) for context on what was already observed.
- All runbooks cite the relevant ADRs as the source of truth for design decisions:
  - [ADR-006: Notifications](../architecture/adr-006-notifications.html) — operator-to-participant messaging contract.
  - [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html) — how state converges without SSE / WebSocket.

## What is out of scope

- Auto-detection / auto-rollback code (tracked separately under #1352). These runbooks describe **operator action** only.
- Post-event survey / commercial follow-up templates (tracked under the broader launch-readiness epic #1336).

## Reading order for a new operator

1. [Pre-event checklist](./pre-event-checklist.md) — read it once end-to-end, then schedule the T-7 / T-1 / T-0 reminders.
2. [Dry run](./dry-run.md) — execute it at least once. The dry run is the gate, not the production event.
3. Bookmark [Live monitoring](./live-monitoring.md) and [Incident response](./incident-response.md) side by side. They are the two tabs you keep open during the event.
4. [Teardown](./teardown.md) — review the day before so you do not stall after the event ends.
