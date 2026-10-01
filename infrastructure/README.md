# Cloud hosting restoration

This is an in-progress restoration of the former single-installation Lambda,
DynamoDB, Cognito, CloudFront, and CDK path. It is not ready to run a competition.
Local hosting remains SQLite. No SBT, tenant provisioning, tier plans, or remote
SQL backend is included.

## Implemented vertical slice

- Event creation with atomic event, team, and access-key persistence
- Organizer event list/detail, explicit credential expansion, rotation and revocation
- Participant authentication and own-event state/leaderboard reads
- Existing organizer and participant HTTP response contracts
- REST API Gateway Cognito signature verification and client-audience pinning
- Lambda issuer, audience, ID-token, expiry, and explicit role validation
- Invitation-only organizer sign-in with mandatory TOTP and no self-assigned role
- Retained, deletion-protected event/team/deployment tables and private SPA hosting
- Injected one-command source preparation, CDK bootstrap, deploy, and destroy flow

The actual frontend selects the ID token. `Admin` and `Operator` can create events
and rotate keys; only `Admin` revokes access. `Viewer` can read ordinary event
information but cannot reveal keys. No token or missing role is promoted to Admin.

The console runtime config advertises `eventLimits: { maxTeams: 49, maxProblems: 50 }`.
These values share the API/repository source of truth. Event creation writes one
event plus two rows per team, so 49 teams fit DynamoDB's 100-item transaction limit.
The target 25-team event uses 51 transaction items.

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
There is no separate team-score storage model or replacement scoring calculation.

History has no DynamoDB TTL. Expiry limits participant access without deleting
results. Team plaintext keys remain private organizer credential material for the
existing creation/explicit-reveal contract; neither listing nor participant views
include them. Rotation/revocation uses one conditional transaction and invalidates
the prior lookup immediately.

## Setup and teardown boundary

The source-only CLI is `scripts/cloud-hosting/main.ts`. There is intentionally no
new public Make target while the remaining acceptance items are unfinished.

`up` requires `TENKACLOUD_ADMIN_EMAIL`, a commercial AWS region, and a reviewed
`TENKACLOUD_CFN_EXECUTION_POLICY_ARN`. See [bootstrap permissions](BOOTSTRAP-IAM.md).
It refuses the missing policy before setup/upload and never falls back to broad
administrator permissions. Both stacks use the same environment-specific project
qualifier. The default/shared `CDKToolkit` is not adopted or modified.
Before upload or bootstrap, existing platform stacks must match the current AWS
caller account, resolved region, exact stack ARN/name, and project/environment
tags. Only an explicit CloudFormation not-found response permits creation.
Access denial, malformed metadata, or mismatched ownership stops the operation.

`down` validates both existing stacks before any deletion, then confirms their
resolved account, region, and full ARNs. A missing stack stops teardown rather
than claiming destruction succeeded. The command leaves event data, organizer
accounts, source-bundle storage, the project toolkit, and separately deployed
exercise resources intact. Those retained resources can continue to incur charges.
Source-bundle cleanup is restricted to the repository's marked
`.cache/source-bundle` directory. Unmarked nonempty directories are not adopted.
Source buckets require the canonical account/region/environment name and matching
project/purpose/account/environment tags before retention changes. Source and
compiled-asset symlinks are rejected before archiving, and the archive stores no
outside-root symlink targets.

There is no purge flag. Retention does not imply automatic reattachment on a later
fresh deployment; an explicit import/recovery procedure is still required.

## Verification

- CLI subprocess tests use injected calls; no AWS or CDK deployment executes
- Source-bundle tests use temporary synthetic files and inspect the actual ZIP
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

## Remaining acceptance work

- Reviewed least-privilege initial bootstrap policy and first-account setup path
- Competitor account verification and mandatory ExternalId runner integration
- Catalog/runtime projection, problem deployment/teardown dispatch, and recovery
- Existing scoring, receipt/replay, multi-team coordination, and disruption wiring
- Public registration/claiming, audit, notification, and full organizer UI flows
- Full competition lifecycle and 25-team concurrent scoring validation

The current source bundle step preserves the prior runner archive contract, but
no problem runner consumes it yet. Unsupported runner routes remain absent. Do
not advertise cloud hosting as competition-ready or run a live deployment as part
of these checks.
