# Cloud hosting

This unreleased integration candidate uses Lambda, DynamoDB, Cognito, CloudFront
and CDK for the supported cloud exercises described below. Local hosting remains
SQLite. No SBT, tenant provisioning, tier plans or remote SQL backend is included.
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
- Retained, deletion-protected event/team/deployment tables and private SPA hosting
- Existing SPA builds and standard CDK bootstrap/asset publishing, deploy, and guarded foundation teardown
- Existing competitor-account registration, verification and event-selection flow
- AWS flag deployment intake, durable dispatch, fenced lifecycle, and atomic scoring
- Standard Step Functions polling plus owner-fenced terminal-execution reconciliation
- Native Cryptography Battle using the pinned shared reducer, durable snapshots and atomic score/receipt updates

The actual frontend selects the ID token. `Admin` and `Operator` can create events
and rotate keys; only `Admin` revokes access. `Viewer` can read ordinary event
information but cannot reveal keys. No token or missing role is promoted to Admin.

The console runtime config advertises `eventLimits: { maxTeams: 48, maxProblems: 50 }`.
These values share the API/repository source of truth. Event creation writes one
event, two rows per team, one creation receipt and an installation-intake condition.
Thus 48 teams use 99 transaction items; the target 25-team HTTP creation uses 53.
Existing 49-team events remain readable and removable.

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

## Cloud deployment pipeline

[`templates/cloud-pipeline.yaml`](templates/cloud-pipeline.yaml) remains the one
complete launcher. Its default `current-cloud-v1` source contract runs the current
`make deploy` / coordinated `make destroy` with standard CDK bootstrap roles.
The launcher retains the former broad CodeBuild caller policy; review its IAM,
service access and selected source refs before creating it or starting a build.
The final template pins its tested helper-source
commit and catalog `915fe862fe09bf6b63bb96edcf0cb3deddd54d37`; the exact values and
release classification are in `Mappings.SourceDefaults`. Creating the launcher
also creates its CodeBuild role and log group; it does not start a build.

Custom platform/catalog repositories and refs remain selectable. Current catalogs
must contain the reviewed hello-world and ac26-crypto-battle artifacts. The build
checks the selected source protocol and rejects incompatible current settings
before application deployment. It does not make arbitrary pack runtimes executable.
Current deploy builds pass `--setup-if-needed --yes`: they reuse a compatible
`CDKToolkit`, or create the missing standard toolkit and deploy with the reviewed
build role. First bootstrap defaults to an `AdministratorAccess` CloudFormation
execution role. The CodeBuild caller retains its broad permissions after bootstrap;
this is not a least-privilege launcher. Current builds reject Turso/provisioned-Dynamo
settings, shared ExternalId overrides and historical `destroy-all` semantics.

The advanced `historical-949a40a9` contract preserves the full original launcher at
platform `949a40a9ed9199331d928ad5cf9397dbb4ba3f81` and catalog
`363a7c9b83969e20d63b74fd0410a354da5e202b`, including historical backend/capacity
parameters, bootstrap, destroy/destroy-all, physical resource names and cleanup
checkpoints. Its original broad CodeBuild permissions and data-deletion behavior
require separate review. Selecting historical sources is not a migration to the
current cloud architecture. See [permission boundaries](BOOTSTRAP-IAM.md).

## Current checkout's setup and teardown boundary

`make deploy` and `make destroy` call the existing `scripts/cloud-hosting/main.ts`
implementation in this checkout. They use this checkout, rather than an implicitly selected historical source. The current cloud exercise catalog supports hello-world with scoped CLI
access and native Cryptography Battle. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. First-account IAM preparation is explicit and inspectable, as described below. Synchronized Battle bursts still exceed the five-second refresh interval;
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
command displays the bootstrap account/region and permission scope, asks for
first-bootstrap approval, runs the pinned official `cdk bootstrap`, then continues
the application deployment with the same credentials. Declining stops before
bootstrap changes or application builds.

Standard CDK bootstrap creates asset storage and publishing, lookup, deployment
and CloudFormation execution roles. Its default execution role uses
`AdministratorAccess`; the lookup role also has broad read access. These are
privileged deployment credentials, not application or participant credentials.
The first caller needs the official bootstrap permissions and ordinary deployment
permissions. An existing installation needs permission to use its standard roles,
read the toolkit/stacks and perform the CLI's direct invitation/teardown operations.
The CLI never attaches policies to its caller or switches credentials.

Optional `make -s deploy ENV=development CLOUD_ARGS="--show-setup"` previews the
standard bootstrap offline. `CLOUD_ARGS="--setup"` only creates a missing toolkit;
it does not change an existing one or deploy the application. If your organization
uses separate bootstrap and deployment principals, use that optional command with
the authorized bootstrap profile, then switch profiles and run ordinary deploy.

For unattended first deployment, use `CLOUD_ARGS="--setup-if-needed --yes"` after
reviewing bootstrap and application IAM changes. `--yes` alone approves application
deployment changes and does not approve a missing bootstrap. Interactive deployment
uses CDK's normal security-change approval. See [permission boundaries](BOOTSTRAP-IAM.md#first-account-setup).

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

Use `make destroy` with the same account, region and environment for coordinated
teardown. It prints targets and retained-data consequences before confirmation.
`CLOUD_ARGS="--yes"` is an explicit noninteractive teardown confirmation, not a purge.

