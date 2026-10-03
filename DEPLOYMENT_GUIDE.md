# TenkaCloud deployment guide

Use `make local` to host on your computer, or `make deploy` to create AWS hosting.
The [README quickstart](./README.md#quickstart) covers installation and a first event.

## Local hosting

```bash
make install
make local
```

Sign in with the organizer key shown in the terminal. Use `make local-reset` to
rotate a lost organizer key while keeping events, scores and participant access.
`make down` stops owned runtimes and preserves their data. The event's Teardown
action removes its problem environments. Read [local hosting](./docs/local-hosting.md)
for public origins, TLS, data directories and recovery.

## AWS hosting

Install the tools in [mise.toml](./mise.toml), AWS CLI v2 and Make. Configure your
AWS CLI profile, then verify the intended account with `aws sts get-caller-identity`.
Copy the chosen environment's `.env.example` to `.env` if absent and set the
organizer email, account and region. Choose `CDK_PARAM_CONTROL_DATA_BACKEND=turso`
or `dynamodb`; [database selection](./infrastructure/README.md#database-selection)
lists the Turso URL and existing SSM token parameter settings.

```bash
make install
make deploy ENV=development
```

Deployment reuses a compatible standard `CDKToolkit`. If missing, it displays the
target and permission scope, runs the pinned official CDK bootstrap automatically,
and continues deployment with `--require-approval never`. Review the
[bootstrap and caller permissions](./infrastructure/BOOTSTRAP-IAM.md) first:
the standard CloudFormation execution role defaults to `AdministratorAccess`.
The CLI does not grant permissions to its caller or rewrite an existing toolkit.
It uploads a fresh private source archive key and retains its exact S3 `VersionId`
for the restored CodeBuild paths. Pinned cloud deployment requires versioning.
Saved events/deployments keep their catalog snapshot across later updates; see
[catalog continuity and legacy recovery](./infrastructure/README.md#update-the-problem-catalog).
The source bucket, CDKToolkit and competitor bootstrap roles survive platform destroy.

The CLI discovers Lite/cloud physical stack pairs and requires explicit
`TENKACLOUD_STACK_LAYOUT=lite` or `cloud` if both exist. New installations preserve
Lite physical names. Original Lite adoption checks tags and persistent resource IDs;
published cloud-v1 resource/database layouts cannot be updated in place. No automatic
migration is performed. Use a separate environment/database or the matching release.

Original unpinned Lite installations require a one-time confirmation that no active competitions remain, after resource/schema checks and before bootstrap, source upload or deployment. Keep active competitions on their installed version until completion. After verifying that condition, confirm interactively or use `CLOUD_ARGS="--confirm-no-active-events"` for a noninteractive upgrade; generic `--yes` cannot bypass this check. A legacy catalog key alone does not prove a safe upgrade, and historical data is not migrated automatically. New and already-restored installations keep ordinary automatic `make deploy` behavior.

Follow [current cloud setup and teardown](./infrastructure/README.md#current-checkouts-setup-and-teardown-boundary)
for exact configuration, supported problems, confirmations and recovery. For a
console-driven build, review the [cloud pipeline](./infrastructure/README.md#cloud-deployment-pipeline),
its source settings and its privileged CodeBuild role before creating the launcher
or starting a build. Creating the launcher alone does not deploy the application.

The competition's AWS accounts use a separate [competitor bootstrap](./docs/competitor-account-onboarding.md).
Keep their deployment role, participant viewer role and mandatory ExternalId boundaries.
AWS resource exercises reject the platform hosting account before resource mutation;
register and verify a separate competitor account. Different regions in one competitor
account do not establish complete IAM isolation. Native Cryptography Battle needs no
competitor account when score stealing is disabled; enabling it keeps the AWS variant.

## Verify a first event

Create a test event and team, prepare a supported problem, sign in to the
participant portal, submit an answer and verify its score. The current cloud
backend restores generic CloudFormation deployment, flag/multi-flag and scheduled
scoring, Console/CLI access and native coordination. Docker/Compose exercises require
local hosting. Nine current templates exceed the 51,200-byte TemplateBody limit;
TemplateURL is not implemented, so those problems are not verified deployable. [Runtime coverage](./docs/host-retirement.md)
distinguishes implemented contracts from complete exercise rehearsals.

## Stop and remove resources

```bash
make destroy ENV=development
```

Check the account, region and owned targets before confirmation. Cloud teardown
removes platform-owned data by default. Explicitly retained DynamoDB tables and
external Turso rows remain unless you run `make destroy-all`. Recorded exercise
cleanup is separate: finish event Teardown before platform removal. `--drain-events`
is unavailable in this backend. Keep installation records until
cleanup succeeds so a failed operation can be retried safely. An ordinary local
`make down` does not remove cloud resources.

Retained data and AWS resources can continue to incur charges. Check the
[cloud lifecycle and recovery guide](./infrastructure/README.md) and
[cost boundaries](./docs/running-costs.md) before removing storage. Shared CDK
bootstrap resources are separate from this application's lifecycle.

To read cloud help without AWS calls, append `CLOUD_ARGS="--help"` to `make deploy`
or `make destroy`.
