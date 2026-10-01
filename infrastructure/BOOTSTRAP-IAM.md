# Cloud deployment permission boundaries

The complete `templates/cloud-pipeline.yaml` launcher preserves the original
CodeBuild role and bootstrap instructions for its fixed historical source refs.
That role has broad, administrator-equivalent deployment permissions. The rename
does not create a new grant, narrow the old policy, or authorize AWS execution.
Review those permissions and teardown consequences before running the launcher.

The sections below describe `scripts/cloud-hosting/main.ts` in the current
checkout. This CLI is not the code executed by the launcher's default fixed refs.
It requires an explicit reviewed execution policy instead of CDK's broad default.
Initial least-privilege setup remains an unfinished acceptance item.

## Fail-safe behavior

Before builds or setup, the CLI requires `TENKACLOUD_CFN_EXECUTION_POLICY_ARN` in this
shape:

```text
arn:aws:iam::<deployment-account>:policy/tenkacloud/cloud-hosting/<reviewed-policy>
```

The account must match the current caller/deployment identity. This validates identity and
namespace, not the policy's contents; the policy must be reviewed separately.
The CLI does not create, attach, or silently expand that policy.

Bootstrap uses `TenkaCloudToolkit-<environment>` and a deterministic project
qualifier. The same qualifier is used by both stack synthesizers. Existing project
toolkits must have matching ownership/environment tags, qualifier, and execution
policy. Missing/mismatched metadata stops the operation before builds or setup. The shared
`CDKToolkit` and unrelated toolkit configurations are never adopted.

The future approved first-account flow should create only the reviewed project
policy and scoped toolkit. It should not introduce a general IAM-management layer.
No bootstrap, IAM, deployment, or billing action was executed during development.

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

The setup policy therefore needs the corresponding CloudFormation lifecycle APIs,
scoped to these project resources wherever the API supports resource-level control.
Creation/discovery APIs that require `Resource: *` must be individually reviewed,
with supported account, region, request-tag, and resource-tag conditions. They are
not a reason to grant a service-wide wildcard action set.

IAM permissions require particular care: scope role creation and policy updates
to generated project roles, constrain `iam:PassRole` to those roles and their
intended service, and validate any required permissions boundary. The CDK asset
bucket/repositories and bootstrap roles must be limited to the project qualifier.
Derive the final actions from the exact synthesized templates and provider assets,
then test updates and teardown as well as creation before calling onboarding ready.
A broad execution policy is not supplied as a convenience fallback.

## One-time setup versus ordinary use

The operator running initial setup needs the reviewed bootstrap/IAM permissions,
CDK asset publishing, and CloudFormation operations. There is no additional
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

This does not create the competitor trust policy or provide a broad CloudFormation
execution role. The initial reviewed bootstrap/competitor setup remains unfinished.
Problem-template permissions, including any dedicated-account assumptions, require
separate review. Platform teardown coordinates active/pending event work before removing the runner.
The operator running this CLI needs the actions used by its direct storage path:

- Events: `GetItem`, `Scan`, `PutItem`, `UpdateItem`, `ConditionCheckItem`
- Teams: `Query`
- Deployments: `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`

Each action above has the `dynamodb:` prefix and is scoped to that exact owned table.
These direct
operator permissions are distinct from the CloudFormation execution policy and
ordinary Cognito roles; the CLI does not create or grant them. Scope their resources
to the exact verified table ARNs. CloudFormation deletion and waiting use exact
physical stack ARNs. Permission errors preserve the platform and durable stop state.
Independently deployed exercises and retained data/artifact buckets are not purged.

## Preserved launcher contract

The pipeline rename keeps resource definitions and BuildSpec instructions exactly
as in `825415fc:infrastructure/templates/lite-pipeline.yaml`. This includes the
existing CodeBuild role, physical names, pinned platform/catalog refs, backend
parameters and `deploy` / `destroy` / `destroy-all` behavior. The launcher tests
check resource and condition hashes, parameter/output contracts and synthetic
success/failure paths without running AWS commands.

The parameter IDs and checkpoint values retain their historical spelling for
compatibility. Only the public filename and displayed hosting name change.
There is no second, reduced-functionality launcher in the published tree.
