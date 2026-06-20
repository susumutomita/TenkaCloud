# Raycast Extension Concept for TenkaCloud Event Operations

This concept keeps the first Raycast collaboration concrete without committing to implementation. The first version should help an event operator inspect TenkaCloud state quickly, then add write actions only after the read-only flow is proven useful.

## User Story

As a TenkaCloud event operator, I want frequent event operations available from Raycast so I can run a GameDay or security exercise without switching constantly between the web console, CLI, Slack, and dashboards.

## MVP Command List

Start with read-only and low-risk commands.

| Command | Phase | Purpose |
| --- | --- | --- |
| List active events | MVP | Show `READY`, `DEPLOYING`, and recent `DRAFT` events. |
| Open event dashboard | MVP | Jump from Raycast to the application admin console event page. |
| Show scoreboard | MVP | Show ranking and cumulative score trends from event detail data. |
| List teams | MVP | Show team IDs, display names, and assigned AWS account IDs. |
| Show team status | MVP | Show each team's deployment status by problem. |
| Show recent audit logs | MVP | Show latest tenant audit rows for operator context. |
| Show disruption catalog | MVP | Show available disruptions without firing them. |
| Send announcement or hint | Later action | Use the existing event notification endpoint. |
| Deploy challenge | Later action | Trigger event deploy for selected teams or problems. |
| Inject failure or incident | Later action | Fire a declared disruption with explicit confirmation. |
| Ask AI to summarize event state | Later experiment | Summarize read-only event, score, deployment, and audit data. |
| Recommend next operator action | Later experiment | Suggest actions from status and audit signals. |

## Endpoint Map

| Raycast command | Existing TenkaCloud surface | Permission | Notes |
| --- | --- | --- | --- |
| List active events | `GET /events` | Tenant Admin | Client filters active statuses. No new endpoint needed. |
| Open event dashboard | Application admin URL `/events/:eventId` | Tenant Admin | Requires runtime console base URL in Raycast settings. |
| Show scoreboard | `GET /events/:eventId?withScoreEvents=true` | Tenant Admin | Uses operator event detail. Participant `GET /portal/leaderboard` is not the right operator surface. |
| List teams | `GET /events/:eventId` | Tenant Admin | `teams[]` already includes IDs, display names, and AWS account IDs. |
| Show team status | `GET /events/:eventId` plus optional `GET /deployments/:jobId` | Tenant Admin | Event detail has `deploymentsByProblem`; deployment detail adds stack outputs and failure reason. |
| Show recent audit logs | `GET /admin/audit-log` | Tenant Admin | Existing tenant-scoped audit reader. Add filters only after the MVP is useful. |
| Show disruption catalog | `GET /events/:eventId/disruptions` | Tenant Admin | Read-only catalog is safe for MVP. |
| Send announcement or hint | `POST /events/:eventId/notifications` | Tenant Admin write | Existing endpoint broadcasts event notification. Team-targeted hints are missing. |
| Deploy challenge | `POST /events/:eventId/deploy` | Tenant Admin write | Body already supports `teamIds`, `problemIds`, `retryFailedOnly`, and `forceRedeploy`. |
| Inject failure or incident | `POST /events/:eventId/disruptions/fire` | Tenant Admin write | Existing endpoint needs Raycast-side confirmation and idempotency key generation. |
| Show disruption fire history | `GET /events/:eventId/disruptions/audit` | Tenant Admin | Useful after the fire command exists. |
| End or schedule event | `PATCH /events/:eventId/schedule`, `POST /events/:eventId/end` | Tenant Admin write | Later action, not MVP. |
| Lock or unlock scoring | `POST /events/:eventId/lock-scoring`, `DELETE /events/:eventId/lock-scoring` | Tenant Admin write | Later action for award/finalization flow. |

## Missing Endpoints

