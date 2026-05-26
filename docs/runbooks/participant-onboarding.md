# Participant onboarding

> Japanese: [participant-onboarding.ja.md](./participant-onboarding.ja.md)

| Attribute | Value |
|---|---|
| Audience | Facilitator (the person who greets participants and runs the kickoff) |
| When to use | Event-day morning, just before the announced start time |
| Estimated time | 20 minutes of facilitator preparation; participants spend 5 to 10 minutes during kickoff |
| Output | Every team has logged in, knows where to ask questions, and understands what they will see on the participant portal |

The onboarding step exists because participants who cannot log in or do not know where to ask a question will stall the entire event. The fix is to deliver three artifacts before the event starts: login keys, a one-page kickoff briefing, and a clearly named support channel.

## Three artifacts to deliver

| # | Artifact | Channel | Owner |
|---|---|---|---|
| 1 | Login key (Cognito-only) or SSO link (federated) | Decided on [T-7 of the pre-event checklist](./pre-event-checklist.md#authentication-and-access) | Facilitator |
| 2 | Kickoff briefing slides (3 to 5 slides) | Shown on the main screen at kickoff and posted in the support channel | Facilitator |
| 3 | Support channel link | Shared in the kickoff briefing and pinned in any chat tool | Facilitator |

## Step-by-step

### Step 1: distribute login keys or SSO links (10 min)

- [ ] Verify the participant portal URL (`make lite-portal-url` or the SaaS CloudFront URL) renders the login screen.
- [ ] For each team, send the login key or SSO link through the agreed channel (email, Slack DM, printed card). Include the participant portal URL alongside the key, so participants do not have to hunt for it.
- [ ] Ask each team to confirm receipt before the kickoff. If a team has not confirmed by T-15 minutes, message them directly.

> **Reminder:** Login keys are sensitive; never post them in a shared channel. Use 1:1 DMs or per-team email aliases.

### Step 2: prepare the kickoff briefing (5 min)

Slide outline (3 to 5 slides):

1. **Welcome and event identity.** Event name, hosted by, sponsors if any. Reinforce that this is a cloud drill, not just a CTF.
2. **What participants will see.** Screenshot of the participant portal scoreboard plus the team-view dashboard. Point at where flags / endpoints / scores live.
3. **How to ask questions.** Link to the support channel and how to escalate. Set the expectation that the operator answers in minutes, not seconds.
4. **Scoring rules and time window.** Event start, event end, and a one-sentence summary of each problem. Refer participants to the per-problem README for detail.
5. **Code of conduct and AWS limits.** Reinforce that participants must not touch resources outside the problem template; AWS bills nothing for the platform but per-team CFn stacks have real costs.

### Step 3: open the kickoff (5 min)

- [ ] At T-5 minutes, post the kickoff briefing to the support channel as a permanent reference.
- [ ] At T-0, walk through the kickoff briefing live (or send a recorded version).
- [ ] Confirm at least one participant per team has successfully logged into the participant portal before announcing the official start.

### Step 4: hand off to live monitoring

Once kickoff is done, transition to [live monitoring](./live-monitoring.md). The facilitator may stay engaged on the support channel, but the operator now owns the platform side.

## Question routing

Define who answers what before participants ask.

| Question type | Routing | Example |
|---|---|---|
| "How do I log in" | Facilitator (= onboarding artifact issue) | Wrong login key, wrong URL |
| "My endpoint is down" | On-call operator via [live monitoring](./live-monitoring.md) | Stack rolled back; see [incident response](./incident-response.md) |
| "My flag was rejected" | Problem author or facilitator (= scoring config) | Flag format mismatch; check the problem README |
| "Can I use service X" | Facilitator (= code of conduct) | Out-of-scope AWS service request |
| "Is the platform broken" | On-call operator | Triage with [incident response](./incident-response.md) |

Post this table in the support channel before kickoff so participants self-route.

## If it goes wrong

| Symptom | First response | Escalation |
|---|---|---|
| A team never received their login key | Check the channel, then resend the key 1:1; verify the participant portal URL was included | If multiple teams missed it, hold the start and review the distribution channel |
| Participant logs in but sees an empty portal | Confirm the team metadata (tenantId, teamSlug) is wired and at least one problem is deployed for that team | If empty for everyone, treat as a platform incident — go to [incident response](./incident-response.md) |
| Participant asks a question outside the support channel (DM, hallway) | Politely redirect to the support channel so the answer is logged | If pattern repeats, re-pin the support channel link |
| Facilitator role is unclear during kickoff | Decide before kickoff: one MC, one operator. Do not multitask the two roles during the event | If you must, prepare a second facilitator for the next event |

## Related runbooks and ADRs

- Previous: [pre-event checklist](./pre-event-checklist.md), [dry run](./dry-run.md).
- Next: [live monitoring](./live-monitoring.md).
- Background: [ADR-006: Notifications](../architecture/adr-006-notifications.html) — operator-to-participant notification semantics.
