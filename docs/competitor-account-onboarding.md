# Competitor AWS account setup

Use the existing **Competitor Accounts** screen and
[competitor-bootstrap.yaml](../infrastructure/templates/competitor-bootstrap.yaml) for both paths:

- **AWS Organizations already configured:** an organization administrator distributes
  the role centrally with service-managed CloudFormation StackSets to selected accounts or OUs
- **No Organizations, or accounts outside the organization:** each account owner creates
  an individual CloudFormation stack using the same template and parameters

Register each AWS account once. Teams can use separate accounts or share an account
with different problem deployment regions. The named IAM bootstrap role is global:
**create it in only one bootstrap region per account**, regardless of the regions
chosen for teams. Deploying the same named role into a second region causes a name
collision; it does not add regional isolation. The registration's region is not a
request to create another bootstrap role.

## Get the installation's parameters

1. As a TenkaCloud Admin, add the selected account IDs using **Add account** or
   **Bulk import**. A bulk request accepts up to 50 accounts. Registration alone
   does not create IAM roles or grant access.
2. Copy the displayed `TenkaCloudAccountId`, `ExternalId`, and `RoleName` for this
   installation. Use all three exact values in either setup path. Do not use the
   template's default role name in place of the displayed installation role.
3. Download the linked bootstrap template. Keep `ExternalId` and the shared setup
   details private; never put them in this repository, tickets, public template
   objects, or command-line arguments. If the reveal was already closed, follow
   [ExternalId recovery](../infrastructure/README.md#externalid-recovery).

Both paths keep the template's exact control-plane account trust, mandatory
`sts:ExternalId`, installation/purpose tags, and one-hour maximum role duration.
The existing `AdministratorAccess` exception applies only to this competitor
bootstrap role. Never install it in the TenkaCloud control-plane account or use
it as a participant role; participant access remains problem-scoped.

## Organizations: central distribution

### Prerequisites and scope

- Organizations must have **all features** enabled; consolidated billing alone
  is insufficient. An administrator of the management account must explicitly
  activate CloudFormation StackSets trusted access if it is not already active.
  This allows AWS to create organization administration/member roles and target
  execution roles. TenkaCloud does not activate trusted access or register a
  delegated administrator. Have the organization owner review these access
  changes separately. See [AWS trusted-access prerequisites](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-activate-trusted-access.html).
- Run from the management account (`--call-as SELF`) or an already registered
  delegated administrator (`--call-as DELEGATED_ADMIN`). StackSets belong to the
  management account in both cases. Delegation grants organization-wide StackSets
  deployment authority; selecting an OU for this rollout does not limit the
  delegated administrator's authority. See [AWS delegated administration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-delegated-admin.html).
- Explicitly review the target OU IDs, their child OUs, and account IDs. The
  management account is excluded by service-managed StackSets, and accounts
  outside this organization cannot be targeted. Exclude the TenkaCloud
  control-plane account and unrelated accounts from the selected set.
- Use `INTERSECTION` to select specific accounts within the selected OUs. If the
  entire OU and all its descendants are intentionally approved, omit `Accounts`
  and use `AccountFilterType=NONE`. Do not default to the organization root or
  `UNION`. See [AWS service-managed deployment targets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-associate-stackset-with-org.html).
- Keep **automatic deployment disabled**. It operates at StackSet level and
  ignores account-level targeting filters for newly added accounts. Enabling it
  later requires a separate review of future account scope and removal behavior.
  Retaining removed stacks also retains the IAM role and its trust, outside
  StackSet management. See [AWS automatic deployment behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-manage-auto-deployment.html).

### Console or CLI

In the CloudFormation **StackSets** console, choose **Service-managed permissions**,
upload the same `competitor-bootstrap.yaml`, and enter the three installation
parameters. Acknowledge named IAM resources, select the reviewed OUs and account
filter, disable automatic deployment, and choose exactly one bootstrap region.
Review the accounts and permissions before creating the StackSet and instances.
An account owner does not need to create a separate StackSets execution role in
each member account when using this service-managed path.

For the equivalent CLI path, run from the repository root only after the above
prerequisites and scope have been reviewed. Set `TC_ORG_PROFILE` to the approved
AWS profile, `TC_CALL_AS` to `SELF` or `DELEGATED_ADMIN`, `TC_STACKSET_NAME` to a
unique installation-specific name, and `TC_BOOTSTRAP_REGION` to one supported
bootstrap region. These commands create AWS resources; repository tests do not
execute them.

Prepare `TC_PARAMETERS_FILE` outside the checkout as an absolute path to a private
JSON file (owner-only permissions) containing the three parameter entries below.
Replace the placeholders with the installation's actual values using a private
editor. Avoid shell history, debug logging, and shared terminals for secret values.

```json
[
  { "ParameterKey": "TenkaCloudAccountId", "ParameterValue": "<installation account ID>" },
  { "ParameterKey": "ExternalId", "ParameterValue": "<installation ExternalId>" },
  { "ParameterKey": "RoleName", "ParameterValue": "<installation RoleName>" }
]
```

```sh
aws cloudformation create-stack-set \
  --profile "$TC_ORG_PROFILE" --region "$TC_BOOTSTRAP_REGION" \
  --call-as "$TC_CALL_AS" --stack-set-name "$TC_STACKSET_NAME" \
  --permission-model SERVICE_MANAGED --auto-deployment Enabled=false \
  --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://infrastructure/templates/competitor-bootstrap.yaml \
  --parameters "file://$TC_PARAMETERS_FILE"
```

Create `TC_TARGETS_FILE` as a path to JSON containing the explicitly reviewed
target set. Replace these illustrative IDs with the approved OU and member accounts:

```json
{
  "OrganizationalUnitIds": ["ou-abcd-12345678"],
  "Accounts": ["111111111111", "222222222222"],
  "AccountFilterType": "INTERSECTION"
}
```

```sh
aws cloudformation create-stack-instances \
  --profile "$TC_ORG_PROFILE" --region "$TC_BOOTSTRAP_REGION" \
  --call-as "$TC_CALL_AS" --stack-set-name "$TC_STACKSET_NAME" \
  --deployment-targets "file://$TC_TARGETS_FILE" \
  --regions "$TC_BOOTSTRAP_REGION" \
  --operation-preferences FailureToleranceCount=0,MaxConcurrentCount=1
```

Record the returned operation ID as `TC_OPERATION_ID`. Inspect completion and
per-account results; a submitted operation is not evidence of successful setup:

```sh
aws cloudformation describe-stack-set-operation \
  --profile "$TC_ORG_PROFILE" --region "$TC_BOOTSTRAP_REGION" \
  --call-as "$TC_CALL_AS" --stack-set-name "$TC_STACKSET_NAME" \
  --operation-id "$TC_OPERATION_ID"

aws cloudformation list-stack-set-operation-results \
  --profile "$TC_ORG_PROFILE" --region "$TC_BOOTSTRAP_REGION" \
  --call-as "$TC_CALL_AS" --stack-set-name "$TC_STACKSET_NAME" \
  --operation-id "$TC_OPERATION_ID"

aws cloudformation list-stack-instances \
  --profile "$TC_ORG_PROFILE" --region "$TC_BOOTSTRAP_REGION" \
  --call-as "$TC_CALL_AS" --stack-set-name "$TC_STACKSET_NAME" \
  --stack-instance-region "$TC_BOOTSTRAP_REGION" \
  --filters "Name=LAST_OPERATION_ID,Values=$TC_OPERATION_ID" \
  --query "Summaries[?Status=='CURRENT' && StackInstanceStatus.DetailedStatus=='SUCCEEDED'].Account" \
  --output text
```

Compare the successful IDs with the approved target list and resolve failed or
missing instances. If the accounts were not yet registered, paste these IDs into
**Bulk import** in batches of at most 50. Existing registrations remain unchanged
and are reported as duplicates. Then use **Verify** or **Verify all** in TenkaCloud;
StackSet success does not bypass the installation's trust and role checks.

Keep existing individually managed bootstrap stacks in place when adding this
path. Do not create a second stack with the same role name in those accounts or
delete a working role to retry. Any migration of stack ownership needs its own
review; it is not performed by account registration.

## Without Organizations: individual account setup

The account owner opens the existing **Launch Stack** link from registration
details, or downloads the same template and creates a stack manually. Enter the
three installation parameters and acknowledge named IAM resources. If Quick-create
is unavailable, use the manual template path. Choose one bootstrap region per account and
wait for `CREATE_COMPLETE`, then use **Verify** in TenkaCloud. Repeat for each
account; Organizations, StackSets roles, and trusted access are not required.

## Event assignment and revocation

Bootstrap distribution only establishes the operator's deployment role. Assign
accounts and supported problem regions to teams in event setup. Account sharing
with different regions still shares global IAM and other account-wide services;
it does not establish a security boundary for arbitrary problems. Check each
problem's participant permissions. The cloud hello-world participant slice issues
only scoped CLI credentials; it does not enable AWS Console federation.

Removing a registration blocks new TenkaCloud use but retains the bootstrap role
and shared ExternalId. Finish teardown of event resources before removing the
role, or cleanup can lose access. With automatic deployment disabled, moving an
account out of an OU does not remove its role. StackSets owners revoke centrally by deleting
the selected stack instances **without retaining stacks**, then checking results;
individual owners delete their bootstrap stack. Deleting a StackSet definition
or retaining its stacks does not itself revoke the role. Already-issued STS
credentials can remain usable until expiry.
