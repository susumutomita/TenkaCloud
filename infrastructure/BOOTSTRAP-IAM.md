# Cloud bootstrap permission prerequisite

The installed CDK default bootstrap template assigns broad administrator access
when no CloudFormation execution policy is supplied. TenkaCloud does not use that
default. Initial least-privilege setup remains an unfinished acceptance item.

## Fail-safe behavior

Before setup/upload, the CLI requires `TENKACLOUD_CFN_EXECUTION_POLICY_ARN` in this
shape:

```text
arn:aws:iam::<deployment-account>:policy/tenkacloud/cloud-hosting/<reviewed-policy>
```

The account must match source/deployment identity. This validates identity and
namespace, not the policy's contents; the policy must be reviewed separately.
The CLI does not create, attach, or silently expand that policy.

Bootstrap uses `TenkaCloudToolkit-<environment>` and a deterministic project
qualifier. The same qualifier is used by both stack synthesizers. Existing project
toolkits must have matching ownership/environment tags, qualifier, and execution
policy. Missing/mismatched metadata stops the operation before upload. The shared
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
asset upload, and CloudFormation operations. Source preparation additionally uses
only its account/environment source bucket. These setup credentials are never
placed in SPA configuration or participant responses.

Ordinary organizers use Cognito and the application API. They receive no AWS IAM
credentials or bootstrap policy. The API Lambda has only table-specific
`GetItem`/`Query`, event/team transaction writes, and team access-row deletion;
it cannot manage IAM, CloudFormation, deployments, or competitor accounts.
DynamoDB transactions are authorized through their underlying actions, not an
invented `dynamodb:TransactWriteItems` IAM action.

Exercise execution requires a separate reviewed path with a mandatory ExternalId
and minimal competitor-role trust. That path is not yet wired into this slice.
Platform teardown does not remove independently deployed exercise resources.
