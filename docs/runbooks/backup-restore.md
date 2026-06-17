# backup and restore posture

| Attribute | Value |
|---|---|
| Audience | Event operator, facilitator, maintainer on call |
| When to use | T-7 planning, T-1 paid-event sign-off, or when incident response finds possible data loss |
| Estimated time | 20 min for planning; 15 to 60 min for a single-layer restore decision |
| Output | A written decision: restore from the documented source of truth, recreate ephemeral state, or escalate because the current infrastructure does not provide the required RPO / RTO |

TenkaCloud's current recovery posture is **recover by redeploy and retained operational state**, not hot disaster recovery. The platform is optimized for small community demos and human-operated hosted events. DynamoDB tables are retained on stack deletion, but point-in-time recovery is currently disabled in the CDK definitions. Do not promise point-in-time table restore unless the user-owned infrastructure work has explicitly shipped.

## Recovery objectives

Use this table before promising a public demo or paid event.

| Event type | Recovery objective | Operator promise |
|---|---|---|
| Local development / demo rehearsal | Best effort. RPO is the last Git commit plus whatever local `.env` the operator still has. RTO is "same day" if AWS credentials and quotas are healthy. | Re-run deploy from source, recreate demo data, and accept loss of generated event rows. |
| Community demo / meetup | Best effort with a prepared fallback recording. RPO is the latest Git commit and problem catalog SHA recorded in the run sheet. RTO target is under 4 hours; live demo may switch to fallback media. | Do not block the community event on full platform restore. Show fallback screenshots/video if restore exceeds the event window. |
| Paid hosted event | Human-operated continuity, not hot failover. RPO target is the event run sheet plus retained DDB rows; RTO target is under 60 minutes for static assets/source bundle and under 30 minutes for one-team redeploys. | If platform DDB is corrupt or missing and there is no approved PITR/export mechanism, pause or reschedule the event instead of improvising data reconstruction. |
| Enterprise / regulated event | Not covered by the current implementation. | Open a user-owned infrastructure proposal for DynamoDB PITR/export, S3 backup policy, CloudWatch log retention/export, and tested restore rehearsal before signing. |

## Source-of-truth inventory

| Layer | Source of truth | Current backup / retention posture | Restore action | Ephemeral / N/A cases |
|---|---|---|---|---|
| Application and infrastructure source | Git repository, pinned commit, `bun.lock`, problem catalog submodule SHA | Git history and PR review. No runtime restore needed. | Check out the recorded commit and run the normal deploy flow. | Local build artifacts in `dist/` and `.cache/` are disposable. |
| Environment configuration | `infrastructure/environments/<env>/config.json` plus operator-held `.env` values | `config.json` is repository state when committed. `.env` is not committed and must live in the operator password manager or deployment notebook. | Restore `config.json` from Git. Recreate `.env` from the approved secret store; rotate values if provenance is unclear. | Never restore `.env` from chat logs, shell history, or PR attachments. |
| Control-plane tenant mapping | `TenantMappingTable` | DynamoDB `RETAIN`; PITR disabled. | If the table still exists, keep it. If rows are missing, reconstruct only from the tenant run sheet and SBT stack outputs, then verify through the admin console. | No point-in-time restore guarantee today. Missing paid-event tenant mapping is escalation, not event-day manual bulk import. |
| Event / team / deployment state | `Events`, `Teams`, `Deployments`, `ProblemEndpoints`, `CompetitorAccounts`, `SamlIdps` | DynamoDB `RETAIN`; most event/deploy rows have TTL; PITR disabled. ExternalIds are in SSM SecureString, not in `CompetitorAccounts`. | Prefer the UI/API flows that created the data. For a single failed deployment, follow incident response and redeploy that team/problem. For table-level loss, pause the event and escalate. | Scoring ticks, intermediate deployment progress, expired TTL rows, and browser-local UI state are ephemeral. Do not try to recreate exact tick history. |
| Admin audit and disruption audit | `AdminAuditLog`, `Disruptions`, CloudWatch structured logs | `AdminAuditLog` is DDB `RETAIN` with `AUDIT_RETENTION_DAYS` TTL. `Disruptions` retains recent audit rows with 7-day TTL. CloudWatch retention is environment policy. | Keep retained DDB rows as the audit source. If audit rows are missing, preserve CloudWatch logs and append an incident note to the event timeline. | Audit history is not restored into the product UI from CloudWatch during an event. Missing audit data is a post-event compliance issue. |
| Source bundle | Account-scoped S3 bucket and `source.zip` uploaded by `scripts/prepare-source-bundle.sh` | Bucket versioning is enabled; default lifecycle keeps 5 newer noncurrent versions and expires older noncurrent versions after 1 day. | Re-run `bash scripts/prepare-source-bundle.sh` from the recorded commit. Prefer re-upload over manual S3 version rollback. | Noncurrent versions beyond lifecycle are intentionally disposable. |
| Challenge payload assets | Challenge payload S3 bucket published from the problem repository | Versioned private S3 bucket with noncurrent version expiration. | Re-run the problem repository publish workflow or restore the known S3 object version if the event run sheet recorded it. | Generated payload zips older than lifecycle are not a recovery dependency. |
| SPA hosting and runtime config | CDK stacks that deploy S3 + CloudFront and generated `/runtime-config.json` | Hosting buckets hold rebuildable static assets. Runtime config is generated from stack outputs and is non-secret, but must match Cognito/API/CloudFront URLs. | Re-run the normal deploy command (`make deploy` for Lite, `make deploy-saas` for SaaS) and verify `/runtime-config.json` loads. Do not hand-edit Cognito callbacks or S3 JSON during a paid event. | Browser storage, OAuth transient state, and cached SPA assets are disposable; users can reload after redeploy. |
| Competitor problem stacks | Competitor AWS account CloudFormation stacks plus the TenkaCloud problem template | Stack state lives in the competitor account. TenkaCloud keeps deployment metadata, not a full backup of competitor resources. | For one failed stack, delete/redeploy through the supported operator flow. For many stacks or account-wide loss, pause scoring and use the event fallback plan. | Post-teardown resources are intentionally gone. Orphan cleanup belongs to teardown, not backup restore. |

