# Receive a team environment from an invitation

[日本語](participant-self-registration.md) · [Event operations](event-runbook.md)

One team representative opens a time-limited invitation and reserves one environment from a host-prepared pool. Reloading or retrying in the same browser resumes that reservation. This replaces individual login-key distribution; it does not create AWS accounts.

## Host preparation

1. Create the event and teams through the existing workflow. Assign a distinct AWS account to each team, verify competitor roles and their required ExternalId.
2. Add problems and bulk-deploy to the selected teams. Registration may open during deployment, but credentials are released only after all required problems complete. Deploy both Preparation and Battle when using a progression Gate.
   With DynamoDB, complete the capacity preparation below before sharing invitations. For large sessions, finish deployment first to reduce concurrent preparation polling.
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

## Registration capacity: 99 slots does not mean 99 simultaneous claims

99 is the pool size limit. **DynamoDB's default 1 RCU / 1 WCU is not sized for 99 simultaneous claims.** Receipts are stored in the existing Events item, which grows with allocations. Partial updates consume capacity for the whole item; failed conditional updates also consume capacity. See [AWS capacity calculations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).

1. Check the storage backend. Turso does not need the DynamoDB settings below, but its plan limits and request usage still apply. **Changing backends does not migrate existing data.**
2. Before opening DynamoDB registration, ask a TenantAdmin to use **Advanced operations → DynamoDB capacity → Change capacity → target table Events**, or the [existing capacity runbook](dynamodb-event-capacity.md), to raise Events and its GSI temporarily. For a 99-slot event, start capacity planning at **200 RCU / 200 WCU**, then check item size, contention and other active events. This is the existing manual ceiling, not automatic scaling. With one GSI, the billed total is 400 RCU / 400 WCU; increasing capacity costs money.
3. Even 200 does not guarantee 99 simultaneous successes. Complete deployment and invite representatives in small groups, initially no more than two teams per second. For example, with a 32 KiB event item, two successful updates per second consume 64 WCU; one conditional retry per claim raises that to 128 WCU. Larger items or other active events require slower admission. Five-second preparation polling also consumes read capacity.
4. Check actual provisioned/consumed capacity and throttles in the panel. Wait for scaling to finish and resolve throttling before continuing invitations. Receipts survive errors; participants retry from the same page. Do not rely on burst capacity.
5. After closing registration, use the same controls to **restore the capacity recorded before registration**. Coordinate with any other active events. A no-change redeployment does not undo temporary capacity increases, even if deployment defaults are 1/1.

The 99-claim regression tests allocation consistency in SQLite, not production DynamoDB throughput. For sustained simultaneous registration at scale, consider Turso, staggered admission, or a future independently keyed claim design.

## Evidence

Real SQLite repositories and production API routes exercise concurrent allocation, retries, capacity, deadlines, tenant isolation, failure recovery and credential release. DynamoDB conditional requests and generated IAM are checked separately. The browser path reservation → preparing → ready → existing team setup was exercised with explicitly simulated deployment completion; no real AWS deployment was performed.

Before an event, optionally rehearse with two teams: separate allocation, one failed preparation, team AWS permissions and cleanup.
