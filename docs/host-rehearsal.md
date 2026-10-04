# Event rehearsal checklist

Record the platform commit and pinned catalog for each rehearsal. Use a disposable
event and synthetic participant data. Keep passwords, invitation keys, handoff
tickets, SAML responses and AWS credentials out of screenshots and reports.

## Local hosting

1. Start the reviewed checkout with `make local`. Follow its printed organizer URL,
   sign in with the organizer key, and confirm username/password/SAML paths are unavailable.
   Rotate with `make local-reset`: the old key and organizer sessions must fail,
   while scores, participant keys and runtime work remain intact.
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
   interactive `make local` displays a new key and rejects the old organizer key
   and sessions. Confirm scores, participant keys, hints, checkpoint state and
   unfinished container work survive. Resume
   must retain the owned environment rather than silently rebuilding it.
6. Verify only this event's resources are affected by stop or explicit teardown.
   Check the difference between retained work and deletion before approving a
   destructive action. Do not prune unrelated Docker networks or containers.
7. Distribute the participant portal URL and the correct team key. Rehearse key
   rotation and restart, and verify that another team's key cannot access its
   environment. If using progression gates, rehearse their failure and retry
   paths as well.

The old local AWS-region switch is rejected. A local rehearsal must not create AWS
resources. Existing AWS resources from an earlier integration revision need that
revision's reviewed cleanup procedure and retained ownership records.

## Cloud hosting: supported scope and capacity checks

The restored SBT-free Lite backend uses Lambda with Turso or DynamoDB and the
original Lambda/CodeBuild deployment paths. It restores generic CloudFormation
create/update/no-op/recreate, flag/multi-flag and scheduled endpoint scoring,
participant Console/CLI access and native coordination. Docker/Compose stays local.
Both providers admit 99 teams; SQL state policy is 4 MiB. Nine current templates
exceed the 51,200-byte TemplateBody limit and TemplateURL is not implemented.
These implementation boundaries are not hosted event-capacity measurements.

Before a live rehearsal, obtain approval for the target account, region, initial
IAM setup, temporary exercise resources, expected charges and cleanup. Reuse the
existing standard `CDKToolkit` unchanged. Review its trust and execution policies,
the caller's permissions, and CDK's application IAM changes. A missing standard
toolkit is bootstrapped automatically by ordinary `make deploy` after the target
and permission scope are displayed; its default CloudFormation
execution role uses `AdministratorAccess`. Existing custom TenkaCloud toolkits
remain untouched. See [deployment permission boundaries](../infrastructure/BOOTSTRAP-IAM.md).

The cloud rehearsal must cover:

- Organizer sign-in and roles, event/team creation, key rotation and revocation
- 100 participants in 25 teams, including concurrent requests, retries and scoring
  without lost or duplicate awards; local database timing is not an AWS benchmark
- AWS problems in the reviewed competitor-account isolation model, mandatory
  ExternalId and least-privilege participant access; already-issued AWS sessions
  may remain valid after event end
- Native Cryptography Battle with score stealing disabled and no competitor account:
  shared state, private team views, scoring and measured refresh/operation capacity;
  enabling score stealing keeps the AWS variant and requires a competitor account
- Save an event under catalog A, deploy B or remove its problem, then confirm A's
  instructions, hints, plugin, scoring, deployment and cleanup still use its saved
  catalog and archive version. Verify unpinned legacy records fail until their
  actual original snapshot is recovered; do not assign the current catalog. For the
  first original-Lite upgrade, complete competitions on the installed version and
  verify the no-active-events guard; a legacy key alone is not a safe upgrade proof
- Verify hosting-account AWS targets fail before resource mutation; multiple teams
  in one separate competitor account may use different regions, but still require
  review of global IAM and the catalog audit's unresolved findings
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

## Restored deployment and removal contract

The reference is repository commit `825415fc` and its actual CLI/CDK source.
This comparison is an offline regression record, not evidence of a live AWS run.

| Behavior | Restored contract and verification boundary |
| --- | --- |
| Providers and data | Original Turso or DynamoDB repositories; no DynamoDB resources in Turso mode. Both admit 99 teams; SQL coordination policy is 4 MiB |
| Persistent resource identity | Both-provider synth checks compare original Lite data/Cognito identities; initial adoption verifies live tags/template/schema and requires confirmation that all competitions are complete before mutation. Generic --yes is insufficient; noninteractive upgrades require --confirm-no-active-events after operator verification |
| Installation selection | New installs retain Lite physical names; existing Lite/cloud pairs are discovered. Both present requires explicit TENKACLOUD_STACK_LAYOUT=lite or cloud. Published cloud-v1 update is refused |
| Deployment | Standard CDK bootstrap when missing; EventBridge → Step Functions → Lambda/CodeBuild paths retained. Private snapshots preserve saved catalogKey and exact source ZIP key/VersionId across updates. No live AWS build/deployment is implied |
| Ordinary destroy | Owned application then backend; deployed Delete/Retain policy, no Outputs/DB requirement, failed/partial-stack recovery and versioned S3 cleanup |
| Explicit purge | Exact CloudFormation-owned data identities and supported deployed Turso rows; protected tables stop purge, source bucket/CDKToolkit/competitor bootstrap excluded |
| Turso preflight | Existing SSM SecureString, read-only authenticated connection/schema check before mutation; no secret printing or automatic migration |
| Competition cleanup | Event Teardown before platform removal. --drain-events is rejected; cloud-v1 drain requires its matching release |
| Participant access | Restored team/event/deployment checks and Console/CLI paths. Hosting-account AWS targets fail before resource mutation and participant STS denies that account; live federation remains unverified |
| Native coordination | Original selected-provider state/scoring and shared reducer. [Local official libSQL protocol check](../infrastructure/test/cloud-hosting/evidence/libsql-restored-20261003.json) passed with 25 teams/100 reads (p95 186 ms); it does not establish hosted Battle capacity |

Already-deployed deletion protection is live configuration: pulling this source
cannot remove it. Save `make destroy CLOUD_ARGS="--plan"` output and review the
exact owned table before any separately authorized protection change. Rerun the
plan to confirm the setting before purge. Shared CDKToolkit and competitor
bootstrap stacks remain outside the platform's deletion scope.

Deleting a pool with a deployed Delete policy removes its organizer accounts.
Inspect the deployed removal policy before confirming destruction; neither pulling
source nor changing a local environment file changes live retention settings.
