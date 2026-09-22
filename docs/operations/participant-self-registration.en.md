# Receive a team environment from an invitation

[日本語](participant-self-registration.md) · [Event operations](event-runbook.md)

One team representative opens a time-limited invitation and reserves one environment from a host-prepared pool. Reloading or retrying in the same browser resumes that reservation. This replaces individual login-key distribution; it does not create AWS accounts.

## Host preparation

1. Create the event and teams through the existing workflow. Assign a distinct AWS account to each team, verify competitor roles and their required ExternalId.
2. Add problems and bulk-deploy to the selected teams. Registration may open during deployment, but credentials are released only after all required problems complete. Deploy both Preparation and Battle when using a progression Gate.
3. Open Event details → Teams → participant invitation settings. Choose the pool and deadline, confirm preparation, then issue the link.
4. Share it privately with one representative per team. A four-person team submits once, not four times. Anyone holding the link can reserve an available slot.
5. Close registration when finished. End the event and tear down deployments separately. **Closing registration does not delete billable resources.**

The invitation secret is shown only on issuance. Reissue if lost or exposed: the old link stops new reservations, while existing receipts continue to work until the event ends or expires. Allocated teams cannot be removed from the pool.

## Participant steps

1. Open the invitation and choose Receive a team environment.
2. Wait on the preparation screen. If preparation fails, contact the host; do not reserve another slot.
3. When ready, choose Start with this environment. Set a team name in the existing setup screen, then use the normal problem list, AWS access, Gate and scoring.

The receipt is saved in that browser. Changing devices or clearing browser data loses automatic recovery. The host checks the claimed labels in the registration pool and confirms the representative before distributing the existing key from the team list. There is no release-and-reassign action.

## Boundaries and cost

- Hosts supply the AWS accounts and deployment pool. This feature does not automatically create AWS Free Projects; eligibility, service restrictions and provisioning remain separate.
- It reuses existing participant/event APIs and Events/Teams/Deployments storage, adding no database, KMS key or always-on server. Existing requests, transfer and exercise resources may still incur charges.
- Supports AWS Lite/SaaS with DynamoDB or Turso. Switching storage does not migrate data. It does not provision simulated AWS accounts in local mode.
- Capacity is an explicit pool of up to 99 teams. This is not identity verification or one-person-one-reservation enforcement: separate browser receipts can reserve separate slots. Restrict link distribution.
- Failed preparation never returns another team's credentials. Retry deployment through the existing host workflow, then refresh the same reservation.

## Evidence

Real SQLite repositories and production API routes exercise concurrent allocation, retries, capacity, deadlines, tenant isolation, failure recovery and credential release. DynamoDB conditional requests and generated IAM are checked separately. The browser path reservation → preparing → ready → existing team setup was exercised with explicitly simulated deployment completion; no real AWS deployment was performed.

Before an event, optionally rehearse with two teams: separate allocation, one failed preparation, team AWS permissions and cleanup.
