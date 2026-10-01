# Event rehearsal checklist

Record the platform commit and pinned catalog for each rehearsal. Use a disposable
event and synthetic participant data. Keep passwords, invitation keys, handoff
tickets, SAML responses and AWS credentials out of screenshots and reports.

## Local hosting

1. Start the reviewed checkout with `make local`. Follow its printed organizer URL,
   complete initial setup, and verify Admin, Operator and Viewer permissions.
2. Create separate teams and select the actual problems planned for the event.
   Preparing an on-demand event must leave Docker jobs stopped until a participant
   starts them. Native Battle games use the shared competition runtime.
3. Join in separate browser contexts. Check instructions, access links, a correct
   and incorrect submission, hints and scoring. One team must not reach another
   team's environment or terminal.
4. Exercise the active-environment and memory limits. Stopping preserves work and
   networks; it does not guarantee free Docker address capacity. For a larger
   catalog, configure an explicitly reviewed non-overlapping network pool as
   described in [local hosting](local-hosting.md#docker-network-address-capacity).
5. Use `make down`, then restart with the same private data directory. Confirm
   scores, hints, checkpoint state and unfinished container work survive. Resume
   must retain the owned environment rather than silently rebuilding it.
6. Verify only this event's resources are affected by stop or explicit teardown.
   Check the difference between retained work and deletion before approving a
   destructive action. Do not prune unrelated Docker networks or containers.
7. If using registration, progression gates, SAML or audit collection, rehearse
   their failure, retry, revocation and restart paths as well. Audit is off by
   default. Keep a working local password Admin when testing an external IdP.

The old local AWS-region switch is rejected. A local rehearsal must not create AWS
resources. Existing AWS resources from an earlier integration revision need that
revision's reviewed cleanup procedure and retained ownership records.

## Cloud hosting: supported scope and capacity checks

The current Lambda/DynamoDB CLI supports `make deploy`, coordinated `make destroy`,
hello-world with scoped CLI access, and native Cryptography Battle with durable
shared state and scoring. Docker/Compose exercises are local-only and are not
listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second
refresh interval; implementation and local measurements do not establish event capacity.

Before a live rehearsal, obtain approval for the target account, region, initial
IAM setup, temporary exercise resources, expected charges and cleanup. Keep the
project's toolkit separate from other CDK installations. Verify its execution
policy and ownership instead of falling back to administrator permissions.

The cloud rehearsal must cover:

- Organizer sign-in and roles, event/team creation, key rotation and revocation
- 100 participants in 25 teams, including concurrent requests, retries and scoring
  without lost or duplicate awards; local database timing is not an AWS benchmark
- AWS problems in the reviewed competitor-account isolation model, mandatory
  ExternalId and least-privilege participant access; already-issued AWS sessions
  may remain valid after event end
- Native Cryptography Battle shared state, private team views, exactly-once scoring
  and measured refresh/operation capacity; Docker/Compose exercises stay local-only
- Interrupted deployment, durable recovery, scoring locks, event end and actual
  resource teardown, with retained data and remaining charges clearly identified

No live cloud deployment or cleanup is implied by a unit test, CDK synthesis,
DynamoDB Local run, or this checklist. Those stages and a live rehearsal must be
reported separately.

## Record results

Use the exact commit, scenario, expected result, observed result and sanitized
evidence. Mark unrun scenarios explicitly. A catalog entry is not proof that a
problem is playable, and testing representative problems is not an all-catalog
runtime claim.
