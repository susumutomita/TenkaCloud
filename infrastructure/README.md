# Cloud hosting

This unreleased integration candidate uses Lambda, Cognito, CloudFront and CDK
with a choice of Turso or DynamoDB for the supported cloud exercises below.
Local hosting remains SQLite. No SBT, tenant provisioning or tier plans are included.
Source, synth and local rehearsals do not establish live AWS authorization, costs
or the capacity of a particular event.

## Implemented vertical slice

- Event creation with atomic event, team, access-key, and response-receipt persistence
- Organizer event list/detail, explicit credential expansion, rotation and revocation
- Participant authentication, team-keyed state queries, and transactional scoreboard projections
- Existing organizer and participant HTTP response contracts
- REST API Gateway Cognito signature verification and client-audience pinning
- Lambda issuer, audience, ID-token, expiry, and explicit role validation
- Invitation-only organizer sign-in with mandatory TOTP and no self-assigned role
- Conditional atomic persistence in the selected database and private SPA hosting
- Existing SPA builds and standard CDK bootstrap/asset publishing, deploy, and guarded foundation teardown
- Existing competitor-account registration, verification and event-selection flow
- AWS flag deployment intake, durable dispatch, fenced lifecycle, and atomic scoring
- Standard Step Functions polling plus owner-fenced terminal-execution reconciliation
- Native Cryptography Battle using the pinned shared reducer, durable snapshots and atomic score/receipt updates

The actual frontend selects the ID token. `Admin` and `Operator` can create events
and rotate keys; only `Admin` revokes access. `Viewer` can read ordinary event
information but cannot reveal keys. No token or missing role is promoted to Admin.

The console runtime config advertises the selected database's event limits:
Turso supports 99 teams and DynamoDB supports 48, with up to 50 problems on either
provider. The API and repository enforce those same limits. DynamoDB event creation
writes one event, two rows per team, one creation receipt and an installation-intake
condition: 48 teams use 99 transaction items; 25 teams use 53. SQL keeps all event,
team, access-key and receipt writes in one atomic batch without that item ceiling.
Native Battle preserves the SQL 4 MiB snapshot policy and 99-team roster; DynamoDB
keeps its 2 MiB chunked snapshots and 48-team roster so state, all scores and the
receipt can commit atomically. Existing 49-team DynamoDB events remain readable and
removable. These are admission limits, not live-event performance measurements.

## Historical schema and reuse

The source reference is commit `825415fc`, particularly the former
`scripts/tenkacloud-lite.ts`, `prepare-source-bundle.sh`, `package-source-bundle.sh`,
event create/key-rotation handlers, event/team repositories, and participant
bearer/leaderboard contracts. Public names now say cloud hosting.

- Events retain `PK = EVENT#<eventId>`, `SK = META`
- Teams retain `PK = EVENT#<eventId>`, `SK = TEAM#<teamId>`
- Deployments retain `PK = DEPLOYMENT#<jobId>`, `SK = META`, and deployment scores
- Strongly consistent `ACCESS#<SHA-256>` lookup rows live in the teams table
- Events use installation-wide GSI1 listing; deployment GSI1 is event-scoped

The physical primary-key families are preserved, but this is not an automatic
migration of a retired deployment. Tenant indexes are removed, auth versions and
hash lookup rows are added, and access is checked against the current team row.
Old deployment-GSI bearer authentication must not be reintroduced beside this path.
Deployment score and ledger remain authoritative. Separate `SCORE#<teamId>` rows
are derived scoreboard projections updated in the same scoring transaction. Key
rotation only replaces `TEAM#` metadata and cannot erase a score projection.
`completedProblems` means solved problems, matching the portal contract: deployment
readiness leaves it at zero; the first correct flag increments it in the same
score/ledger/receipt transaction; retries and already-solved submissions do not.

History has no DynamoDB TTL. Expiry limits participant access without deleting
results. Team plaintext keys remain private organizer credential material for the
existing creation/explicit-reveal contract; neither listing nor participant views
include them. Rotation/revocation uses one conditional transaction and invalidates
the prior lookup immediately.

## Database selection

Set `CDK_PARAM_CONTROL_DATA_BACKEND=dynamodb` (the default) or `turso` in the
selected environment's `.env`. The values are normalized as in the former cloud
implementation. Turso additionally requires:

