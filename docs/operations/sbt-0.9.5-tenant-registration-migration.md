# SBT 0.9.5 tenant-registration migration runbook

This is a one-time SaaS Control Plane migration. It changes lifecycle event
names, adds the TenantRegistration table, and changes the System Admin API from
direct tenant mutation to tenant-registration orchestration. Do not run it
during an event or while System Admins can create or delete tenants.

Lite deployments do not use this SBT Control Plane migration.

## Stop conditions

Stop before any write or deploy if any of these is true:

- the target account, region, or `Environment` tag is uncertain;
- a tenant provisioning or deprovisioning execution is still running;
- the synthesized TenantDetails logical ID is not
  `ControlPlanetenantManagementServicvestenantManagementTableTenantDetails974E95B8`;
- CloudFormation proposes replacing or deleting TenantDetails;
- the inventory reports a missing status/activity field, orphan, reverse-link
  collision, duplicate link, or stale row;
- an unexpected lifecycle request arrives during the maintenance window.

## 1. Freeze one immutable deployment assembly

Build the SPAs, synthesize once, and retain the exact `cdk.out/manifest.json` and
templates used for every stage. Do not rebase, pull, install a different lock
file, or re-synthesize between stacks.

Run a live `cdk diff` against the target. The expected stateful result is:

- existing TenantDetails: **NO-OP** properties and the historical logical ID;
- TenantRegistration: **CREATE**, PROVISIONED 1/1, PITR enabled;
- tenant-management Lambda/role/log group: stateless **REPLACE**;
- old activate/deactivate routes: **DELETE**;
- lifecycle rules, state machines, audit Lambda/rule, and Admin Console:
  **UPDATE/REPLACE** as documented in the PR physical-impact section.

Export or preserve any tenant-management Lambda logs needed for audit before the
Control Plane update. SBT corrected its construct path, so CloudFormation
deletes the old explicit Lambda LogGroup and creates a new one. Historical log
events in the deleted group are not migrated.

## 2. Enter maintenance and capture unexpected events

Announce a maintenance window and require every System Admin to stop tenant
create, update, activate, deactivate, and delete operations. This is an
operational quiesce, not an application-enforced lock, so verify the API/audit
stream is quiet before continuing.

Create a short-retention EventBridge archive on the existing SBT event bus for
both old and new request names:

```bash
aws events create-archive \
  --archive-name <unique-sbt-095-migration-archive> \
  --event-source-arn <SbtEventBusArn> \
  --event-pattern '{"source":["sbt.control.plane"],"detail-type":["onboardingRequest","offboardingRequest","sbt_aws_onboardingRequest","sbt_aws_offboardingRequest"]}' \
  --retention-days 3
```

The archive is a loss detector and forensic copy. Do not blindly replay it:
replaying an already-consumed onboarding request can provision twice. If its
`EventCount` becomes non-zero after quiesce, stop the rollout, identify whether
the old or new consumer handled each request, and reconcile that registration
before resuming.

## 3. Drain lifecycle work

Resolve the provisioning and deprovisioning state-machine ARNs from the
`tenkacloud-bootstrap` stack resources. For both state machines, require
`list-executions --status-filter RUNNING` to return no executions. A RUN_JOB
execution also covers its CodeBuild child, so do not continue merely because
CodeBuild has stopped producing logs.

Do not abort an execution to shorten the window. Let it reach success/failure,
then confirm the corresponding old lifecycle event and tenant state before
deploying the event-name change.

## 4. Deploy from the saved manifest in order

Deploy with concurrency one and `--exclusively`, using the same saved cloud
assembly throughout:

1. `tenkacloud-problem-deploy` — accept the six new `sbt_aws_*` audit events.
2. `tenkacloud-bootstrap` — install the new request consumers and formal
   Provisioning/Deprovisioning ScriptJob payloads.
3. `tenkacloud-control-plane` — create TenantRegistration and switch the API and
   event producer.
4. Keep `tenkacloud-admin-console-hosting` unchanged until backfill and
   lifecycle verification finish.

