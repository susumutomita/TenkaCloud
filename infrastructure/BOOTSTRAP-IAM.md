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

The normal command checks `CDKToolkit` first. If it exists and is compatible, it
continues without bootstrap changes. Otherwise it displays the target and standard
bootstrap authority and cost notice, runs the repository's pinned CDK CLI, verifies
the resulting toolkit, and continues with the same credentials. Ordinary deployment
uses `--require-approval never`, including in CI; no extra flag or confirmation is
required. No policy is attached to the caller and no profile is changed.

First bootstrap needs CloudFormation, IAM, S3, ECR and SSM permissions for the
standard toolkit resources; AWS's documented starting policy uses those service
wildcards on `*`. Account controls such as SCPs, permission boundaries and explicit
denies still apply. Review this with the account owner rather than treating a
bootstrap preview as proof that an identity is authorized. If bootstrap succeeds
and application deployment fails, the toolkit remains and is reused on retry.

The ordinary deployment caller needs access to inspect stacks/bootstrap metadata,
assume the standard publishing/lookup/deployment roles, and use the direct
Cognito invitation and optional coordinated teardown operations listed below. Existing
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
optional. All paths require the caller's existing permissions; failures are reported,
not hidden by changing credentials or permissions.

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
Cognito, Lambda, API Gateway, S3, CloudFront, Step Functions, EventBridge, IAM, Logs
and SSM resources. The current path builds the two SPAs and publishes CDK assets;
it creates no separate source-bundle bucket or archive. Deployers can change
application code, identities, permissions and data, so treat them as installation
administrators. Standard bootstrap defaults also allow authority beyond TenkaCloud;
use an account boundary where this trust separation is required.

These setup/deployment credentials are never placed in SPA configuration or
participant responses. Application/provider runtime roles retain their explicit
service permissions; standard bootstrap does not add `AdministratorAccess` to them.
API Gateway account-wide logging configuration is not changed. Previously retained
logging roles/settings are not deleted by this correction.

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
separate review. Explicit `--drain-events` coordinates active/pending event work
before removing the runner; ordinary platform destroy does not use the database.
For installation update checks and explicit event drain, the DynamoDB operator
needs the actions used by that direct storage path:

- Events: `GetItem`, `Scan`, `PutItem`, `UpdateItem`, `ConditionCheckItem`
- Teams: `Query`
- Deployments: `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`

Each action above has the `dynamodb:` prefix and is scoped to that exact owned table.
Grant these direct operations to the intended deployment/teardown caller separately
from CloudFormation execution and Cognito application roles. The CLI verifies table
ownership before use; native settlement also needs `s3:GetObject` for owned
catalog/plugin artifacts. Ordinary deployment needs `cognito-idp:AdminGetUser` and
`cognito-idp:AdminCreateUser` for the installation's organizer pool. CloudFormation
destruction uses the standard CDK deployment-role assumption with exact physical
stack ARNs; its existing same-account fallback remains available. An already
deleting stack only needs the read-only waiter. Standard bootstrap does not
grant these direct operations to the caller. Turso operators instead need
`ssm:GetParameter` for the exact selected token parameter and database access.
Permission errors in explicit drain preserve the platform and durable stop state.
Independent exercise resources are only removed by an explicit exercise operation;
ordinary platform destroy follows the deployed resource removal policies.

Ordinary teardown and failed-deployment recovery also use direct S3 cleanup before
CloudFormation removes the stacks. The actual CLI caller needs:

- `cloudformation:DescribeStacks`, `cloudformation:GetTemplate` and `cloudformation:ListStackResources` for the exact owned stacks
- `s3:GetBucketTagging` and `s3:ListBucketVersions` on the exact owned bucket ARNs
- `s3:DeleteObject` and `s3:DeleteObjectVersion` on objects in those owned buckets

CloudFormation execution-role permissions alone do not authorize these CLI calls.
Cleanup reads bucket names and deployed retention policies from CloudFormation,
requires the expected account owner and matching project/environment/stack/logical-ID
tags, and rechecks tags before each deletion request. After confirmation, it removes
object versions and delete markers and verifies that the bucket is empty. Ordinary
destroy excludes retained bucket contents; explicit retained-data purge includes
them while preserving `Retain` bucket containers. No `s3:ListAllMyBuckets`,
`s3:PutBucketPolicy` or direct `s3:DeleteBucket` permission is needed by this cleanup,
and it never adopts resources by a global name prefix. Ownership or permission
failures, malformed inventories and incomplete object deletion stop stack removal.
The CLI does not relax policies to recover from these failures. These paths were
checked with injected process responses; no live AWS cleanup was executed.

## One launcher, explicit source compatibility

`templates/cloud-pipeline.yaml` keeps one CodeBuild project, platform/catalog source
selection, invitations, deployment/teardown paths, original physical names, output
links and checkpoint values. The default `current-cloud-v1` contract uses the current
CLI and standard CDK bootstrap. The launcher reuses its preserved former broad
CodeBuild caller policy, including IAM, CloudFormation and other service wildcards,
standard `cdk-*` role assumption, Cognito invitations and DynamoDB cleanup access.
This privileged role persists after bootstrap. Review the complete template,
selected source refs and who can create/update/start the build before using it.
The launcher never attaches a generated TenkaCloud policy or expands bootstrap
trust. Creating it provisions its role and logs but does not start a build.
Starting current deploy runs ordinary `make deploy`, which creates missing standard
bootstrap and deploys application IAM changes with `--require-approval never`.
It needs no additional approval flag or prompt; deletion paths retain their
explicit confirmation behavior.
Published
`SourceDefaults.current-cloud-v1.CurrentPlatformCommit` points to a tested source
commit containing `scripts/cloud-hosting/launcher-check.ts`; incompatible refs fail
before AWS use. Custom repositories remain selectable. Current catalogs must contain
the reviewed `hello-world` and `ac26-crypto-battle` artifacts and supported contracts;
selecting a catalog does not enable arbitrary runtimes.

The launcher uses one current source contract. Empty ref inputs select its tested
defaults. Turso and DynamoDB are selectable through the same environment contract;
Turso mode grants runtime access only to its exact SSM token parameter and creates
no DynamoDB tables. Source or provider changes do not migrate existing data.

Current builds accept `destroy-all` and default `RetainDataTables` to false; only
explicit true retains data tables. `auto` also selects the original false default.
Current `destroy` removes platform-owned resources under their deployed policies.
Competition cleanup is explicit through the event Teardown action or
`--drain-events`; toolkit and competitor bootstrap resources remain outside scope.
See the [teardown contract](README.md#current-checkouts-setup-and-teardown-boundary)
for exact retained-data purge and existing deletion-protection recovery.