```dotenv
CDK_PARAM_CONTROL_DATA_BACKEND=turso
CDK_PARAM_TURSO_DATABASE_URL=libsql://your-database.turso.io
CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=/tenkacloud/turso/auth-token
```

The URL is configuration, not the token. The token must already exist in the
chosen AWS region's SSM Parameter Store. Its creation and credentials are an
operator setup step; no token is accepted in browser configuration or source.
Before bootstrap, builds or AWS deployment, `make deploy` reads that exact SecureString
with the selected AWS identity and runs an authenticated `SELECT 1`. Missing, invalid
or expired credentials stop deployment without creating database tables or changing
AWS resources. The token is never printed. DynamoDB skips this Turso-only check.
The selected environment is also applied to in-process AWS SDKs. Use either an
AWS profile or environment access keys (with `AWS_SESSION_TOKEN` when required).
Unlike the old CLI-only precedence, mixing a profile with access keys is now
rejected before AWS access because the CLI and JavaScript SDK choose different
sources. Unset the unused source; credential values are never included in the error.
`AWS_DEFAULT_PROFILE` is accepted as an alias; if both profile variables are set,
they must name the same profile. No credentials or profile files are changed.
Turso handlers receive permission to read that exact parameter. Turso mode creates
zero DynamoDB tables and grants no DynamoDB runtime access. DynamoDB mode preserves
the three on-demand tables and does not require a Turso URL or token parameter.

Both providers implement event/team authentication, deployment work, competitor
registrations, durable dispatch, scoring receipts and native Battle state. Turso
uses the existing official HTTP client and SQL transactions with conditional
rollback. Authorization reads are routed to the primary in one write batch;
this avoids replica-local stale authorization after a completed key revocation,
but adds primary transaction contention. A request already in flight can finish.

The current SQL schema uses installation-owned `cloud_*` tables. It does not
migrate old tenant-based SQL or DynamoDB data. `make deploy` rejects a backend or
Turso URL change for an existing installation before mutation. Ordinary destroy
uses the deployed identity even if the local environment file has changed.
Do not share this installation's database with a second TenkaCloud installation.

