# Competition hosting architecture

This document explains responsibilities, code structure and trust boundaries.
Routes, schemas, limits and catalog membership belong to their implementation and
contract tests; runtime verification records describe what was actually exercised.

## Current responsibilities

- One Bun process serves the organizer and participant applications
- The local organizer key is separate from event-owned participant team keys
- Event/team state, operation ownership, scores, receipts and authentication live
  in local SQLite with private original key files
- [On-demand jobs](../../scripts/local-host/on-demand-containers.ts) retain owned
  environments while participants start, resume and stop them; no automatic eviction
  or reset occurs
- [Container budgets](../../scripts/local-host/container-budget.ts) and
  [runtime ports](../../scripts/local-host/runtime-ports.ts) enforce resource admission;
  authored Compose limits and historical event lifecycles remain distinct
- Runtime adapters manage owned Docker environments, the in-process Battle and
  coordination exercises; HTTP boundaries do not trust a submitted team identity
- Accepted operation/ownership state is retained before external work; uncertain
  outcomes remain visible and recoverable
- Verifiers judge submissions; the platform serializes and persists scoring,
  progress and retry receipts before replying

`make local` starts the managed runtime. `make down` stops owned local runtimes
and preserves data. New on-demand Docker jobs remain stopped after startup until
participants resume them. Stop retains writable layers and volumes, not RAM.
It does not reset the event clock or delete AWS exercise
stacks. Explicit event teardown and ordinary shutdown are separate operations.

## Storage and cloud boundary

Local hosting uses SQLite. Cloud hosting reuses the original SBT-free Lite
composition: API Gateway, Lambda, Cognito, CloudFront, Step Functions, CodeBuild
and either Turso or the original DynamoDB control-data resources. Turso uses the
configured SSM token and creates no DynamoDB tables. The organizer and participant
SPAs retain their separate authentication surfaces. Cognito role values
`TenantAdmin`, `TenantOperator` and `TenantViewer` map to organizer roles; the
internal fixed `tenantId=local` does not create a user-facing tenant concept.

Cloud AWS workflows retain generic CloudFormation create, update, no-op, recreate
and delete through their original Lambda/CodeBuild paths. Flag/multi-flag and
scheduled endpoint scoring, participant Console/CLI access, and native coordination
are restored. Workers use registered competitor roles and mandatory ExternalId.
Deployment credentials are not participant credentials. The reviewed native
Cryptography Battle profile with score stealing disabled needs no competitor AWS
account; enabling its score-steal parameter keeps the AWS-backed variant. State
and scores use the selected backend, or SQLite for local hosting.
Docker/Compose remains local-only. Nine canonical templates exceed the restored
CloudFormation TemplateBody limit of 51,200 bytes; TemplateURL is not implemented.
Catalog presence therefore does not imply all AWS problems are deployable.

Cloud execution snapshots catalog maps, hints, plugins and raw sources. Saved
events and deployments retain their `catalogKey`, so catalog A continues after B
is deployed or removes a problem. Readers verify the saved sources; CodeBuild uses
the exact source ZIP version. Older unpinned records need the verified original
snapshot through `CDK_LEGACY_CATALOG_KEY`, never an assumed current catalog. A legacy
key does not prove a safe active-event upgrade: original competitions must finish
on their installed version before the initial upgrade.
Platform teardown removes its owned execution artifacts. The separate source ZIP
bucket survives; current unique archive keys are not removed by noncurrent-version
expiration and incur storage until separately reviewed source-bucket cleanup.

