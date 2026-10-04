# Cloud deployment permission boundaries

Current cloud hosting uses the standard AWS CDK `CDKToolkit` in the selected
account/region. It reuses a compatible existing toolkit unchanged and runs the
pinned official `cdk bootstrap` only when that stack is missing. It does not create
TenkaCloud-specific bootstrap roles, managed policies or application boundaries.

Standard bootstrap's CloudFormation execution role defaults to
`AdministratorAccess`. Its deployment roles therefore represent privileged
account access; this is not a least-privilege deployment design. Review existing
trust, execution policies and who can assume these roles. Application/runtime IAM,
competitor-account trust and participant sessions have their own narrower policies.
See [AWS bootstrap resources and caller permissions](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
and [AWS execution-policy customization](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html).

## First-account setup

Copy the selected `infrastructure/environments/{development,staging,production}/.env.example`
to `.env` in the same directory only if absent. Set the organizer email, account
and region, then run `make deploy ENV=development` with the intended AWS profile.
Use the matching environment for configuration, deployment and destruction. Never
put credentials in `.env`; see [configuration rules](README.md#current-checkouts-setup-and-teardown-boundary).

After installation/resource/schema checks and any original-installation upgrade
confirmation, the command checks `CDKToolkit`. If it exists and is compatible, it
continues without bootstrap changes. Otherwise it displays the target and standard
bootstrap authority and cost notice, runs the repository's pinned CDK CLI, verifies
the resulting toolkit, and continues with the same credentials. Ordinary deployment
uses `--require-approval never`, including in CI; new and already-restored installations
need no extra deployment confirmation. Original unpinned installations must first
pass the no-active-events upgrade guard. No policy is attached to the caller and no
profile is changed.

First bootstrap needs CloudFormation, IAM, S3, ECR and SSM permissions for the
standard toolkit resources; AWS's documented starting policy uses those service
wildcards on `*`. Account controls such as SCPs, permission boundaries and explicit
denies still apply. Review this with the account owner rather than treating a
bootstrap preview as proof that an identity is authorized. If bootstrap succeeds
and application deployment fails, the toolkit remains and is reused on retry.

The ordinary deployment caller needs access to inspect stacks/bootstrap metadata,
assume the standard publishing/lookup/deployment roles, and use the direct
Cognito invitation, source-bundle upload and teardown operations listed below. Existing
bootstrap execution policies determine what CloudFormation can deploy. A reduced
policy or older toolkit can require an administrator's separately reviewed update;
the CLI does not silently replace it or grant more permissions after a failure.

Optional commands, after configuring the selected environment:

```bash
# Inspect standard bootstrap offline; does not contact AWS.
make -s deploy ENV=development CLOUD_ARGS="--show-setup"
# Bootstrap only when missing, for organizations using a separate initial caller.
make deploy ENV=development CLOUD_ARGS="--setup"
# Ordinary deployment, using the intended deployment profile.
make deploy ENV=development
```

`--setup` asks for its own confirmation before creating a missing toolkit; it does
not update an existing toolkit or deploy the application. Setup-only automation can
use `--setup --yes`. Declining setup-only confirmation stops before IAM changes.
Ordinary `make deploy` already handles first bootstrap and deployment unattended.
Its `--yes` and `--setup-if-needed` flags remain accepted for compatibility and are
optional for new and already-restored installations. Neither bypasses the original
installation upgrade guard. All paths require the caller's existing permissions; failures are reported,
not hidden by changing credentials or permissions.

Original unpinned Lite installations require a one-time confirmation that no active competitions remain, after resource/schema checks and before bootstrap, source upload or deployment. Keep active competitions on their installed version until completion. After verifying that condition, confirm interactively or use `CLOUD_ARGS="--confirm-no-active-events"` for a noninteractive upgrade; generic `--yes` cannot bypass this check. A legacy catalog key alone does not prove a safe upgrade, and historical data is not migrated automatically. New and already-restored installations keep ordinary automatic `make deploy` behavior.

## Existing toolkits and retained resources

Both stacks use the standard CDK synthesizer and default `hnb659fds` qualifier.
The toolkit is shared across environments/applications in the same account/region;
TenkaCloud ownership or environment tags are not required on `CDKToolkit`.
Standard bootstrap compatibility is checked without rewriting trust or execution
policies. Only a confirmed CloudFormation not-found response permits creation;
access denial, failed stack state or incompatible metadata stops deployment.
Manage any required official bootstrap upgrade separately.

Earlier `TenkaCloudToolkit-*` stacks, their custom policies and assets remain
untouched. They are not migrated, deleted or used as substitutes for `CDKToolkit`.
`TENKACLOUD_CFN_EXECUTION_POLICY_ARN` from earlier revisions is unsupported; remove
it from configuration. To retain an organization-specific execution policy, review
and manage the standard toolkit through the normal AWS CDK process.

`make destroy` retains the standard toolkit and its shared CDK assets. Platform-owned
data and organizer identity use the deployed removal policies, which default to
Delete. Explicitly retained tables survive unless `make destroy-all` purges them.
After its existing deletion confirmation, ordinary destroy empties only verified
CloudFormation-owned S3 buckets with a deployed `Delete` policy. Retained bucket
contents survive unless explicit `destroy-all` empties them; `Retain` bucket
containers remain. The CLI leaves bucket-container deletion to CloudFormation.
Retention does not promise automatic reattachment on a fresh deployment.
No live AWS bootstrap, IAM change or deployment was performed by source tests.

## Deployment authority versus ordinary use

The standard CloudFormation execution role deploys the selected database resources,
Cognito, Lambda, API Gateway, S3, CloudFront, Step Functions, CodeBuild, EventBridge,
IAM, logs and SSM resources. Deployment prepares and uploads the original source
archive for CodeBuild as well as application assets. The caller needs access to the
resolved source bucket and its archive object; that bucket is outside ordinary
platform destruction. Deployers can change application code, identities, permissions
and data. Use an account boundary where separation from these administrators is needed.

Setup/deployment credentials are never placed in SPA configuration or participant
responses. Application runtime roles keep their existing service-specific policies
and do not receive `AdministratorAccess` from standard bootstrap. Existing
API Gateway account logging configuration is not rewritten.

Organizers sign in through Cognito. The original `TenantAdmin`, `TenantOperator` and
`TenantViewer` claims map to the organizer roles; the internal `tenantId=local`
remains fixed for one installation. This is not a tenant-management product.
Participants use team keys and the participant API. Cognito login does not grant
organizers deployment-role credentials.

The restored APIs and workers retain their original table/SSM/service grants.
DynamoDB transactions use their underlying IAM actions; there is no
`dynamodb:TransactWriteItems` permission. Turso mode creates no DynamoDB tables
and grants its runtime access to the exact SSM token parameter. The deployment
caller needs `ssm:GetParameter` for that parameter and authenticated database access
for read-only preflight. It does not create or rotate the token.

Competitor registration and verification require the displayed role trust and
mandatory ExternalId. Review [competitor setup](../docs/competitor-account-onboarding.md)
for individual stacks or Organizations distribution. The bootstrap role's existing
`AdministratorAccess` exception is for competitor initialization/deployment;
participant credentials come from the problem's separate participant role.
Console and CLI access retain their current event/team/deployment authorization
checks. Existing sessions can remain valid until expiry after event end or key
revocation. Teams may share a competitor account across regions, subject to each
problem's global-resource and permission constraints; this is not complete IAM
isolation. AWS resource exercises require a separate competitor account: the
platform account is rejected before resource mutation and by participant STS.
Register and verify a separate account before deployment. Same-hosting-account
exercises remain unsupported and unverified. The catalog IAM audit has unresolved
findings; restored behavior does not certify all problem policies as least privilege.

## Direct deployment and cleanup permissions

Standard bootstrap does not grant direct CLI operations to the caller. In addition
to the standard CDK deployment/publishing permissions, ordinary deployment uses
Cognito `AdminGetUser` and `AdminCreateUser` for the selected organizer pool,
source-bundle bucket/object access, and read-only stack/template inspection.

Ordinary teardown and failed-deployment recovery inspect exact owned CloudFormation
resources and empty owned S3 buckets before stack removal. The caller needs:

- `cloudformation:DescribeStacks`, `cloudformation:GetTemplate` and
  `cloudformation:ListStackResources` for the selected owned stacks
- `s3:GetBucketTagging` and `s3:ListBucketVersions` on the exact owned bucket ARNs
- `s3:DeleteObject` and `s3:DeleteObjectVersion` on objects in those buckets

CloudFormation execution-role permissions alone do not authorize these direct calls.
Cleanup requires the expected account owner and verified ownership tags, removes
object versions/delete markers, and checks emptiness. Ownership or permission
errors, malformed inventories and incomplete deletion stop stack removal. Ordinary
destroy excludes retained contents. Explicit `destroy-all` includes verified
retained contents while preserving `Retain` bucket containers. No global
`s3:ListAllMyBuckets`, bucket-policy rewrite or direct bucket-container deletion is
used to discover or force cleanup targets.

Ordinary destroy works without database access or application Outputs, including
failed/partial deployments, and honors each resource's deployed Delete/Retain policy.
DynamoDB tables default to Delete; explicit `CDK_PARAM_RETAIN_DATA_TABLES=true`
retains them. Changing `.env` alone does not change that deployed policy.
`destroy-all` captures exact owned table/log/bucket identities and explicitly
purges supported retained data, including known rows in the deployed Turso schema.
It does not disable table deletion protection. Read `make destroy CLOUD_ARGS="--plan"`
and resolve a protected resource through a separately reviewed operation first.
See [teardown and recovery](README.md#current-checkouts-setup-and-teardown-boundary).

Finish exercise **Teardown** before platform removal. `--drain-events` is rejected
by the restored backend; it belongs to cloud-v1 and requires that installation's
matching release. Source buckets, shared CDKToolkit assets, competitor bootstrap
roles and separately deployed exercise resources are outside ordinary platform
destruction. Turso rows survive ordinary destroy.

## Existing installations and launcher sources

The CLI discovers original Lite and cloud physical stack pairs. If both exist,
explicitly choose `TENKACLOUD_STACK_LAYOUT=lite` or `cloud`. Original Lite adoption
requires matching ownership tags and persistent template resource identities.
The published cloud-v1 resource/schema layout is refused for in-place updates;
use its matching release or a separate environment/database. Destroy recovery
remains available after ownership verification. There is no automatic migration.

`templates/cloud-pipeline.yaml` preserves one CodeBuild launcher and its source
selection. Review the complete template, selected platform/catalog revisions and
who may create, update or start it. Its existing broad CodeBuild caller policy and
standard `cdk-*` role assumption remain privileged access after bootstrap.
Creating the launcher does not start a build. Its deploy build uses ordinary
`make deploy`: after any original-installation upgrade confirmation, automatic
standard bootstrap only if missing, followed by `--require-approval never`. An
unattended launcher cannot upgrade an original installation using generic `--yes`.
Deletion retains explicit confirmation.

A source override must implement the launcher's checked source contract; historical
pins continue to execute their own checkout. Selecting a catalog does not make all
of its templates deployable. The restored Lambda and CodeBuild paths use
CloudFormation `TemplateBody`; oversized templates still need separate work.
Source/provider changes do not migrate data or relax existing IAM boundaries.