## Event-day restore decision tree

1. Stop creating new mutations. Hold new deploys, bulk deletes, SAML edits, and ExternalId rotations until the affected layer is identified.
2. Record the observation in the event timeline: time, affected tenant/event/team, suspected layer, and operator.
3. Classify the layer using the inventory table above.
4. If the source of truth is Git/S3/static assets, restore by redeploying from the recorded commit and validate the URL or object.
5. If the source of truth is a single DynamoDB row that can be recreated through the UI/API, recreate it through that path and record the action.
6. If the problem is table-level DynamoDB loss, cross-tenant corruption, missing ExternalIds, or audit loss during a paid event, escalate. The current infrastructure does not provide safe event-day PITR.
7. After restore or escalation, send an `info` or `warning` notification through the normal event communication channel. If the console is unavailable, use the support channel from the event run sheet.

## Layer-specific procedures

### Static assets and runtime config

Use this when the console loads a 404, stale frontend, or invalid `/runtime-config.json`.

1. Confirm the branch and commit in the event run sheet.
2. Re-run the normal deploy:

   ```bash
   make deploy
   ```

   For SaaS mode, use the event's documented SaaS deploy command instead of Lite mode.
3. Open the console URL and fetch `/runtime-config.json` in the browser.
4. Verify the Cognito domain, client ID, API URL, and participant portal URL match stack outputs.
5. If callback/CORS values are wrong, redeploy through CDK. Do not patch Cognito or S3 manually during a paid event.

### Source bundle

Use this when CodeBuild or tenant provisioning cannot find `source.zip`, or when a stale bundle was uploaded.

1. Check out the event commit.
2. Rebuild and upload the source bundle:

   ```bash
   bash scripts/prepare-source-bundle.sh
   ```

3. Re-run the failing deploy after the upload succeeds.
4. If the bucket itself is missing, this is an infrastructure ownership boundary. Stop and ask the infrastructure owner to restore or recreate the bucket policy; do not create an undocumented bucket by hand.

### DynamoDB rows

Use this when one event, team, deployment, endpoint override, competitor account, or SAML IdP row is wrong.

1. Prefer the Application Admin Console or supported API route that owns the row.
2. For a single failed deployment, follow [incident response](./incident-response.md#section-4-cloudformation-stack-rollback) and redeploy only after the failed stack is deleted or safe to retry.
3. For missing event/team rows during a paid event, compare against the event run sheet before recreating anything. If two sources disagree, pause the event and escalate.
4. Do not scan/import whole tables during event hours. The tables are provisioned 1 RCU / 1 WCU by design, and bulk repair can create new throttling incidents.

### Audit and event logs

Use this when an operator asks "can we prove who did what?"

1. Query the Admin Audit Log UI/API first.
2. If the DDB audit row is not present, preserve CloudWatch Logs for the relevant Lambda/API path and record the gap in the event timeline.
3. Treat missing audit rows as a post-event compliance finding. Do not attempt to synthesize audit rows after the fact.
4. For paid events that require longer or immutable audit retention, open a user-owned infrastructure issue before the event. ADR-036 keeps DynamoDB + TTL as the current default; S3 Tables/archive remains a future decision.

### Environment configuration and secrets

Use this when a deploy cannot proceed because local configuration is missing.

1. Restore non-secret `config.json` from Git.
2. Restore `.env` values only from the approved operator password manager or deployment record.
3. If ExternalId or IdP material is lost, rotate/re-verify instead of guessing. ExternalIds are required for AssumeRole and are intentionally not recoverable from public docs.
4. Never commit `.env`, AWS credentials, SAML private material, or customer secrets to create a backup.

## Escalation boundaries

These are not event-day code fixes:

- Enabling DynamoDB point-in-time recovery, table exports, S3 cross-region replication, or immutable log archive.
- Changing CloudWatch log retention across stacks.
- Creating a central backup bucket or KMS policy.
- Recovering missing ExternalIds without rotating/re-verifying competitor accounts.
- Rebuilding paid-event state from ad hoc DynamoDB scans or handwritten JSON.

If a paid event requires any of the above, create a user-owned infrastructure issue or proposal and block the event gate until it is reviewed. Application agents may document the requirement and add tests around app behavior, but should not silently edit CDK/IAM/templates for backup guarantees.

## Pre-event checklist additions

Before every paid event:

- Record the exact Git commit, problem catalog SHA, deploy mode, region, tenant ID, event ID, team list, and selected problems in the event run sheet.
- Decide whether the event accepts the current "retained tables, no PITR" posture. If not, stop and create the infrastructure proposal before taking payment.
- Verify the source bundle can be rebuilt from a clean checkout.
- Verify the operator has access to the `.env` source of truth and AWS account break-glass access.
- Save fallback screenshots or videos for the chosen problems.

## Related runbooks and ADRs

- Planning: [pre-event checklist](./pre-event-checklist.md), [dry run](./dry-run.md).
- During event: [live monitoring](./live-monitoring.md), [incident response](./incident-response.md).
- After event: [teardown](./teardown.md).
- Background: [ADR-014: EventBridge-driven state reconciliation](../architecture/adr-014-eventbridge-driven-state-reconciliation.html), [ADR-036: S3 Tables audit log archive](../architecture/adr-036-s3-tables-audit-log-archive.html).
