# Cloud hosting

Cloud hosting restores the existing SBT-free, single-installation Lite backend:
Lambda, Cognito, API Gateway, CloudFront, Step Functions and CodeBuild, with either
Turso or DynamoDB. The public hosting name is **cloud**. Local hosting remains the
unified Bun process and persistent SQLite; `make local`, `make down`,
`make local-reset` and local state are unchanged. There is no SaaS provisioning,
tenant administration product or tier plan.

## Restored competition backend

The existing event/team, deployment and participant APIs provide:

- Event creation, scheduling, team keys, scoring controls and scoreboards
- Generic AWS CloudFormation create, update, no-op, recreate and teardown paths
- Flag and multi-flag submissions and scheduled endpoint scoring
- Participant CLI credentials and Console access through the problem's participant role
- Competitor-account registration, verification and mandatory ExternalId
- Native coordination, including Cryptography Battle, with private team views,
  persisted runs and scoring on the selected database
- The original Lambda and CodeBuild problem-deployment paths

Docker/Compose exercises remain local-only and are excluded from the cloud catalog.
Catalog availability does not establish that every AWS problem has passed a live
rehearsal. In particular, nine templates in the current canonical catalog exceed
CloudFormation's 51,200-byte `TemplateBody` limit. The restored deployer still uses
`TemplateBody`; it does not implement `TemplateURL` for those larger templates.
This is a historical limitation, and those templates are not verified deployable
through this path.

Both cloud databases retain the original **99-team** event limit. SQL coordination
retains the original **4 MiB** state policy; DynamoDB has its own item-size budget.
These admission and state limits are not a promise of a particular event's latency
or capacity. Rehearse the selected problems and expected concurrency.

Cognito organizer claims keep the original `TenantAdmin`, `TenantOperator` and
`TenantViewer` role values. The console maps them to organizer roles. The internal
`tenantId=local` is fixed compatibility data for one installation, not a user-facing
tenant or an invitation to restore SaaS/SBT. Participants authenticate with their
team key; deployment credentials are never participant credentials.

## Existing installations and resource identity

New installations use `tenkacloud-cloud` and `tenkacloud-cloud-problem-deploy` in
development, with `-<environment>` appended in other environments. The CLI discovers
both Lite and cloud name pairs in the selected account/region before choosing a
target. Existing `tenkacloud-lite` stacks keep their names, including installations
created by earlier restored releases. A partial or failed stack also counts as an
existing installation, even without Outputs. If both pairs exist, the CLI stops
until the operator explicitly selects `TENKACLOUD_STACK_LAYOUT=lite` or `cloud`.
That choice targets one installation; it does not merge, rename or migrate the other.

Restored stacks publish `CloudComposition=lite-baseline-v1`. Before adopting an
original Lite stack, the CLI verifies its ownership tags and template's persistent
resource identities. Database and Cognito logical IDs are preserved. Unknown or
incompatible templates stop the update before bootstrap or source upload.

Original unpinned Lite installations require a one-time confirmation that no active competitions remain, after resource/schema checks and before bootstrap, source upload or deployment. Keep active competitions on their installed version until completion. After verifying that condition, confirm interactively or use `CLOUD_ARGS="--confirm-no-active-events"` for a noninteractive upgrade; generic `--yes` cannot bypass this check. A legacy catalog key alone does not prove a safe upgrade, and historical data is not migrated automatically. New and already-restored installations keep ordinary automatic `make deploy` behavior.

The separately published **cloud-v1** backend also used `tenkacloud-cloud` names,
but its resource/database contract is incompatible with this restoration. Names
alone do not establish compatibility: template resources and composition/provider
Outputs must pass the existing checks. Its stack updates are refused before
mutation. Keep that installation on its matching release and back up/export its data; use a separate
ENV and, for Turso, a separate database for a fresh restored installation. Existing
platform destroy/recovery remains available after its ownership checks. There is
no automatic database migration, backend conversion or resource adoption by name.

## Database selection

Set `CDK_PARAM_CONTROL_DATA_BACKEND=dynamodb` (default) or `turso` in the selected
environment's `.env`. Turso additionally requires:

