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
- Opt-in AWS flag deployment intake, durable dispatch, fenced lifecycle, and atomic scoring
- Standard Step Functions polling plus owner-fenced terminal-execution reconciliation

The actual frontend selects the ID token. `Admin` and `Operator` can create events
and rotate keys; only `Admin` revokes access. `Viewer` can read ordinary event
information but cannot reveal keys. No token or missing role is promoted to Admin.

The console runtime config advertises `eventLimits: { maxTeams: 49, maxProblems: 50 }`.
These values share the API/repository source of truth. Event creation writes one
event, two rows per team, and one creation receipt. Thus 49 teams use exactly
100 transaction items; the target 25-team HTTP creation uses 52.

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

The source CLI is `scripts/cloud-hosting/main.ts`. Its implementation is separate
from the pipeline's fixed historical checkout. Public Make deployment remains
guarded while the current competition lifecycle is unfinished.

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
Missing or ambiguous state is refused. An enabled runner cannot be removed by an
`up` invocation that omits `TENKACLOUD_RUNNER_BINDINGS`. A disabled foundation can
be explicitly enabled with reviewed bindings.

`down` refuses runner-enabled stacks before deletion, including with `--yes`:
coordinated intake shutdown and pending/active workflow drain are not implemented.
For a runner-disabled foundation, it validates both stacks and then confirms their
resolved account, region, and full ARNs. A missing stack stops teardown rather
than claiming destruction succeeded. The command leaves event data, organizer
accounts, CDK asset and execution-artifact storage, the project toolkit, and separately
deployed exercise resources intact. Those retained resources can continue to incur charges.

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

## Opt-in AWS flag execution

The narrow source-wired path reuses the old deploy/flag HTTP contracts and the
CloudFormation Lambda plus Step Functions sequence. It does not restore the old
backend wholesale. Only the real `hello-world` flag challenge is in the initial
execution catalog. Non-AWS, Battle, multi-flag, hints and force-redeploy are not
silently mapped to this implementation.

`TENKACLOUD_RUNNER_BINDINGS` is an explicit array of reviewed bindings: `id`,
`accountId`, commercial `region`, exact `roleArn`, exact SecureString
`externalIdParameterArn`, and `reviewedProblemIds`. Values are written to a
content-addressed private S3 object, not a large Lambda environment variable.
Templates/catalogs are also content-addressed and retained for pinned jobs.
There is no same-account credential fallback. Every remote operation requires
ExternalId and temporary assumed-role credentials.

An Admin verifies and binds one configured connection with
`POST /events/:eventId/teams/:teamId/connection` and `{ bindingId }`. Neither a
participant nor an arbitrary request-supplied ARN can register a connection. The
verified row is durable and versioned. A shared versus dedicated AWS account
policy is deliberately not inferred. The real hello-world template contains a
metadata-listing IAM permission documented under a dedicated-account assumption;
its account-isolation suitability must be reviewed before enabling that binding.

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

## Remaining acceptance work

- Reviewed least-privilege initial bootstrap policy and first-account setup path
- AWS account-isolation decision, reviewed exercise permissions and connection UI
- Participant AWS Console/credential access; `hasAws` remains false
- Catalog expansion, non-AWS runners, Battle/coordination, hints and disruptions
- Public registration/claiming, audit, notifications and full organizer UI flows
- Coordinated destroy: stop intake, drain dispatcher/pending/active workflows,
  verify and withdraw owned problem stacks, then remove platform resources while
  explicitly preserving or recovering retained data/artifact buckets

Cloud hosting is still not competition-ready. No live AWS connection, bootstrap,
permission change, deployment, or billing action was executed for these checks.
