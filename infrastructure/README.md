# Cloud hosting restoration

This is an in-progress restoration of the former single-installation Lambda,
DynamoDB, Cognito, CloudFront, and CDK path. It is not ready to run a competition.
Local hosting remains SQLite. No SBT, tenant provisioning, tier plans, or remote
SQL backend is included.

## Implemented vertical slice

- Event creation with atomic event, team, access-key, and response-receipt persistence
- Organizer event list/detail, explicit credential expansion, rotation and revocation
- Participant authentication, team-keyed state queries, and transactional scoreboard projections
- Existing organizer and participant HTTP response contracts
- REST API Gateway Cognito signature verification and client-audience pinning
- Lambda issuer, audience, ID-token, expiry, and explicit role validation
- Invitation-only organizer sign-in with mandatory TOTP and no self-assigned role
- Retained, deletion-protected event/team/deployment tables and private SPA hosting
- Existing SPA builds and CDK asset publishing, scoped setup/deploy, and guarded foundation teardown
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

The complete launcher is
[`templates/cloud-pipeline.yaml`](templates/cloud-pipeline.yaml), renamed from
`lite-pipeline.yaml`. There is one published pipeline template. Startup,
`destroy`, `destroy-all`, automatic CDK bootstrap, independent catalog selection,
capacity/retention parameters, release classification and onboarding checkpoints
are preserved. Existing resource names, parameter IDs and checkpoint values stay
unchanged so the rename does not replace resources or break existing tutorials.

The defaults execute platform commit
`949a40a9ed9199331d928ad5cf9397dbb4ba3f81` and catalog commit
`363a7c9b83969e20d63b74fd0410a354da5e202b`. They run the code at those fixed refs,
not this checkout. The existing `candidate/unverified` classification is retained;
pointing the template at the current branch does not establish compatibility.
The original backend selectors are preserved for those refs, not a change to the
current local SQLite / cloud DynamoDB direction.

The original broad CodeBuild permissions, bootstrap behavior and teardown
consequences are also preserved and must be reviewed before execution. Template
creation does not start a build. No AWS action was executed as part of this rename.
See [permission boundaries](BOOTSTRAP-IAM.md).

## Current checkout's setup and teardown boundary

`make deploy` and `make destroy` call the existing `scripts/cloud-hosting/main.ts`
implementation in this checkout. They do not run the pipeline's fixed historical
checkout. The current cloud exercise catalog supports hello-world with scoped CLI
access and native Cryptography Battle. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. Automatic first-account IAM preparation remains
incomplete. Synchronized Battle bursts still exceed the five-second refresh interval;
the presence of its routes is not a 100-participant capacity claim. These commands can create chargeable AWS resources; they do not
promise a zero-cost platform.

Start with `make deploy CLOUD_ARGS="--help"` or `make destroy CLOUD_ARGS="--help"`;
help performs no AWS operation. After reviewing the permissions below, use an
already configured AWS profile, `AWS_REGION`, `ENV` (default `development`),
`TENKACLOUD_ADMIN_EMAIL`, and `TENKACLOUD_CFN_EXECUTION_POLICY_ARN` for deployment.
Run `make destroy` with the same account, region and environment for coordinated
teardown. It prints the targets and asks before changing them. `CLOUD_ARGS="--yes"`
is an explicit noninteractive teardown confirmation, not a data-purge option.
No command in this documentation was run against a live AWS account during verification.

`up` requires `TENKACLOUD_ADMIN_EMAIL`, a commercial AWS region, and a reviewed
`TENKACLOUD_CFN_EXECUTION_POLICY_ARN`. See [bootstrap permissions](BOOTSTRAP-IAM.md).
It refuses the missing policy before setup/upload and never falls back to broad
administrator permissions. Both stacks use the same environment-specific project
qualifier. The default/shared `CDKToolkit` is not adopted or modified.
Before builds or bootstrap, existing platform stacks must match the current AWS
caller account, resolved region, exact stack ARN/name, and project/environment
tags. Only an explicit CloudFormation not-found response permits creation.
Access denial, malformed metadata, or mismatched ownership stops the operation.

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

Event data, scores and receipts, organizer accounts, shared ExternalId, competitor
bootstrap roles/stacks, CDK asset and execution-artifact storage, and the project
toolkit are retained. Unrelated or separately deployed exercise resources are not
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
config. The existing [competitor bootstrap template](../templates/competitor-bootstrap.yaml)
is served as one public, secret-free S3 object for the screen's CloudFormation
Quick-create link. No second bootstrap template or account-management app exists.

Each remote operation requires the exact installation role name, Purpose and
Installation tags, mandatory ExternalId and current verification. The platform
account is refused by the API/worker and by explicit role-assumption IAM denies.
Registration verification establishes the connection's identity and trust; it
is not a certification that sharing an AWS account safely isolates participants.
Shared versus dedicated competitor accounts remains an open review item. In
particular, hello-world's metadata-listing permission has a documented
dedicated-account assumption. The participant CLI slice below explicitly denies
that permission; it does not approve a general shared-account deployment model.

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

## Remaining acceptance work

- Reviewed least-privilege initial bootstrap policy and first-account setup path
- AWS account-isolation decision and reviewed exercise permissions
- Participant AWS Console access without cross-team metadata disclosure
- Cloud-native catalog expansion, AWS endpoint Battles, hints and disruptions
- Public registration/claiming, audit, notifications and full organizer UI flows
- Native Battle burst latency under the target participant load
- Shared problem-pack/drill progression and final tutorial alignment

Cloud hosting is still not competition-ready. No live AWS connection, bootstrap,
permission change, deployment, or billing action was executed for these checks.
