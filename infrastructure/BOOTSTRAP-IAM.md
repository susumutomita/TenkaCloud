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
bootstrap authority, asks for separate first-bootstrap confirmation, runs the
repository's pinned CDK CLI, verifies the resulting toolkit, and continues with
the same credentials. Interactive application deployment retains CDK's normal
security-change review. No policy is attached to the caller and no profile is changed.

First bootstrap needs CloudFormation, IAM, S3, ECR and SSM permissions for the
standard toolkit resources; AWS's documented starting policy uses those service
wildcards on `*`. Account controls such as SCPs, permission boundaries and explicit
denies still apply. Review this with the account owner rather than treating a
bootstrap preview as proof that an identity is authorized. If bootstrap succeeds
and application deployment fails, the toolkit remains and is reused on retry.

The ordinary deployment caller needs access to inspect stacks/bootstrap metadata,
assume the standard publishing/lookup/deployment roles, and use the direct
Cognito invitation and coordinated teardown operations listed below. Existing
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

`--setup` does not update an existing toolkit or deploy the application. Unattended
first deployment uses `CLOUD_ARGS="--setup-if-needed --yes"` after review.
`--yes` alone approves application deployment changes, not creation of a missing
bootstrap. Setup-only automation can use `--setup --yes`. All paths require the
caller's existing permissions. Declining first bootstrap stops before IAM changes
and builds; failures are reported, not hidden by changing credentials or permissions.

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

`make destroy` retains the standard toolkit, CDK assets, event data and organizer
identity. Retention does not promise automatic reattachment on a fresh deployment.
No live AWS bootstrap, IAM change or deployment was performed by source tests.

## Deployment authority versus ordinary use

The standard CloudFormation execution role deploys the application's DynamoDB,
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
separate review. Platform teardown coordinates active/pending event work before removing the runner.
The operator running this CLI needs the actions used by its direct storage path:

- Events: `GetItem`, `Scan`, `PutItem`, `UpdateItem`, `ConditionCheckItem`
- Teams: `Query`
- Deployments: `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`

Each action above has the `dynamodb:` prefix and is scoped to that exact owned table.
Grant these direct operations to the intended deployment/teardown caller separately
from CloudFormation execution and Cognito application roles. The CLI verifies table
ownership before use; native settlement also needs `s3:GetObject` for owned
catalog/plugin artifacts. Ordinary deployment needs `cognito-idp:AdminGetUser` and
`cognito-idp:AdminCreateUser` for the installation's organizer pool. CloudFormation
deletion and waiting use exact physical stack ARNs. Standard bootstrap does not
grant these direct operations to the caller. Permission errors preserve the platform and durable stop state.
Independently deployed exercises and retained data/artifact buckets are not purged.

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
Starting current deploy runs `make deploy CLOUD_ARGS="--setup-if-needed --yes"`,
explicitly approving first bootstrap if missing and application IAM changes.
Published
`SourceDefaults.current-cloud-v1.CurrentPlatformCommit` points to a tested source
commit containing `scripts/cloud-hosting/launcher-check.ts`; incompatible refs fail
before AWS use. Custom repositories remain selectable. Current catalogs must contain
the reviewed `hello-world` and `ac26-crypto-battle` artifacts and supported contracts;
selecting a catalog does not enable arbitrary runtimes.

Advanced `historical-949a40a9` compatibility preserves the original fixed source pair
and full old behavior: Turso, provisioned capacity, old `.env`, shared bootstrap and
`destroy-all`. The original broad caller role is retained for both source contracts; historical
behavior and data-deletion semantics still require their own review.
No current-stack adoption or automatic data migration is promised. Empty ref inputs
select the chosen contract's defaults.

Current builds reject Turso, a custom shared ExternalId, nondefault provisioned
capacities, `RetainDataTables=false` and `destroy-all` before AWS operations.
`RetainDataTables=auto` preserves current retention and the historical false default.
Current `destroy` drains recorded event work before platform removal, retaining
history, accounts, ExternalId, toolkit and assets. It never emits a complete-purge
checkpoint. Historical cleanup checkpoints require successful historical `destroy-all`.
