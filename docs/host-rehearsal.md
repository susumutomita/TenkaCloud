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
   scores, hints, checkpoint state and unfinished container work survive. Resume
   must retain the owned environment rather than silently rebuilding it.
6. Verify only this event's resources are affected by stop or explicit teardown.
   Check the difference between retained work and deletion before approving a
   destructive action. Do not prune unrelated Docker networks or containers.
7. If using registration, progression gates or audit collection, rehearse their
   failure, retry, revocation and restart paths as well. Audit is off by default.
   Key-authenticated organizer actions use an explicit host-key audit actor.

The old local AWS-region switch is rejected. A local rehearsal must not create AWS
resources. Existing AWS resources from an earlier integration revision need that
revision's reviewed cleanup procedure and retained ownership records.

## Cloud hosting: supported scope and capacity checks

The current Lambda CLI with Turso or DynamoDB supports `make deploy`, platform `make destroy`, explicit `make destroy-all`,
hello-world with scoped CLI access, and native Cryptography Battle with durable
shared state and scoring. Docker/Compose exercises are local-only and are not
listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second
refresh interval; implementation and local measurements do not establish event capacity.

Before a live rehearsal, obtain approval for the target account, region, initial
IAM setup, temporary exercise resources, expected charges and cleanup. Reuse the
existing standard `CDKToolkit` unchanged. Review its trust and execution policies,
the caller's permissions, and CDK's application IAM changes. A missing standard
toolkit is bootstrapped only after confirmation; its default CloudFormation
execution role uses `AdministratorAccess`. Existing custom TenkaCloud toolkits
remain untouched. See [deployment permission boundaries](../infrastructure/BOOTSTRAP-IAM.md).

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

## Restored deployment and removal contract

The reference is repository commit `825415fc` and its actual CLI/CDK source.
This comparison is an offline regression record, not evidence of a live AWS run.

| Behavior | Original implementation | Current regression coverage |
| --- | --- | --- |
| Provider selection | `CDK_PARAM_CONTROL_DATA_BACKEND`, Turso URL and SSM parameter | `backend-config.test.ts`, `stacks.test.ts`, `launcher.test.ts`: selected provider, no DynamoDB resources in Turso mode |
| Default table removal | `resolve.ts`, `data-table-removal-policy.ts`: explicit true alone retains data | `stacks.test.ts`: default Delete/no protection, explicit Retain |
| Managed logs and buckets | `define-nodejs-function.ts` / `deployment-log-group.ts`: Delete; owned asset buckets use auto-deletion | `stacks.test.ts`: explicit log and bucket removal policies, objects and versions |
| Cognito | Lite `IdentityProvider` omitted removalPolicy and did not apply the full/SaaS DestroyPolicySetter, despite the old destroy prompt promising UserPool deletion | Current explicit Delete aligns the implementation with the documented cleanup command; this is a behavior correction, not byte-identical restoration |
| Ordinary destroy | `cmdDown`: platform stacks, application then backend | `cli.test.ts`: no Outputs/DB requirement, failed or partial creation and retry |
| Explicit purge | `lite-complete-teardown.ts`: captured physical table/log identities | `complete-teardown.test.ts`: exact ownership, old parser oracle, protected-table refusal; the same log identities are also removed after stack deletion to handle provider logs recreated during cleanup |
| Turso deploy preflight | `turso-deploy-preflight.ts`: stored SecureString and authenticated SQL check before deployment | `turso-preflight.test.ts`, `cli.test.ts`, `sql-runtime.test.ts`: selected identity/region, no schema writes, failure stops bootstrap/build, secret redaction |
| Turso cleanup | `lite-turso-teardown.ts`: normal destroy preserves external rows; explicit purge resets before AWS teardown | `turso-teardown.test.ts`: deployed target, failure abort, schema preserved |
| Competition resources | Separate from ordinary platform destroy | `cli.test.ts`: event Teardown or explicit `--drain-events`; no automatic extra scope |
| SQL event and Battle capacity | `event-handler/create.ts` admits up to 99 teams; `coordination-budget.ts` defines a 4 MiB SQL state policy | `native-capacity.test.ts`: 99-team creation/selection, near-limit state, score/receipt atomicity and rollback; DynamoDB's current 48-team admission remains a separate unresolved difference |
| Battle reset and retained runs | `coordination-reset.ts`, `coordination-run.ts`: explicit fresh run, current plus two previous runs, closed permanent pointer after removal | `native-api.test.ts`, `native-coordination.test.ts`, `sql-native-run-history.test.ts`: fresh secret, stale-run rejection, score preservation and interrupted retirement recovery |
| Explicit event removal | `bulk-delete.ts`, shared `coordination-run.ts`: remove private run payloads after accepted teardown; retain closed pointer and score audit | `native-api.test.ts`, `native-coordination.test.ts`, `sql-native-purge.test.ts`: bounded retry, corrupted-ownership refusal, stale writers, retained totals and interrupted UI retry; End Event and ordinary platform drain do not start this purge |

Already-deployed deletion protection is live configuration: pulling this source
cannot remove it. Save `make destroy CLOUD_ARGS="--plan"` output and review the
exact owned table before any separately authorized protection change. Rerun the
plan to confirm the setting before purge. Shared CDKToolkit and competitor
bootstrap stacks remain outside the platform's deletion scope.

The Cognito distinction is based on `bin/tenkacloud-lite.ts`,
`app-wiring/wire/aspects.ts`, `tenant-template/identity-provider.ts` and the old
`confirmTeardown` text. The old Lite/identity tests checked pool creation and
sign-in properties, but did not pin pool removal policy. Do not infer Lite's
removal policy from the separate full/SaaS wiring. Current synth tests explicitly
check Delete; deleting a deployed pool also permanently removes its organizer
accounts and still requires the operator's destructive-action confirmation.