The repeatable local protocol rehearsal starts an explicitly supplied, installed
[official sqld](https://github.com/tursodatabase/libsql/releases/tag/libsql-server-v0.24.32)
primary and replica on loopback, then removes its synthetic database:

```bash
node --import tsx infrastructure/verification/libsql-protocol-check.ts /absolute/path/to/sqld
```

It downloads nothing and uses no hosted endpoint, AWS account or credentials.
The [2026-10-02 evidence](test/cloud-hosting/evidence/libsql-protocol-20261002.json)
uses sqld 0.24.32 and `@libsql/client/http` 0.17.4: 25 teams and 100 concurrent
authentication reads completed in 504 ms (p95 502 ms), plus canonical Crypto Battle
operations/projections, real proxy-constraint rollback, exactly-once scoring and
receipts, primary-routed authorization, restart durability and scoped reset.
During primary outage, replica-local SELECT remained available while repository
authentication failed closed. These measurements do not establish hosted Turso
availability, WAN replication fault behavior or production capacity.

## Cloud deployment pipeline

[`templates/cloud-pipeline.yaml`](templates/cloud-pipeline.yaml) remains the one
complete launcher. Its `current-cloud-v1` source contract runs the current
`make deploy`, `make destroy` and `make destroy-all` with standard CDK bootstrap roles.
The launcher retains the former broad CodeBuild caller policy; review its IAM,
service access and selected source refs before creating it or starting a build.
The final template pins its tested helper-source
commit and catalog `4bb3a116c545fc46ed6a39ffcc5117fb914947f4`; the exact values and
release classification are in `Mappings.SourceDefaults`. Creating the launcher
also creates its CodeBuild role and log group; it does not start a build.

Custom platform/catalog repositories and refs remain selectable. Current catalogs
must contain the reviewed hello-world and ac26-crypto-battle artifacts. The build
checks the selected source protocol and rejects incompatible current settings
before application deployment. It does not make arbitrary pack runtimes executable.
Current deploy builds run the same ordinary `make deploy`: they reuse a compatible
`CDKToolkit`, or create the missing standard toolkit and deploy with the reviewed
build role, using `--require-approval never` without an extra prompt or flag.
First bootstrap defaults to an `AdministratorAccess` CloudFormation
execution role. The CodeBuild caller retains its broad permissions after bootstrap;
this is not a least-privilege launcher. The selected Turso/DynamoDB provider and
explicit data-retention setting are passed to the same CLI used locally.
DynamoDB uses on-demand capacity; provisioned-capacity options and a shared
ExternalId override are rejected rather than silently ignored.

The launcher has one current execution path. Source overrides must implement its
checked contract; changing source or database settings is not a data migration.
See [permission boundaries](BOOTSTRAP-IAM.md).

## Current checkout's setup and teardown boundary

`make deploy` and `make destroy` call the existing `scripts/cloud-hosting/main.ts`
implementation in this checkout. They use this checkout, rather than an implicitly selected historical source. The current cloud exercise catalog supports hello-world with scoped CLI
access and native Cryptography Battle. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. First-account IAM preparation is explicit and inspectable, as described below. The DynamoDB Local 100-participant burst took 5.910 seconds, exceeding the five-second refresh interval; this is not an AWS measurement;
the presence of its routes is not a 100-participant capacity claim. These commands can create chargeable AWS resources; they do not
promise a zero-cost platform.

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
`--require-approval never` and requires no additional flag or confirmation, including
in CI. Existing toolkit configuration is unchanged.

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
for ordinary deployment. Review the target and [permission boundaries](BOOTSTRAP-IAM.md#first-account-setup)
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

Use `make destroy` with the same account, region and environment. It verifies both
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

Competition resource cleanup is a separate operation: use the event's Teardown
action before removing the platform when needed. The optional
`CLOUD_ARGS="--drain-events"` explicitly includes stopping intake and cleaning up
recorded competition resources before platform removal. This flag uses the durable
installation marker and requires the deployed control version, database and native
artifact metadata. Failures keep the platform available and intake stopped;
repeat the same explicit command after resolving the event diagnostics. Ordinary
`make destroy` does not acquire those new requirements or silently expand its scope.

An existing app stack must publish `CloudRunnerEnabled=true|false` for deployment
updates. Registry deployments also publish `CloudRunnerMode` and a digest of legacy
bindings. `up` refuses to omit or change deployed legacy credentials, or to reopen
an installation whose explicit event drain has started.

Current deployment builds the two existing SPAs and lets CDK publish their assets
and the execution artifacts. It creates no additional source ZIP, staging tree or
source-bundle bucket: the current stacks have no consumer for that former path.
It does not replace the selected problem catalog with a submodule checkout.
Historical pinned launchers still run their own source preparation. Any buckets
created by those older paths are not silently adopted or deleted by this CLI.

Retention does not imply automatic reattachment on a later fresh deployment; an
explicit import/recovery procedure is still required.

## Update the problem catalog

`make submodule-latest` only fetches and stages the problem-source pin in this
checkout. Review it before applying it to cloud hosting:

`submodule-latest` follows the configured `main` branch unless overridden in the
submodule settings, but rejects older or divergent targets before checkout or staging.
Only equal or fast-forward history is accepted. Dirty problem sources or an
unstaged pin selection are also refused without discarding work. Keep a reviewed
trial pin until the tracked branch can advance it without dropping commits.

```sh
git -C problems rev-parse HEAD # record the old catalog commit
make submodule-latest
git diff --cached --submodule=log -- problems
make validate-problems
make deploy ENV=development   # use the existing installation's environment
```

Skip `make submodule-latest` when you have intentionally selected a different
catalog commit, and stage that selection with `git add problems` before
`make validate-problems`: validation aligns the submodule to the staged pin.
Review uncommitted content edits separately with `git -C problems diff`.
If the same checkout hosts local events, preserve their original sources as
described in the [local update procedure](../docs/local-hosting.md#update-the-problem-catalog).

`make deploy` rebuilds both browser applications from this checkout, then CDK
publishes the content-addressed catalog/templates/plugins and updates the existing
application/backend stacks. Use the same account, region, environment and database
configuration as the existing installation. This is a normal CloudFormation
update of changed assets and resources; it does not require destroying and
recreating the installation. `make build` alone only creates local artifacts.
There is no supported catalog-only hot-refresh command: both the browser's
build-time catalog and the server's execution artifacts must agree.

For the console pipeline, update `ProblemsRepoRef` to the reviewed full commit
SHA and start a new deploy build. Updating launcher parameters alone does not
publish the catalog. Each build fetches its configured refs, so a branch follows
new commits while a full SHA remains fixed. Keep the chosen platform/catalog
pair recorded and rehearse it before an event.

Apply changes between events or rehearse them in a separate installation.
Publishing a new catalog does not upgrade previously deployed team problem
stacks or migrate saved runs. Pending AWS jobs retain their catalog key and old
content-addressed artifacts, but this is not a guarantee that every existing
event can continue: native Battle runs reject a changed catalog key, and
participant AWS access rejects a template digest that no longer matches the
currently reviewed catalog. Do not update an active event's catalog expecting
its saved state to migrate. Create a new test event against the new revision and
verify deployment, participant access and scoring. Supported runtimes remain
hello-world and native Cryptography Battle; adding source files does not make
other cloud runtimes executable, and Docker/Compose remains local-only.

## Verification

- CLI subprocess tests use injected calls; no AWS or CDK deployment executes
- CLI tests assert that no extra source bucket, archive, or catalog checkout is invoked
- Injected drain tests cover partial failure, interruption, physical-ARN deletion,
  backend-only recovery, closed-intake updates and retained-data boundaries
- API tests exercise role/key/event boundaries and the real REST Lambda adapter
- Frontend contract tests use its real bearer client and role decoder
- CDK tests synthesize and bundle the real API, inspect IAM/auth/retention, and read
  the generated runtime-config asset; no context lookup or AWS call is used
- `make audit-deps` passes without a baseline or guard change

The opt-in real-storage check is:

```sh
bun run --cwd infrastructure test:dynamodb-local http://127.0.0.1:18654
```

It accepts only an explicit IPv4 loopback endpoint and uses fixed public dummy
credentials. Start the official vendor distribution with
`test/cloud-hosting/LoopbackDynamo.java`; that launcher binds Jetty to loopback
before starting, disables telemetry, and uses memory-only storage. Obtain and
verify the vendor archive using the
[official download instructions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html).
The 2026-10-01 evidence is in
[test/cloud-hosting/evidence/dynamodb-local-20261001.json](test/cloud-hosting/evidence/dynamodb-local-20261001.json).

On official DynamoDB Local 3.3.1, atomic creation/rotation/revocation tests and 100
concurrent authentications across 25 teams passed. These are storage/auth checks,
not AWS latency measurements or scoring-capacity validation.

## AWS flag execution

The narrow source-wired path reuses the old deploy/flag HTTP contracts and the
CloudFormation Lambda plus Step Functions sequence. It does not restore the old
backend wholesale. The real `hello-world` flag challenge and native `ac26-crypto-battle` are in the
execution catalog. Container execution, AWS endpoint Battles, multi-flag AWS
challenges, hints and force-redeploy are not
silently mapped to this implementation.

The existing Competitor Accounts screen uses the restored
`/admin/competitor-accounts` list/create, bulk, verify and delete contracts. Only
Admin can change registrations; the three organizer roles can list them. New
registrations use the installation's fixed `competitorRoleName` from runtime
config. The existing [competitor bootstrap template](./templates/competitor-bootstrap.yaml)
is served as one public, secret-free S3 object for the screen's CloudFormation
Quick-create link. No second bootstrap template or account-management app exists.
The [account setup guide](../docs/competitor-account-onboarding.md) covers the
existing individual-account path and centralized Organizations StackSets rollout
to an explicitly selected set of accounts, with automatic deployment disabled.
Both paths use this same template; the named global IAM role is created in one
bootstrap region per account.

Each remote operation requires the exact installation role name, Purpose and
Installation tags, mandatory ExternalId and current verification. The platform
account is refused by the API/worker and by explicit role-assumption IAM denies.
Registration verification establishes the connection's identity and trust; it
is not a certification that sharing an AWS account safely isolates participants.
Teams may use separate accounts or the same account in different deployment
regions. Registration verifies the global IAM role once; each event/team pins its
own supported commercial region for the connection and job. The host keeps its
ExternalId parameter and pinned artifacts in the hosting region, then submits
the verified template body to CloudFormation in the team's region.

Region assignment alone does not isolate global IAM or every AWS service.
Hello-world's legacy metadata-listing permission has a documented dedicated-account
assumption; the cloud participant CLI slice below explicitly denies that permission
and restricts reads to the owned parameter ARN. Console/CloudShell access and
arbitrary problems require their own permission review.

The focused local check, `bun run --cwd infrastructure test:dynamodb-work
http://127.0.0.1:18657 --accounts-only`, exercises the existing SPA clients and
actual DynamoDB Local transactions. It verifies one account registered in
`us-east-1` with separate teams in `us-west-2` and `ap-northeast-1`, two durable
connections/jobs, exact deployment replay and pending-job teardown. It also keeps
the 25-account registration, revocation and concurrent deletion checks. STS/SSM
are injected for this test; it does not deploy AWS exercise resources.

### Participant hello-world CLI access

The existing `GET /portal/me/cli-credentials?jobId=...` contract issues only the
owned hello-world viewer's temporary credentials. It rechecks the current team
key/authVersion, event schedule, installation stop marker, target attempt,
connection and verified registration before and after remote I/O. A completed
creation receipt must bind the original physical stack ARN and immutable request
fingerprint. CloudFormation ownership tags and `DescribeStackResource` bind the
exact `ParticipantViewerRole` resource, without guessing its generated name.
A final condition-only DynamoDB transaction checks all current authorization
rows together immediately before credential release. Changes during the earlier
sequential reads cannot authorize a stale response. Revocation after this atomic
decision point has the already-issued credential lifetime described below.

The operator principal assumes that viewer directly with the job ID as ExternalId.
The deployment-role probe uses the retained installation ExternalId; its
credentials and secret never reach participants. The fixed inline STS policy permits
only `ssm:GetParameter` and `ssm:GetParameters` on the one exact
`/<stack-name>/hello` parameter. Explicit denies exclude other resources and all
other actions, including metadata listing, role chaining and CloudShell.
The API returns `no-store` responses and fixed public errors, with no secret logs.

STS sessions last at most 15 minutes; the inline policy also denies use past the
known event/team/job expiry. Revoking a team key, registration or bootstrap role
blocks new issuance but does not instantly revoke already-issued viewer sessions.
Responses and UI must not claim otherwise. The participant projection advertises
only `cli-credentials`; Console requests return `409 aws_console_unavailable`.

This path requires five explicit viewer ownership tags in the pinned canonical
hello-world template. Older deployments without these tags deny issuance; the
platform does not silently change existing roles. The role's existing operator
trust and problem permissions are unchanged; the additional inline STS policy
narrows each set of issued credentials.

The existing EventCreate account selection now creates the durable team connection
when deployment is requested. Its explicit `registrationId` distinguishes registry
connections from old exact bindings, including old binding IDs starting `account-`.
Connection/reference writes and account-deletion fences commit atomically. An
account cannot be removed while any referenced event has unresolved resources;
archived events must have matching expected/completed teardown counts. A delete
never removes the shared ExternalId or the competitor-owned bootstrap role.

`TENKACLOUD_RUNNER_BINDINGS` is retained only for existing exact-bound jobs. Its
reviewed role/SSM grants and content-addressed private bindings object remain
explicit, rather than silently falling back to another account or secret.
`CloudRunnerMode` and `CloudLegacyBindingsDigest` identify the generated mode and
compatibility set. Templates/catalogs are content-addressed and retained for
pinned jobs. New installations use the registry and do not need a second manual
binding-management step.

### ExternalId recovery

The shared SecureString remains in SSM; no value is stored in the registry,
logs or verification artifacts. The Events table retains an `EXTERNAL_ID` marker
under `INSTALLATION#ACCOUNTS`, even after every account is removed. First-time
initialization reserves that marker before creating a parameter. Existing
accounts, connection references or job snapshots prevent missing-key generation.
The API's additional Scan permission is limited to the Events and Deployments
tables and is used only for this missing-key recovery check, not participant polling.

- If the exact SecureString still exists, retry the original registration. The
  service records its use and reuses it, including after a marker-write interruption.
- If only an `INITIALIZING` marker remains and the parameter is absent, stop new
  registration attempts and establish that earlier initialization calls have ended.
  An authorized operator must check the registry and retained connection/job
  references. Only a confirmed never-used, empty store may be explicitly initialized
  by that operator at the exact `CompetitorExternalIdParameterArn` output. Then retry
  registration; there is no need to delete the marker.
- If the marker is `INITIALIZED` or any registration/reference remains, restore the
  original key through the approved secret-recovery process. If that is impossible,
  all affected trust relationships need a separately reviewed recovery. Never erase
  the marker or create a replacement value merely to make verification pass.

No lease expiry, older parameter version, automatic secret rotation, or last-account
cleanup can reset this boundary. These are recovery instructions, not AWS actions
performed by this implementation task.

`POST /events/:eventId/deploy` persists job/target/receipt/dispatch intent before
execution. A scheduled dispatcher starts a Standard workflow with deterministic
name and input; uncertain sends retain the intent. Claiming atomically removes
that intent and fences the current attempt/owner. Create/describe verifies stack
ownership tags and the immutable request fingerprint. Different attempts cannot
silently adopt, update, delete, or duplicate a prior stack. Failed resources remain
for explicit owned cleanup, with prior attempt records retained on retry.

Completion/failure is conditionally persisted. Global timeout, abort and failed
execution events are checked against authoritative `DescribeExecution` and the
current job owner/attempt before reconciliation. Event delivery and retry remain
operational dependencies; this is not a substitute for an operator recovery view.

`PATCH /events/:eventId/schedule` restores startNow/start/end/freeze controls, and
lock-scoring retains the existing POST/DELETE paths. An absent/invalid start time,
ended event, scoring lock, stale attempt or revoked key blocks flag scoring.
`POST /portal/me/submit-flag` commits job score, ledger, receipt and derived team
projection together with current event/team/auth-version checks. Private flag
outputs are hashed server-side and never returned to the portal or workflow state.
`GET /portal/me/score-events` queries the team-scoped ledger index with a bound.

Creation, bulk deploy and flag submission accept `Idempotency-Key`. The same key
and body replay the saved response; changed content returns 422. Header-less
legacy requests receive fresh operation keys. A deliberate new wrong-answer
submission uses a new key and applies its penalty again; a network retry keeps the
original key. The AWS flag score has the challenge's explicit zero floor. This
does not change the signed penalty model of local Docker problems.

The executable acceptance suite is `bun run --cwd infrastructure test:dynamodb-work
http://127.0.0.1:PORT` (use one line). Its browser-client imports use a separate
strict Bundler-resolution verification project; backend NodeNext settings remain
unchanged. Both projects run in the workspace build/typecheck commands. The
verification alias for `@tenkacloud/web-kit` points to the actual API-client source,
not replacement declarations or a mock client.

The saved evidence is
[test/cloud-hosting/evidence/dynamodb-work-20261001.json](test/cloud-hosting/evidence/dynamodb-work-20261001.json).
At 100 participants, 25 teams and 20 problems per team, two actual HTTP polling
rounds use the frontend's 30-second interval. Each round makes 200 HTTP requests
and 1,000 SDK commands, reading 7,000 query rows plus 700 point reads. Participant
state reads 20 team jobs; leaderboard reads 25 teams and 25 score projections.
No participant refresh queries all 500 event deployments. These are actual local
DynamoDB/HTTP observations, not AWS latency, RCU or billing guarantees. Notification
and Battle polling are outside this flag slice.

## Native Cryptography Battle

The selected `ac26-crypto-battle` problem uses the existing shared coordination
reducer, without a VM or a competitor AWS account. The execution catalog pins its
plugin digest and schema. Native runs are separate from AWS deployment jobs and do
not fabricate account IDs, regions, stack ARNs, or AWS access controls. Mixed events
still need verified competitor accounts for their AWS problems.

DynamoDB uses the existing Deployments table for a small versioned HEAD and bounded
snapshot chunks; Turso stores the same match in SQL head, snapshot and history rows.
A successful transition atomically writes the snapshot, team score deltas,
ledger and operation receipt, with current event/team/intake checks. One event has
one authoritative shared match; it is not split into independent per-team games.
Short expiring admission on that same HEAD reduces conflicting snapshot writes.
Expired/replaced owners cannot commit; interruption does not require a permanent
manual claim reset. Read-only no-op/replay paths recheck authorization atomically.
No game-clock rounding or tick coalescing is used, because tick spacing can change
this problem's scoring outcomes.

An `Admin` or `Operator` can start a fresh match with
`POST /events/:eventId/problems/:problemId/coordination/reset`. The optional
`runId` body field fences an operator's previously read run; the response contains
the new `runId` and `previousRunId`. Reset is refused after event end. A concurrent
reset or changed publication returns a conflict instead of resetting the winner.
The new match keeps the reviewed plugin/schema pin and the original event clock,
with a fresh secret. Its initial native score replaces the previous native subtotal
in the same transaction, preserving scores from other problems and solved counts.

The current run and two previous snapshots remain readable through the storage
adapter. Retiring a run deletes its private snapshot and operation receipts;
score-event audit records remain. An interrupted cleanup keeps a durable obligation
that the next reset or explicit cleanup retry must finish before another rotation.
Existing DynamoDB snapshot keys remain readable across the first reset; later runs
own separate chunk keys. SQL archives the previous snapshot in the same atomic
batch that publishes the new run.

Participant operations carry their displayed job ID as `runId`, including retries.
A stale run returns `coordination_run_changed` without applying the operation to
the replacement match. Legacy callers can omit `runId` only before the first reset.

Organizer Prepare initializes the native run. Start, scheduled end, scoring lock,
End Event and coordinated teardown use the same durable state. End settles and
closes the match; it does not delete AWS resources in a mixed event. Optional
platform teardown with `--drain-events` verifies native closure as well as AWS
cleanup before recording DRAINED. Ordinary platform destroy does not require
native closure or access to the control-data database.

The organizer's explicit event DELETE removes the closed native match snapshots,
match secrets and operation receipts after every resource teardown request is accepted.
It retains a permanent verified run manifest, team totals, score history and shared
plugin/catalog artifacts. End Event keeps the closed projection and retained runs.
SQL performs the private-data removal atomically. DynamoDB records a pending purge
before deleting bounded pages; an interruption retains that obligation and the
same event teardown action resumes it. Pending cleanup never reports completion.

Optional platform drain retains native payloads in external Turso. Starting a new
event purge must precede global drain: once installation intake closes, a new purge
returns `coordination_purge_intake_closed`. This preserves the drain's settled-data
check. A previously recorded purge continues during DRAINING or DRAINED, and a
completed purge remains idempotent. Explicit `destroy-all` still removes all owned
control-data rows, including the retained manifests and run history.

The organizer scoreboard returns authoritative current team totals. Complete score
history, solved counts and per-problem averages are currently unavailable in that
cloud view and its report; they are identified as unavailable instead of inferred
as zero. Notifications, self-registration, progression-gate administration, capacity
controls, force archive and scheduled deployment/teardown are not offered by this
cloud console. Local-host capabilities retain their existing behavior.

The actual DynamoDB Local harness measures both staggered 100-participant/25-team
polling and simultaneous refresh/operation bursts. Staggered polling and durable
exactly-once scoring have passed; a synchronized 100-client burst still exceeds the
5-second plugin refresh interval. This is a documented capacity limitation, not an
AWS latency or cost guarantee. See the checked-in measurement evidence for the
final run, state sizes, p50/p95/p99, conflicts and request amplification.

The follow-up local measurement reduced SDK commands for the synchronized refresh
from 6,434 to 4,530, with all 300 HTTP responses successful. Completion took 5.910
seconds (participant refresh p95 5.698 seconds), so the five-second target remains
unmet. The harness now reports this as `consistency-passed-capacity-unmet` and exits
with code 2 instead of treating successful responses alone as sufficient capacity.
The complete run retained exactly-once scores through 100 operations, receipt
replays, revocation, interrupted ownership and final installation drain. Atomic
snapshot reads avoid retries for unrelated admission changes, and an exact
HEAD-only collision hint skips diagnostic reads; every retry still passes the
original event, team and intake transaction guards before running the reducer.

## Remaining acceptance work

- Reviewed exercise permissions for each supported account/region arrangement
- Participant AWS Console access without cross-team metadata disclosure
- Cloud-native catalog expansion, AWS endpoint Battles, hints and disruptions
- Public registration/claiming, audit, notifications and full organizer UI flows
- Native Battle burst latency under the target participant load
- External problem-pack execution and final tutorial alignment; built-in local
  course tracks already reuse the event's team progress and existing gates

Cloud hosting is still not competition-ready. No live AWS connection, bootstrap,
permission change, deployment, or billing action was executed for these checks.