An existing app stack must explicitly publish `CloudRunnerEnabled=true|false`.
Registry deployments also publish `CloudRunnerMode` and the digest of retained
legacy bindings. `up` does not require manual bindings for a registry-only
installation, but refuses to omit or change a deployed legacy compatibility set.
It also refuses to reopen an installation with a durable teardown marker.

The source CLI's `down` first validates account, region, installation tags, physical
stack ARNs and stack-scoped table outputs. It requires
`CloudInstallationControlVersion=1` for the prior AWS-only application, or version
`2` plus the pinned artifact-bucket/catalog outputs for native coordination. The
version-2 CLI closes and settles native runs before requesting resource teardown;
older CLIs refuse an unknown control version. An older deployment cannot honor a
new intake fence merely because its table received a marker.
A stack update still in progress blocks teardown. After showing the exact targets
and retained-data consequences, the command asks for confirmation (`--yes` is an
explicit noninteractive alternative).

The existing Events table stores a durable installation stop marker. Event
creation, deployment acceptance/claim/create reservation and scoring include its
condition in their transactions. Only after stopping intake does the CLI strongly
scan the base table for every stored event and reuse the event teardown path.
The dispatcher continues deletion work while skipping creation, including across
empty filtered query pages. Partial acceptance, unresolved resources or uncertain
creation keep the platform available for cleanup and leave intake closed.
A 30-minute CLI wait timeout does not erase the marker or imply success; correct
the event diagnostics and repeat the command to resume.

A retried problem may have older attempts in another account or region. Teardown
uses each immutable attempt snapshot and its original physical ARN, connection and
catalog. It records a separate completion proof for each historical attempt before
starting the current target's final cleanup. Unknown creation is never resolved by
a timeout alone. Partial failure and interrupted dispatch remain retryable; event
counts advance once per team/problem target, not once per historical attempt.
Synthetic DynamoDB tests covered 25 teams and 75 attempts, parallel retry, response
loss and older-worker recovery while retaining scores, snapshots and receipts.

Only archived events with matching expected/completed counts permit a durable
`DRAINED` marker. The CLI then calls CloudFormation deletion and its waiter with
the verified physical application ARN, followed by the backend ARN. It does not
delete by a reusable stack name or rebuild/upload assets during teardown. A retry
after application deletion requires the matching backend and completed drain
marker before it can finish. Both stacks already absent is a no-op, not a data-purge
claim. An unexplained missing stack or ambiguous state blocks destructive work.

Initial creation can fail before CloudFormation publishes `Outputs`. Once the stack
finishes `CREATE_FAILED`, `ROLLBACK_COMPLETE` or `ROLLBACK_FAILED`, repeat
`make destroy` for the same environment. The CLI verifies the exact stack's
creation history, deployed template and complete resource inventory before
recovering table identities; it also checks table ARNs, ownership tags and
retention policies. It never searches all AWS resources or adopts tables by name.

When the application exists, recovery uses its verified intake-fence contract and
the normal durable event drain. If native artifacts were never created, removal
requires a durable intake stop and strongly consistent, paginated proof that all
three tables contain no data except the matching Events-table stop marker. When
only the backend failed its first creation and no application exists, every
surviving table must be empty; not-yet-created tables need no cleanup. Nonempty
partial data, uncertain ownership, incomplete history or resources still changing
block deletion with the evidence retained for review. A stack still creating or
rolling back must finish before retrying. A failed deletion can be retried with
the same command; this never purges retained resources or modifies `CDKToolkit`.

Event data, scores and receipts, organizer accounts, shared ExternalId, competitor
bootstrap roles/stacks, CDK asset and execution-artifact storage, and the shared
standard `CDKToolkit` are retained. Unrelated or separately deployed exercise resources are not
adopted or removed. Retained resources can continue to incur charges.

Current deployment builds the two existing SPAs and lets CDK publish their assets
and the execution artifacts. It creates no additional source ZIP, staging tree or
source-bundle bucket: the current stacks have no consumer for that former path.
It does not replace the selected problem catalog with a submodule checkout.
Historical pinned launchers still run their own source preparation. Any buckets
created by those older paths are not silently adopted or deleted by this CLI.

There is no purge flag. Retention does not imply automatic reattachment on a later
fresh deployment; an explicit import/recovery procedure is still required.

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

The existing Deployments table stores a small versioned HEAD and bounded snapshot
chunks. A successful transition atomically writes the snapshot, team score deltas,
ledger and operation receipt, with current event/team/intake checks. One event has
one authoritative shared match; it is not split into independent per-team games.
Short expiring admission on that same HEAD reduces conflicting snapshot writes.
Expired/replaced owners cannot commit; interruption does not require a permanent
manual claim reset. Read-only no-op/replay paths recheck authorization atomically.
No game-clock rounding or tick coalescing is used, because tick spacing can change
this problem's scoring outcomes.

Organizer Prepare initializes the native run. Start, scheduled end, scoring lock,
End Event and coordinated teardown use the same durable state. End settles and
closes the match; it does not delete AWS resources in a mixed event. Full platform
teardown verifies native closure as well as AWS cleanup before recording DRAINED.
An old CLI cannot tear down a version-2 application without this step.

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