There is no zero-loss mixed-version ordering: old and new request detail types
do not match. Quiescing, draining, saving one manifest, serial deployment, and
the temporary archive together close that window. Do not use the normal
`deploy --all --concurrency 4` path for this one-time migration.

After each stack, inspect CloudFormation events before starting the next. On
failure before the Control Plane producer update starts, keep maintenance
active and roll back the already-updated consumer stacks using the original
pre-migration assembly in reverse order; do not improvise a second synth.

After the Control Plane update has succeeded, do **not** deploy the old Control
Plane assembly as a generic rollback. The new TenantRegistration table has no
retention guarantee in the old template, so that action can delete registrations
created by the new API or backfill. Keep maintenance active, preserve the failed
stack events and table backups, and choose a forward repair or an explicitly
reviewed restore plan based on whether any new registration writes occurred.
This is a human stop gate, not an automatic rollback step.

## 5. Inventory and back up

Resolve the two exact physical table names from the deployed Control Plane.
Create an on-demand backup of TenantDetails and TenantRegistration before
`--apply`.

Run the backfill without `--apply`. All identity fields are mandatory; the CLI
calls STS, DescribeTable, and ListTagsOfResource before scanning and refuses a
wrong account, region, environment, project, table name, or partition key.

```bash
bun run scripts/ops/backfill-tenant-registrations.ts \
  --tenant-details-table=<exact-tenant-details-table-name> \
  --tenant-registration-table=<exact-tenant-registration-table-name> \
  --expected-account=<12-digit-account-id> \
  --expected-region=<aws-region> \
  --environment=<environment-tag>
```

Every legacy tenant must have a non-empty `tenantStatus` and an authoritative
boolean activity field (`sbtaws_active`, otherwise legacy `isActive`). Review
every deterministic `legacy-<tenantId>` mapping.

## 6. Resolve blockers and orphans

The dry-run is intentionally fail closed:

- a registration pointing to no tenant is an orphan;
- a tenant pointing to no registration is a broken forward link;
- a registration linked in reverse while the tenant lacks that ID is a
  collision;
- more than one registration linked to a tenant violates the one-to-one
  contract;
- missing lifecycle fields make the migration state unknowable.

Do not let the tool delete or guess around these cases. For each blocker:

1. inspect TenantDetails, TenantRegistration, the archived request events, and
   both state-machine execution histories;
2. select the one authoritative tenant-registration pair;
3. back up both raw rows;
4. repair the pair with a conditional DynamoDB transaction, or conditionally
   delete a proven orphan only after confirming it has no tenant and no running
   execution;
5. re-run dry-run until no blockers remain.

Retain the backup and an operator record of every manual cleanup. Never delete
an orphan solely because it is absent from the Admin Console.

## 7. Apply and prove idempotency

Repeat the reviewed command with `--apply`. Each planned item uses one
transaction: conditionally create the registration and conditionally link the
tenant. The tenant update also requires the scanned status and authoritative
activity value to remain unchanged, so a lifecycle change after inventory
fails instead of being overwritten.

Immediately re-run dry-run. It must report:

- `createCount: 0`;
- no blockers;
- every existing tenant in `skippedTenantIds`.

Any conditional failure means the inventory became stale. Stop, re-scan, and
review a new plan; do not retry the old plan.

## 8. Verify, release the UI, and clean up

While maintenance remains active, exercise one disposable tenant through:

1. create and successful provision;
2. paginated list, including `tenantRegistrationId` and `sbtaws_active`;
3. delete and successful deprovision;
4. a controlled provisioning failure and a controlled deprovisioning failure.

Both failure paths must persist `tenantStatus: Failed` and
`registrationStatus: Failed`. Confirm all six `sbt_aws_*` audit actions and no
stuck `In progress` rows.

Deploy `tenkacloud-admin-console-hosting` from the same saved manifest only
after those checks pass. End maintenance after a final archive count, orphan
scan, and dry-run.

Keep the temporary archive through the observation window. Delete it after
confirming no reconciliation is needed; otherwise its retained events continue
to incur EventBridge archive storage cost.
