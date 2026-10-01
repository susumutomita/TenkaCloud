# Cloud deployment permission boundaries

Current cloud hosting has an inspectable first-account path. It transforms the pinned
CDK bootstrap template, preserves its resource/output/qualifier/version contract and
replaces broad deployment/lookup grants. Shared `CDKToolkit` is never adopted and
`AdministratorAccess` is never a current-control-plane fallback.

## First-account setup

The account/region below are placeholders. No live AWS, IAM or billing operation was
performed during implementation or tests. Use the intended AWS profile throughout.

```bash
export ACCOUNT_ID=123456789012
export AWS_REGION=ap-northeast-1
export ENV=development
make -s deploy CLOUD_ARGS="--show-setup" > /tmp/tenkacloud-setup.json
```

`--show-setup` is offline. Review the template's IAM documents, names and
`Metadata.TenkaCloudSetupPermissions`: the latter is the exact initial-caller policy.
An IAM administrator prepares that temporary setup principal. Setup creates or
updates only the owned `TenkaCloudToolkit-<environment>`, qualifier-scoped asset
resources, roles and managed policies. It does not attach policies to the caller,
change credentials, activate trusted access or grant cross-account bootstrap trust.

```bash
# Initial-setup principal; the command asks for confirmation after review.
make deploy CLOUD_ARGS="--setup"
# Switch to the intended ordinary deployment operator's AWS profile/role.
export TENKACLOUD_ADMIN_EMAIL=organizer@example.com
make deploy
```

`--setup` installs and verifies the toolkit only; it does not deploy the application.
Its output names the generated operator policy. An IAM administrator attaches that
policy only to the intended deployment operator. The CodeBuild launcher references
that same policy after setup. Ordinary `make deploy` performs no toolkit/IAM setup;
missing or mismatched setup stops before application builds. `make destroy` uses the
operator policy to coordinate cleanup while retaining data. Cognito organizers need
no AWS policy. Neither policy is automatically attached to a user or existing role.

## Fail-safe behavior

Both synthesizers and the CLI use the same project qualifier. Existing toolkits must
match ownership/environment tags, qualifier, execution-policy list, versioned
bootstrap variant and empty trusted-account parameters. Earlier unbounded project
toolkits and unrelated configurations are not automatically migrated or adopted.
Previously deployed resources missing ownership or `TenkaCloudRegion` tags need an
explicitly privileged, separately reviewed migration before the new execution policy
can update them. The documented setup route is for a fresh installation.

Default execution policies are generated from the reviewed source for this account,
region and environment. Leave `TENKACLOUD_CFN_EXECUTION_POLICY_ARN` unset for fresh
setup. Its optional comma-separated value is only an assertion of the already installed
execution-policy list, not an installer for arbitrary custom policies. ARNs must belong
to the deployment account, use `policy/tenkacloud/cloud-hosting/`, and exactly match
the toolkit list. ARN/ownership validation does not replace policy-content review.
Bootstrap roles use rewritten scoped policies; application/provider roles additionally
carry the generated permissions boundary.

The stock-template transform fails closed if an upstream change introduces an
unexpected IAM resource. Every application/provider role receives the installation's
application boundary. The execution policy can apply only that boundary and cannot
remove or edit it. Managed policies are split at statement boundaries to meet IAM
size limits; oversized legacy binding sets fail explicitly rather than broadening
permissions. The generated template and setup policy are reviewable artifacts.

## Derivation from the synthesized resources

The current two synthesized stacks contain the following resource families:

- DynamoDB: three project tables and event/deployment GSI1 indexes
- Cognito: one organizer pool, client and domain
- Lambda: the API function and CDK static-asset deployment/cleanup providers
- API Gateway: one regional REST API, Cognito authorizer, explicit methods/stage
- S3/CloudFront: two private SPA buckets, origin access controls, distributions,
  asset deployment and cache invalidation
- IAM/Logs: execution roles/policies and function log groups for those resources
- One Standard Step Functions workflow, scoped Lambda workers/dispatcher/recovery,
  scheduled and terminal-status EventBridge rules, and a private retained
  execution-artifact bucket
- One public, secret-free competitor bootstrap template object and an installation
  SSM SecureString initialized through the existing account-registration flow

`lib/cloud-hosting/deployment-policy.ts` inventories these synthesized resource types
and defines explicit actions and account/region/project scopes. Tests compare both
actual synths with that inventory, cover all generated application roles and the
stock-template transform, and reject broad action wildcards/default administrator
grants. No AWS policy simulator or live create/update/delete was run.

Residual scopes are listed in the generated policy module: CloudFront origin access
controls, APIs lacking resource-level/tag authorization, regional log-delivery and
CloudFormation validation/export discovery. Generated/truncated S3 and PassRole
names use the bounded TenkaCloud project namespace. Deployment operators are
TenkaCloud project administrators across environments in this account/region where
these actions cannot be isolated. Environment names are not an IAM security boundary.
CloudFormation stack targets remain exact; supported ownership tags and participant/team
restrictions remain enforced. Deployers can change project code, data and identity. Use a dedicated hosting account when that trust boundary is
needed. API Gateway account-wide logging configuration is not changed; Lambda
operation logs remain. Previously generated retained API logging roles/settings
are not deleted when that unused construct is removed.

## One-time setup versus ordinary use

The initial caller needs the generated setup policy; the ordinary deployment
operator uses the distinct operator policy with asset-publishing and owned-stack
CloudFormation operations. There is no additional
source-bundle bucket or source archive upload in the current path. These setup
credentials are never placed in SPA configuration or participant responses.