| Gap | Why it matters | Proposed follow-up |
| --- | --- | --- |
| Event templates | `POST /events` can create explicit events, but Raycast should not make operators type teams and problems from scratch. | Add an event-template read API or keep template presets local in the extension MVP. |
| Team-targeted hints | Existing notification API broadcasts to the event. Some operations need one team or a subset. | Add optional `targetTeamIds` to event notifications after UX review. |
| Operator event summary | AI summary has no current backend endpoint. | Start extension-side using fetched read-only data; add a backend summary endpoint only if policy or data locality requires it. |
| Next-action recommendation | No current endpoint returns recommended actions. | Start with rule-based extension recommendations, then evaluate AI summary. |
| Raycast auth bootstrap | Existing app uses Cognito Hosted UI in browser. Raycast needs a documented token flow. | Define OAuth PKCE setup for Raycast or use a personal operator token only if a future security review approves it. |
| Stable app deep links | The extension needs the application admin console base URL. | Store base URL in extension preferences or expose it through runtime config documentation. |

## Permission Model

The MVP should use the same tenant-scoped Application Admin API as the application admin console. Read-only commands require a valid Tenant Admin token today. If subroles are added later, map read-only commands to `viewer` and write commands to `editor` or `operator`.

System Admin permissions are not required for the MVP. Participant portal team login keys must not be used by the operator extension. Raycast should store only the minimum OAuth tokens needed for the operator account and should never store team login keys, AWS credentials, ExternalIds, or exported secrets.

## Destructive Action Confirmation UX

Read-only commands can run immediately. Write actions must show a Raycast confirmation dialog before sending an API request.

| Action | Confirmation requirement |
| --- | --- |
| Send notification | Preview title, body, severity, and target scope. Confirm once. |
| Deploy or redeploy | Show event name, selected teams, selected problems, and whether `forceRedeploy` is enabled. Require typed event name when force redeploy is enabled. |
| Fire disruption | Show disruption name, problem, scope, affected teams, timing, and parameters. Require typed event name for `all` or `random-n` scope. |
| End event | Show current status and end time. Require typed event name. |
| Lock or unlock scoring | Show whether scoring will stop or resume. Confirm once. |
| Bulk teardown or archive | Keep out of the MVP. If added later, require typed event name and a second irreversible-action confirmation. |

Every write command should generate an idempotency key when the backend supports one, display the resulting audit ID when available, and offer a link back to the event dashboard.

## AI Summary Decision

The MVP should not send event data to a third-party AI provider by default. If the Raycast extension experiments with AI summary, it should start as an explicit opt-in command that summarizes only data the operator has already fetched. A backend summary endpoint can come later if TenkaCloud needs centralized policy, auditability, or provider control.

## Rough Raycast Extension README Draft

```md
# TenkaCloud Operator

Raycast commands for running TenkaCloud cloud and security exercises.

## MVP Commands

- List Active Events
- Open Event Dashboard
- Show Scoreboard
- List Teams
- Show Team Status
- Show Recent Audit Logs
- Show Disruption Catalog

## Setup

1. Set the Application Admin API base URL.
2. Set the Application Admin Console base URL.
3. Sign in with the TenkaCloud Tenant Admin account.
4. Select a default event when running a command.

## Safety

The MVP is read-only. Write commands such as deploy, notification, and disruption fire are disabled until the operator action design is approved.

## Later Commands

- Send Announcement or Hint
- Deploy Challenge
- Fire Disruption
- Summarize Event State with AI
- Recommend Next Operator Action
```

## Follow-Up Issues To Create After Design Approval

These should be opened only after this design is accepted.

| Issue title | Scope |
| --- | --- |
| `feat(raycast): scaffold TenkaCloud operator extension` | Create extension shell, preferences, auth placeholder, and read-only command structure. |
| `feat(raycast): add read-only event operations commands` | Implement list events, open dashboard, scoreboard, teams, team status, audit logs, and disruption catalog. |
| `feat(raycast): design operator write-action confirmations` | Implement reusable confirmation UX for notifications, deploy, and disruption fire without enabling hidden destructive shortcuts. |
| `feat(api): support team-targeted event notifications` | Extend event notifications only if the Raycast hint workflow needs team targeting. |
| `feat(raycast): add opt-in AI event summary` | Add explicit opt-in AI summary after privacy and provider policy are reviewed. |