Both cloud providers preserve 99-team admission; SQL coordination retains the
original 4 MiB state policy. The official local libSQL protocol run passed with
25 teams and 100 concurrent authentication reads (p95 186 ms). This is not a
native Battle throughput test, hosted Turso measurement or live AWS rehearsal.
See [recorded verification](../../infrastructure/README.md#verification).

`make deploy` performs account/environment/credential preflight, reuses standard
CDKToolkit or bootstraps it automatically when missing, and builds/uploads the
source archive consumed by CodeBuild. Every upload uses a fresh private
`<configured-key>.executions/<uuid>.zip` key and exact S3 `VersionId`; the pinned
cloud path rejects explicitly disabled versioning. New installations use cloud
physical stack names. Existing Lite stacks keep their names. The CLI discovers
existing Lite/cloud pairs and requires explicit selection when both exist. Original Lite updates verify ownership and
persistent resource identities, then require explicit confirmation that no active
competitions remain before bootstrap, source upload or deployment. Noninteractive
original upgrades require `--confirm-no-active-events` after operator verification;
generic `--yes` cannot bypass the guard. New/already-restored deployments keep their
automatic flow. Published cloud-v1 stack updates and nonempty or
unrecognized cloud-v1 SQL data are refused; no automatic migration occurs.

`make destroy` confirms the selected owned resources and follows deployed
Delete/Retain policies. It works without database access or application Outputs,
including failed/partial-stack recovery, and empties verified owned versioned
buckets before removal. DynamoDB defaults to Delete; ordinary destroy leaves
external Turso rows. `destroy-all` explicitly purges supported retained data and
known deployed Turso rows. Finish event Teardown before platform removal;
`--drain-events` is rejected here. The source bucket, CDKToolkit and competitor
bootstrap roles remain outside platform destruction.

Teams may use separate competitor accounts or different problem regions within
the same competitor account. IAM and other global services remain shared in the
latter. Organizations/StackSets is an optional account-owner bootstrap procedure;
platform deployment does not enable its trusted access. AWS resource exercises
require a verified competitor account. An explicit self-test acknowledgment before
event creation permits the hosting account for that event. Participant STS rechecks
the saved event consent. Problem and participant roles may reach hosting
configuration and data; this opt-in does not provide isolation. Use a separate
account when third parties participate. Live AWS self-tests remain unverified. Different regions in a shared competitor account
do not establish complete IAM isolation. The catalog IAM audit has unresolved
findings, so restoration is not a least-privilege certification. Previously issued
credentials can outlive event end; current event/team state governs applicable new access.

## Runtime responsibility and evidence

The [Compose catalog adapter](../../scripts/local-host/docker-catalog.ts) and
[reviewed native catalog](../../scripts/local-host/coordination-catalog.ts) connect
problem definitions to local execution. The [cloud catalog](../../infrastructure/lib/cloud-hosting/catalog.ts)
owns cloud membership. Preserve capability failures, per-team verifier separation,
safe endpoint routing and native hardware requirements. Catalog visibility alone
is not execution evidence.

Use [build verification](../host-build-verification.md) and
[rehearsal records](../host-rehearsal.md) for validation evidence. Synthetic allocation
and lifecycle tests do not establish Docker performance or machine capacity.

## Diagram sources

The Mermaid sources below describe the current boundaries:

- [Logical responsibilities](diagrams/logical.mmd)
- [Local components](diagrams/local-components.mmd)
- [AWS exercise and cloud platform boundary](diagrams/cloud-components.mmd)
- [Problem deployment](diagrams/problem-deployment.mmd)
- [Participant scoring](diagrams/participant-scoring.mmd)
- [State-preserving local lifecycle](diagrams/local-play-sequence.mmd)
- [Editable Draw.io document](diagrams/system-architecture.drawio): five current
  pages for cloud infrastructure, AWS exercise execution, the unified local runtime,
  use cases and system boundaries. Existing page IDs, AWS4 official icons and the
  original frame/connector style are retained; SaaS provisioning cells are replaced by the restored cloud composition
  and remaining nodes are moved only to fit the current boundaries.

Regenerate Draw.io with `python3 docs/architecture/diagrams/system-architecture.gen.py`.
Its first two page IDs (`saas-physical`, `lite-physical`) remain stable identifiers,
not supported product modes. Regions are chosen by the operator; the diagrams do
not imply a fixed production region. DynamoDB icons summarize the selected provider's original control-data tables,
and worker icons summarize their operations. The source-artifact S3 icons summarize
the separate private execution-snapshot and source-ZIP buckets. Page 02 expands the exercise execution
path; logs in page 01 summarize backend diagnostics. The AWS4
icon and connector conventions follow the requested
[aws-drawio-diagram skill](https://github.com/sagochiko/aws-drawio-diagram-skill),
while retaining the original frame styles.

Mermaid sources can be rendered with `diagrams/render.sh` when its documented
Mermaid CLI is available. Previously generated Mermaid/JAWS slide exports are
historical; current guides do not embed those stale images as current evidence.
The JAWS exporter reads its preserved landing-page Draw.io copy, so regenerating
that historical talk cannot overwrite the current diagram or mix architectures.
