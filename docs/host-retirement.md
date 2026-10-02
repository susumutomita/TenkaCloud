# Hosting compatibility and retirement review

This draft integration keeps local and cloud competition hosting while removing
SaaS/SBT tenant provisioning and the separate individual-practice backend. Cloud
hosting is being restored with Lambda and selectable Turso/DynamoDB. Retained source or passing
unit tests do not establish that an incomplete deployment path is ready to use.
No AWS deployment, automatic migration, data purge or release publication is part of
these verification results.

## Retained, retired and incomplete behavior

| Behavior | Current boundary | Owning path |
| --- | --- | --- |
| Local organizer and participant hosting | One Bun process and persistent SQLite; `make local` / `make down` preserve event data and stopped exercise work | `scripts/local-host`, existing console and portal |
| 106 local Compose exercises | Generic per-team Challenge runner with on-demand start/stop, original verifiers, hints and scoring; not all 106 have completed real Docker rehearsals | `scripts/local-host/docker-catalog.ts`, `problems/` |
| 15 declared participant terminals | Authenticated, team/job-owned terminal transport; PostgreSQL terminal play and restart were exercised with real Docker | `scripts/local-host/terminal-http.ts`, `scripts/local-host/container/terminal-shell.ts` |
| Native Cryptography Battle | Shared reducer: local SQLite and cloud Turso/DynamoDB, private team projections and atomic scoring. The DynamoDB Local 100-participant burst took 5.910 seconds, exceeding the five-second refresh interval; this is not an AWS measurement | `scripts/local-host/coordination.ts`, [cloud status](../infrastructure/README.md) |
| Cloud platform | Lambda, Cognito and selectable Turso/DynamoDB with durable flag-deployment/scoring work and native Battle; standard CDK setup and platform teardown require reviewed AWS permissions. End-to-end live AWS rehearsal remains unverified | `infrastructure/lib/cloud-hosting`, `infrastructure/lib/problem-deploy` |
| AWS-service problems | Cloud hosting only; the reviewed flag slice does not cover every AWS catalog problem or endpoint-based Battle | [Cloud status](../infrastructure/README.md) |
| Docker/Compose exercises in cloud hosting | Local-only; not listed in the cloud catalog. Native Cryptography Battle is supported separately | [Cloud status](../infrastructure/README.md) |
| Organizer key login, retained SAML records, optional audit, progression and participant registration | Local organizer login uses only a key; retained historical organizer records cannot authenticate. Do not infer cloud parity from local tests | `scripts/local-host` |
| Competitor bootstrap and trust | Template retained; ExternalId and viewer-role boundaries remain required. Cloud onboarding and account-isolation conditions still need acceptance | `infrastructure/templates/competitor-bootstrap.yaml` |
| Pack creation, validation, immutable install/list/inspect/remove and activation records | Offline tooling retained. Activation does not yet add a pack to the competition runtime; structured drill/progression integration remains incomplete | `scripts/problem-pack`, public SDKs, `packs/` |
| Generic multi-provider pack authoring | Authoring/validation retained; no promise of execution for every AWS/GCP/Azure/Sakura pack | public SDKs and golden-pack tests |
| Deployment pipeline | `cloud-pipeline.yaml` defaults to current deployment with standard CDK bootstrap and a reviewed privileged CodeBuild role. Review source settings and deployment authority before starting a build | [Pipeline contract](../infrastructure/README.md#cloud-deployment-pipeline) |
| Storage | Local SQLite; cloud Turso/DynamoDB. No automatic conversion from historical SQLite/DynamoDB/Turso installations | [Storage boundary](host-storage-decision.md) |
| Separate practice login, simulator and snapshot backend | Retired as an independent application. Shared problem definitions, editor, verifier and terminal behavior are reused by local competition | [Local hosting](local-hosting.md) |
| tcloud client | Not part of the current hosting workflow | use the organizer and participant interfaces |
| Standalone `POST /problems/{id}/deploy` | Not provided by this candidate. Event APIs are not a drop-in replacement; external callers and book/tutorial instructions require explicit compatibility review | integration review |
| Existing AWS sessions | Ending an event or blocking new access does not instantly revoke previously issued STS or federation sessions | credential expiry and role policy |
| Container distribution | No image/tag published by this change. The optional image is a native-Battle rehearsal target, not Lambda cloud hosting | `release/host-candidate.json` |

## Catalog and verification boundary

The pinned catalog has 106 local Compose definitions, including 98 multi-verify
and 8 verify definitions, with 15 terminal declarations. They are all exposed as
local Challenges by the generic catalog adapter. Four former local Battle-shaped
exercises follow that Challenge contract; native Cryptography Battle keeps its
shared-match rules.

Catalog identity, service/port planning, owned runtime state and verifier contracts
are tested across the definitions. Representative real Docker and browser checks
cover SQL, PostgreSQL terminal checkpoints, team separation and stop/restart with
preserved work. These checks are not a claim of complete play-throughs for every
problem variant. The canonical catalog and its tests replace a duplicated manual
list of 106 per-problem availability flags.

Retained local feature tests stay beside their implementations. New cloud tests
cover asynchronous SQL/DynamoDB transactions and durable work without restoring SaaS
provisioning. Coverage thresholds and security checks remain active.

[Clean checkout verification](host-build-verification.md) and the container
restart test describe image verification. A real AWS or external IdP rehearsal is
[optional and separately recorded](host-rehearsal.md); missing cloud implementation
or failed offline checks are not excused by that distinction.