```dotenv
CDK_PARAM_CONTROL_DATA_BACKEND=turso
CDK_PARAM_TURSO_DATABASE_URL=libsql://your-database.turso.io
CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/tenkacloud/turso/auth-token
```

Use [the setup wizard](#first-run-setup-and-turso-credential-rotation) to create the
database and its SSM SecureString token in the selected AWS region before deployment.
Before bootstrap, source upload or deployment, the CLI reads that exact parameter
and performs a read-only authenticated connection/schema check. It does not print
the token, create schema or modify data during preflight. Nonempty or unrecognized
`cloud_*` schemas fail this check. Known version-1 tables left empty after an explicit
cloud-v1 purge may coexist with the restored schema; preflight neither drops those
tables nor migrates data. Explicit restored-schema reset preserves unrelated and
known-empty retired tables. DynamoDB skips the Turso-only check. Turso runtime roles
can read the exact token parameter and Turso mode creates no DynamoDB tables.

The restored repositories use the original events, teams, deployments, competitor
accounts, endpoint, coordination and supporting schemas. They do not use the
replaced cloud-v1 installation intake, durable dispatch outbox or scoreboard
projection schema. Do not share an installation database with another installation.
Changing the provider or Turso URL of an existing installation is refused; ordinary
destroy resolves the deployed identity even if the local `.env` was edited.

Use either an AWS profile or environment access keys, including `AWS_SESSION_TOKEN`
when needed. Mixing profile selection with access keys is rejected because CLI
and JavaScript SDK credential precedence differs. `AWS_DEFAULT_PROFILE` is accepted;
if both profile variables are set, they must agree. The selected identity and region
also apply to the in-process SDK. No credentials or profile files are rewritten.

## First-run setup and Turso credential rotation

Start with the AWS CLI profile authorized for your hosting account. Run
`aws sts get-caller-identity` to check the account, then:

```bash
make env-init ENV=development
# For Turso, continue with the existing interactive setup wizard:
make turso-live ENV=development
# For DynamoDB, deploy after env-init:
make deploy ENV=development
```

`env-init` asks for the organizer invitation email (`TENKACLOUD_ADMIN_EMAIL`),
12-digit hosting account (`ACCOUNT_ID`) and `AWS_REGION`. It creates the selected
`.env` with owner-only permissions and preserves an existing file. In an
unattended shell, export those three values first; missing values fail instead of
creating placeholder credentials. Custom lowercase environment names use the
development example when they have no example of their own.

The Turso wizard preserves the existing setup sequence: locate the Turso CLI,
offer the pinned official binary with checksum verification if needed, check
login, select or create a database, and create its token in the selected account's
SSM SecureString. Each creation asks for confirmation. The database name defaults
to `tenkacloud-lite` for development and `tenkacloud-lite-<ENV>` otherwise, so
existing names remain usable. It will not silently switch an existing environment
to another database. Only public selectors are saved in `.env`; token values are
passed to the AWS CLI over stdin and are never printed or included in argv.

After saving, the wizard runs the same authenticated `SELECT 1` preflight as
cloud deployment. It asks for the exact word `deploy` before invoking the current
`make deploy`, then verifies the selected cloud or existing Lite stack pair has
zero DynamoDB tables. Deployment retains its existing toolkit, IAM and active
competition checks. The wizard does not enable unrelated features or migrate
existing provider data. Read the offline guide or resume an individual stage:

```bash
make turso-live-guide ENV=development
make turso-live-preflight ENV=development
make turso-deploy-preflight ENV=development
make turso-live-verify-cfn ENV=development
```

The checks use the selected `.env`, AWS profile, account and region. Exported
values override file settings. `turso-deploy-preflight` skips DynamoDB and does
not require an installed Turso CLI. Verification discovers cloud/Lite stack names
using the same selection rule as deploy; specify `TENKACLOUD_STACK_LAYOUT` if
both installations exist. The setup wizard needs an interactive terminal.

Rotate an expired or expiring database token without copying a secret manually:

```bash
make turso-token-rotate ENV=development
make turso-token-rotate ENV=development ROTATE_ARGS="--expiration 30d"
# Existing source CLI alias:
bun run --no-env-file scripts/tenkacloud.ts turso-live rotate-token --expiration 30d
```

The command checks AWS identity, resolves the database name by its configured
URL, confirms the target, issues a replacement, overwrites that exact SSM
SecureString and verifies authenticated `SELECT 1`. A failed verification is an
error and reports that SSM was already changed. `--database <name>` is available
when needed, but its URL must match the selected configuration. The default
expiration is `never`; `TURSO_TOKEN_EXPIRATION` or `--expiration` selects another
lifetime. Rotate before a finite expiration date.

`ROTATE_ARGS="--yes"` is the explicit unattended path. The Turso CLI must already
be authenticated, or receive `TURSO_API_TOKEN` from the operator's secret provider.
`--invalidate` additionally revokes every previous token for that database; use
it only when that disruption is intended. Existing warm Lambda instances may
briefly keep an invalidated token until recycled. This command rotates Turso's
database token, not AWS profile credentials. It preserves the existing
[standalone data reset](#standalone-turso-data-reset) command.

## Cloud deployment pipeline

[`templates/cloud-pipeline.yaml`](templates/cloud-pipeline.yaml) preserves the
existing console launcher and CodeBuild source-selection workflow. Review its
platform/catalog refs, source contract and privileged CodeBuild role before creating
or starting it. Creation provisions the launcher; starting its build is a separate
action. Use platform and catalog revisions that implement the same source contract.
A historical pinned source continues to run that source's behavior.

Ordinary `make deploy` builds the organizer and participant applications and
uploads the source archive to a fresh `<configured-key>.executions/<uuid>.zip`
object in the resolved private source bucket. The CLI verifies the upload and
retains both its exact key and S3 `VersionId` for CodeBuild. The pinned cloud path
requires versioning and rejects an explicit `CDK_PARAM_SOURCE_BUCKET_VERSIONING`
value of `false`, `suspended` or `0` before builds or bucket changes. The standalone
legacy source-preparation helper retains its existing non-pinned behavior.

Each fresh key stays current when later deployments upload another key, so the
existing noncurrent-version expiration does not age out a running event's archive.
These archives consume storage and remain until separately reviewed cleanup of the
owned source bucket; there is no automatic event-aware garbage collection. This
bucket is outside platform CloudFormation ownership and survives `make destroy`
and `make destroy-all`, as do shared CDKToolkit assets. Finish every event that
uses an archive before removing it.

The existing Lambda and CodeBuild problem-deployment paths remain available.
After the original-installation upgrade guard, if applicable, standard CDK bootstrap
is automatic when missing; application deployment uses `--require-approval never`,
including in CI. The launcher role and standard bootstrap
execution role are privileged deployment identities, not ordinary organizer or
participant identities. Review [permission boundaries](BOOTSTRAP-IAM.md).

## Current checkout's setup and teardown boundary

Start with `make deploy CLOUD_ARGS="--help"`; help makes no AWS request. For a
fresh installation, restore the familiar per-environment configuration first:

```bash
# Use staging or production in both paths when selecting those environments.
# Preserve an existing .env; edit it instead of copying over it.
test -e infrastructure/environments/development/.env || \
  cp infrastructure/environments/development/.env.example infrastructure/environments/development/.env
```

Edit that `.env` and set `TENKACLOUD_ADMIN_EMAIL` to the organizer invitation
address, `ACCOUNT_ID` to the intended 12-digit AWS account, and `AWS_REGION` to
the deployment region. The samples deliberately leave email/account empty.
Use an existing AWS CLI profile or role for credentials; do not put access keys
or tokens in this file. Run `make deploy ENV=development` (or the matching
`staging` / `production` environment). A compatible standard `CDKToolkit` in the
selected account/region is reused without changing it. If it is missing, the same
command displays the bootstrap account/region, permission scope and cost notice,
runs the pinned official `cdk bootstrap`, verifies the toolkit, then continues
the application deployment with the same credentials. Ordinary deployment uses
`--require-approval never`; new and already-restored installations require no extra
confirmation, including in CI. Original unpinned installations must first pass the
no-active-events confirmation described above. Existing toolkit configuration is unchanged.

Standard CDK bootstrap creates asset storage and publishing, lookup, deployment
and CloudFormation execution roles. Its default execution role uses
`AdministratorAccess`; the lookup role also has broad read access. These are
privileged deployment credentials, not application or participant credentials.
The first caller needs the official bootstrap permissions and ordinary deployment
permissions. An existing installation needs permission to use its standard roles,
read the toolkit/stacks and perform the CLI's direct invitation/teardown operations.
The CLI never attaches policies to its caller or switches credentials.

Optional `make -s deploy ENV=development CLOUD_ARGS="--show-setup"` previews the
standard bootstrap offline. `CLOUD_ARGS="--setup"` asks for its own confirmation and
only creates a missing toolkit; it does not change an existing one or deploy the
application. Setup-only automation can use `CLOUD_ARGS="--setup --yes"`.
If your organization uses separate bootstrap and deployment principals, use that command with
the authorized bootstrap profile, then switch profiles and run ordinary deploy.

Plain `make deploy ENV=development` also performs first deployment unattended.
`--yes` and `--setup-if-needed` remain accepted for compatibility but are optional
for new and already-restored installations. Neither bypasses the original-installation
upgrade guard; noninteractive original upgrades require `--confirm-no-active-events`
only after the operator verifies that all competitions have completed. Review the target and [permission boundaries](BOOTSTRAP-IAM.md#first-account-setup)
before running it; the caller must already have the required permissions.

`ENV` or `CDK_PARAM_ENVIRONMENT` selects the file before it is read; when both
are present they must agree. The default is `development`. Custom names continue
to work (a lowercase letter followed by up to 31 lowercase letters, digits or
hyphens), with their own `.env` or exported configuration. Only
`infrastructure/environments/<selected-environment>/.env` is loaded. A selector
inside that file must match its directory; copying a staging file into production
does not silently retarget a deployment. Exported process variables override file
values, including an explicit empty value. CI can provide all values without a
file. `REGION` takes precedence over `AWS_REGION`, then `AWS_DEFAULT_REGION`; the
AWS profile region is the fallback for actual AWS commands.

The file accepts single-line `KEY=value` assignments, optional `export`, single
or double quotes, and comments. It rejects duplicate keys and malformed lines;
shell commands and variable references are literal, never executed or expanded.
Use single quotes around JSON values. The CLI never creates or rewrites `.env`.
The Make targets disable Bun's automatic root `.env` loading; use
`bun run --no-env-file scripts/cloud-hosting/main.ts` for direct CLI commands too.

Standard bootstrap is shared by CDK applications in the same account/region;
environment names are not an IAM security boundary. Review existing toolkit trust
and execution policies before using it. The CLI does not rewrite those policies,
upgrade an old bootstrap, create a TenkaCloud-specific qualifier, or migrate older
custom toolkits. Existing `TenkaCloudToolkit-*` stacks and their assets remain
untouched. Only a confirmed CloudFormation not-found response permits first
bootstrap; access denial or incompatible standard bootstrap metadata stops the
operation. Arrange any required standard toolkit upgrade separately.

Source tests and synthesis did not perform live AWS setup/deployment or establish
least-privilege caller permissions. Application runtime policies, participant
access restrictions, ExternalId requirements and owned-stack teardown checks remain
separate from standard CDK deployment authority.

Use `make destroy` with the same account, region and environment. It verifies selected
platform stack ARNs and ownership tags, shows the deletion consequences, then asks
for confirmation. `CLOUD_ARGS="--yes"` is explicit noninteractive confirmation.
The pinned official CDK CLI removes the application before its backend using its
standard deployment-role assumption and same-account fallback. A small temporary
assembly pins the verified physical stack ARN without re-synthesizing application
code, publishing assets or changing the deployed CloudFormation service role.
The temporary files are removed on success or failure. Ordinary destruction does not
need application `Outputs`, database access, an empty Events table or a durable
drain marker. It also works after initial `CREATE_FAILED`, `ROLLBACK_COMPLETE`,
`ROLLBACK_FAILED` or `DELETE_FAILED`, and can resume when one stack is already gone.
Wait for any create/update/rollback operation to finish before retrying.

After confirmation and before stack removal, the CLI empties exact S3 buckets
from the verified CloudFormation inventory whose deployed deletion policy is
`Delete`. This also handles failed initial deployments where the CDK cleanup
provider is unavailable. Each request pins the expected AWS account owner; project,
environment, CloudFormation stack ID and logical ID tags must match. Ownership is
checked again before each object-deletion request. Cleanup removes all object
versions and delete markers, then verifies that no versions remain. Ordinary destroy
leaves `Retain` and `RetainExceptOnCreate` bucket contents untouched.

The actual CLI caller needs `cloudformation:DescribeStacks`,
`cloudformation:GetTemplate` and `cloudformation:ListStackResources` for the owned
stacks, `s3:GetBucketTagging` and `s3:ListBucketVersions` on the exact owned buckets,
and `s3:DeleteObject` and `s3:DeleteObjectVersion` on their objects. Permissions on
the CloudFormation execution role alone do not authorize these direct CLI calls.
The CLI does not require `s3:ListAllMyBuckets`, change bucket policies, directly
delete bucket containers, or discover cleanup targets by a global name prefix.
Denied access, missing or mismatched ownership tags, incomplete inventory, object
deletion errors or failure to empty a bucket stop stack removal. Resolve the exact
reported failure and stop any active writers before retrying; already deleted
objects are not restored.

The default deployed policy deletes stack-owned DynamoDB tables and all their rows,
Cognito accounts, S3 objects, CloudFront distributions and managed logs. Only an
explicit `CDK_PARAM_RETAIN_DATA_TABLES=true` deployment retains its data tables.
CloudFormation uses the policy already deployed: changing source or `.env` alone
does not update an existing stack. Retained resources can continue to incur charges.
CDKToolkit, its shared assets, competitor bootstrap roles/stacks and separately
deployed exercise resources are outside platform destruction.

For retained data cleanup, use `make destroy-all ENV=development`, equivalent to
`make destroy ENV=development CLOUD_ARGS="--purge-retained-data"`. It first captures
exact CloudFormation-owned bucket, table and log identities, verifies ownership,
and shows the permanent deletion scope. After confirmation, it empties the owned
buckets, including retained object versions and delete markers, then deletes the
owned tables and CloudWatch logs. Bucket containers with a deployed `Retain` policy
remain; the CLI only empties their contents. It then resets the selected deployed
Turso control-data rows if applicable and removes the AWS stacks.
A failure in that pre-deletion purge or Turso reset
stops stack removal. After the stacks are gone, it deletes the same captured log
groups again to remove logs recreated by S3 cleanup providers during deletion.
No additional log names are discovered. If this final log pass fails, the error
explicitly says that the stacks are already removed; use the saved inventory for
operator-reviewed recovery instead of assuming the command can rediscover them.
Turso reset happens while the stack's SSM authentication is still available and
preserves the database schema and migration state. Ordinary `make destroy` leaves
external Turso rows and warns about them. The deployed provider and Turso target
come from stack outputs, never from a subsequently changed local `.env`.

To inspect an existing deployment without changing it, run:

```bash
make -s destroy ENV=development CLOUD_ARGS="--plan" > teardown-plan.txt
```

Save the printed physical-resource inventory before destroying stacks. The plan
records exact table/stack ARNs, owned bucket identities, deployed retention policies,
deletion protection, owned log groups and every retained resource's physical ID/type/stack identity,
including retained S3 buckets and Cognito pools. It does not scan table contents, discover tables by prefix,
modify protection, or delete resources. If both stacks are gone, the CLI cannot
prove ownership of orphaned retained resources and refuses a purge; use the saved
inventory for an operator-reviewed recovery instead of adopting resources by name.

A deployment made with the previous unconditional retention/deletion-protection
policy still has those live settings. A source fix does not repair it. If the plan
shows `protected: true`, `destroy-all` stops before purging. Review the specific
table ARN and its CloudFormation ownership, explicitly authorize any required
protection change, and use a targeted stack update when the stack is updateable.
For a failed initial stack that cannot be updated, an operator must separately
review and perform the exact table's protection change. Rerun `--plan` to verify
protection is off, then run `destroy-all` with its explicit purge confirmation.
These commands never automatically disable live protection or change CDKToolkit.
Previously retained S3/Cognito resources also keep their deployed policies.
Ordinary destroy preserves retained bucket contents; explicit `destroy-all` empties
verified retained bucket contents while leaving `Retain` bucket containers and
retained UserPools in place. Save the plan before removing their stacks. Removing
those surviving containers or identities requires a separately reviewed operator
action using the exact recorded physical identities.

Competition cleanup is separate: finish the event's **Teardown** and verify its
problem resources are removed before removing the platform. `--drain-events` is
rejected: it belongs to the incompatible cloud-v1 intake model. To drain an existing
cloud-v1 installation, use its matching release before platform teardown. Ordinary
destroy does not require database access, application Outputs or a drain marker.
It does not delete separately deployed problem stacks, the source bucket,
CDKToolkit or competitor bootstrap roles/stacks.

Retention does not imply automatic reattachment on a fresh deployment. Save the
exact inventory and plan any import/recovery separately.

### Standalone Turso data reset

`make turso-reset ENV=development` restores the standalone data cleanup command,
even after both AWS platform stacks are gone. It uses the selected environment's
`CDK_PARAM_CONTROL_DATA_BACKEND=turso`, database URL and exact SSM SecureString
parameter, plus the selected AWS account and region. The parameter must still exist
and be readable. The command prints that target, recognized tables and remaining
deployment count, then asks once before deleting rows. Stop application writers and
complete exercise Teardown first: deleting deployment records can orphan exercise
resources and does not remove them or any AWS platform stacks.

`CLOUD_ARGS="--plan"` performs only credential/schema/count reads;
`CLOUD_ARGS="--yes"` explicitly approves unattended deletion. Original/restored Lite
and published cloud-v1 schemas are supported; unknown or ambiguous schemas stop
before writes. Known-empty retired tables may coexist with restored Lite tables.
Only the selected layout's known data tables are reset in one write transaction;
table definitions, migration/schema markers and unrelated rows remain. Custom
triggers or references from unrelated tables stop the reset for operator review.
A failed request is not reported as success; inspect the database before retrying
if a lost response leaves the commit outcome unknown.

The old `tenkacloud turso-live reset` alias reaches the same command. For direct Bun
execution, use `bun run --no-env-file scripts/tenkacloud.ts turso-live reset`.
`make local-reset` continues to rotate only the local organizer key.

## Update the problem catalog

`make submodule-latest` fetches and stages the problem-source pin in this checkout;
it does not update a running installation. Review it between events:

```sh
git -C problems rev-parse HEAD
make submodule-latest
git diff --cached --submodule=log -- problems
make validate-problems
make deploy ENV=development
```

The submodule command accepts equal or fast-forward history and refuses dirty,
older or divergent selections. Skip it when deliberately using another reviewed
pin; stage that pin before validation. Preserve the original checkout for local
events that must resume; see [local updates](../docs/local-hosting.md#update-the-problem-catalog).

`make deploy` rebuilds both applications, prepares/uploads the source bundle and
updates the selected compatible stacks. Use the existing account, region,
environment and database configuration. `make build` only builds local artifacts.
There is no catalog-only hot-refresh command. For a console pipeline, update its
reviewed source refs and start a deploy build; editing launcher parameters alone
does not publish those changes.

Cloud deployment snapshots the effective catalog maps, hints, plugin bundles and
raw problem sources in a private, content-addressed execution-artifact bucket.
Saved events and deployments retain `catalogKey`: an event created with catalog A
continues using A after B is deployed or the problem is removed from B. Lambda
readers verify the saved source hashes; CodeBuild reads the saved archive key and
`VersionId`. Request-specific catalog selection does not mutate the runtime's global
catalog. The execution-artifact bucket is platform-owned and follows platform
teardown; the separate source archive bucket has the longer lifecycle described above.

Older saved data without a catalog pin fails closed. Set `CDK_LEGACY_CATALOG_KEY`
only after recovering and verifying the exact original immutable snapshot in the
execution-artifact bucket. Do not guess by assigning the current catalog, and do
not treat this recovery setting as a state/schema migration. This recovery setting does not authorize upgrading an active original installation; finish its competitions on the installed version and satisfy the no-active-events preflight first.

An update does not migrate saved state or automatically update all team problem
stacks. Keep the original revisions and both kinds of artifacts needed by unfinished
events. Rehearse the new revision in a test event, including participant access,
scoring and cleanup. Adding a template does not bypass the `TemplateBody` size
limit or turn a Docker problem into a cloud runtime.

## Competitor accounts and participant access

Use the existing Competitor Accounts screen and
[account onboarding guide](../docs/competitor-account-onboarding.md). Registration
and verification use the displayed control-plane account, role name and required
ExternalId; they do not create competitor trust automatically. Install the named
bootstrap IAM role once per competitor account, in one bootstrap region.

Teams may use separate competitor accounts or the same competitor account with
different problem regions. Regional allocation still shares global IAM and other
account-wide services; regional assignment is functional support, not proof of
complete IAM isolation. AWS resource exercises require a competitor account separate
from the platform hosting account. Hosting-account targets are rejected before
resource mutation, with guidance to register and verify a separate account;
participant STS also denies the hosting account. Same-hosting-account exercises
remain unsupported and unverified. The catalog IAM review has unresolved findings;
restoration does not certify every problem's least-privilege policy.

Participant Console and CLI access use the problem's participant role and current
event/team/deployment checks. Never distribute the privileged deployment role.
Ending an event or revoking a key blocks applicable new access but cannot instantly
revoke already-issued AWS credentials. Rehearse the specific problem's access policy
and credential expiry.

### ExternalId recovery

The restored backend keeps ExternalId in its existing environment/installation SSM
path. Preserve that parameter and the competitor trust relationships during event
operations. If verification reports a missing or mismatched ExternalId, use the
original value and reviewed recovery procedure; do not replace it merely to make
verification pass. Do not copy secrets into source, logs, tickets or screenshots.
Finish problem teardown before unregistering accounts or removing their bootstrap
roles. Serialize account registration/unregistration operations and verify the
connection afterwards; the historical SSM registration lifecycle is retained.

## Native Cryptography Battle

Native coordination reuses the original backend and shared problem reducer. Cloud
state and scores live in the selected Turso or DynamoDB repositories; local state
continues to live in SQLite. The reviewed `ac26-crypto-battle` profile with
`defaultScoreStealEnabled=false` runs without Docker or a competitor AWS account.
Setting the problem's score-steal parameter to true keeps its AWS-backed variant;
that variant and mixed events with AWS problems require a separate competitor
account. Catalog metadata alone does not qualify other plugins as account-free.

The original SQL 4 MiB state policy and 99-team event admission are retained. State,
private team views, scoring, reset and event teardown must be tested against the
selected problem and provider. A limit or successful database read benchmark does
not establish synchronized Battle capacity on hosted Turso or AWS.

## Verification

Offline regression checks cover both providers, the original persistent resource
logical IDs, the restored API/frontend contracts, source-bundle preparation,
installation discovery/compatibility, saved-catalog continuity after update/removal,
private source identity and owned-resource teardown. These are source/test restoration
results; they do not show an AWS deployment or hosted Turso event. SQL protocol
[verification against an official local libSQL server](test/cloud-hosting/evidence/libsql-restored-20261003.json)
passed with 25 teams and 100 concurrent authentication reads (p95 186 ms). This is a local storage result,
not hosted Turso or AWS performance evidence.

Live AWS deployment, participant federation/STS, hosted Turso and a full cloud event
remain operator-owned rehearsals. No live account change, deployment or cleanup
is implied by source tests or synthesis. The nine oversized canonical templates
remain a known historical limitation. See the
[event rehearsal checklist](../docs/host-rehearsal.md) for recording actual results.