Ordinary organizers use Cognito and the application API. They receive no AWS IAM
credentials or bootstrap policy. The foundation API has table-scoped storage
permissions. Opt-in execution adds table-specific Get/Query/Put/Update and
ConditionCheckItem permissions for atomic intent, scoring and receipt writes.
DynamoDB transactions are authorized through their underlying actions, not an
invented `dynamodb:TransactWriteItems` IAM action.

Connection verification uses the installation's fixed role name and required
Purpose/Installation resource tags, mandatory ExternalId, and current verified
registry identity. Its account component varies only through Admin registration;
API and worker IAM policies explicitly deny assuming roles in the platform account.
Existing legacy jobs retain separate exact role and parameter grants. The API can
read/create only the fixed installation SSM parameter, with no overwrite/delete
path, and accesses current catalog/binding objects in the installation bucket.
A durable registry marker prevents silently replacing a missing, previously used
ExternalId. The missing-key recovery check may Scan only the installation's Events
and Deployments tables. No secret values enter runtime-config.json or logs.

The hello-world participant CLI slice adds one API-side `sts:AssumeRole` permission
for viewer roles. Generated names are not guessed: the statement requires explicit
`TenkaCloud:Purpose=participant-viewer`, `ProblemId=hello-world`, the fixed
`OperatorAccount`, a `StackId` under the `tc-cloud-*` stack namespace, and a
`JobId` tag equal to the mandatory request ExternalId. These are custom template
tags, not reserved `aws:cloudformation:*` tags. The canonical pinned problem
contains them; older deployments missing the tags deny access.
The existing platform-account explicit deny remains effective.

Before viewer issuance, the API uses the current competitor connection for
read-only `DescribeStacks` and `DescribeStackResource` against the original
physical stack ARN. It verifies event/team/job/attempt ownership and binds the
physical viewer role to that stack. It then assumes the viewer as the operator
principal, with the job ID (never the shared bootstrap secret) as ExternalId.
An inline STS policy explicitly denies every action except exact-parameter
`ssm:GetParameter`/`ssm:GetParameters`, every other resource, and use beyond the
event's effective expiry. Existing role permissions are not expanded. See the
[STS session-policy contract](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html).
Issuance uses STS's 900-second minimum duration; DynamoDB key revocation does not
instantly revoke previously returned sessions. Console federation is not enabled.
The final release decision uses a condition-only DynamoDB transaction over the
existing Events, Teams and Deployments tables. Their existing API
`dynamodb:ConditionCheckItem` grants cover it; no new table, marker or grant is needed.

The dispatcher can Query only the pending-dispatch partition and strongly Get the
Events table's `INSTALLATION` control key. It starts and describes executions only
under the installation's state machine. Historical retry reconciliation adds
Get/Put/Update/Delete on the existing Deployments table, restricted to
`DEPLOYMENT#*` and `DISPATCH#PENDING` leading keys. Create/describe/finish workers
can Query the same table's `DEPLOYMENT#*` history; finish can remove only pending
dispatch intents. These grants add no competitor-account access. The control read is restricted with `dynamodb:LeadingKeys`. State-machine tasks invoke their own
workers. Remote workers use the same installation role/tag restriction or explicit legacy
binding, require ExternalId, and read only configured secret parameters. Historical catalog reads
are limited to this installation bucket's catalogs prefix; current binding reads
are limited to the exact content-addressed binding object. No ambient credentials
are passed to CloudFormation. Recovery can DescribeExecution only for executions
of this state machine and uses ownership-qualified deployment writes.

This does not create competitor-account trust automatically or broaden the existing
competitor-bootstrap exception. Each account follows its explicit registration flow.
Problem-template permissions, including any dedicated-account assumptions, require
separate review. Platform teardown coordinates active/pending event work before removing the runner.
The operator running this CLI needs the actions used by its direct storage path:

- Events: `GetItem`, `Scan`, `PutItem`, `UpdateItem`, `ConditionCheckItem`
- Teams: `Query`
- Deployments: `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`

Each action above has the `dynamodb:` prefix and is scoped to that exact owned table.
These direct operator permissions are in the generated operator policy, distinct
from CloudFormation execution and Cognito roles. The CLI verifies table ownership
before use; native settlement also reads owned catalog/plugin artifacts. Setup
creates the policy but does not attach it to the caller. CloudFormation deletion and waiting use exact
physical stack ARNs. Permission errors preserve the platform and durable stop state.
Independently deployed exercises and retained data/artifact buckets are not purged.

## One launcher, explicit source compatibility

`templates/cloud-pipeline.yaml` keeps one CodeBuild project, platform/catalog source
selection, invitations, deployment/teardown paths, original physical names, output
links and checkpoint values. The default `current-cloud-v1` contract uses the current
CLI and installed operator policy. Published
`SourceDefaults.current-cloud-v1.CurrentPlatformCommit` points to a tested source
commit containing `scripts/cloud-hosting/launcher-check.ts`; incompatible refs fail
before AWS use. Custom repositories remain selectable. Current catalogs must contain
the reviewed `hello-world` and `ac26-crypto-battle` artifacts and supported contracts;
selecting a catalog does not enable arbitrary runtimes.

Advanced `historical-949a40a9` compatibility preserves the original fixed source pair
and full old behavior: Turso, provisioned capacity, old `.env`, shared bootstrap and
`destroy-all`. Its broad role is conditional on that explicit historical choice.
No current-stack adoption or automatic data migration is promised. Empty ref inputs
select the chosen contract's defaults.

Current builds reject Turso, a custom shared ExternalId, nondefault provisioned
capacities, `RetainDataTables=false` and `destroy-all` before AWS operations.
`RetainDataTables=auto` preserves current retention and the historical false default.
Current `destroy` drains recorded event work before platform removal, retaining
history, accounts, ExternalId, toolkit and assets. It never emits a complete-purge
checkpoint. Historical cleanup checkpoints require successful historical `destroy-all`.
