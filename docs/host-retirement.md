# Hosting responsibilities and compatibility boundaries

Local hosting and cloud hosting share competition behavior while retaining different
runtime and storage responsibilities. The former SaaS/SBT provisioning application
and separate individual-practice backend are retired. Historical data is not
converted or deleted automatically.

## Responsibilities and owning code

- [Local host](../scripts/local-host/competition-engine.ts): one Bun process,
  event/team ownership, authentication, scoring and persisted SQLite state.
  [HTTP routing](../scripts/local-host/http.ts) enforces the organizer and participant
  boundary; a submitted team identity is not trusted.
- [Compose adapter](../scripts/local-host/docker-catalog.ts) and
  [reviewed native catalog](../scripts/local-host/coordination-catalog.ts): map
  authored problems to executable local runtimes. Catalog visibility is not proof
  of a complete play-through.
- Cloud composition flows through [cloud-hosting](../infrastructure/lib/cloud-hosting/compose.ts),
  [Lite](../infrastructure/lib/tenkacloud-lite/index.ts) and
  [application resources](../infrastructure/lib/app-plane-core/app-plane-core.ts).
  [API Gateway](../infrastructure/lib/tenant-template/api-gateway.ts) owns the
  deployed cloud route wiring; [problem deployment](../infrastructure/lib/problem-deploy)
  owns execution. Use those sources and their contract tests to determine API
  availability for a given revision. Local and cloud routes are separate contracts.
- [Storage decision](host-storage-decision.md): local SQLite and cloud Turso/DynamoDB
  keep their respective persistence and recovery responsibilities.
- [Competitor bootstrap](../infrastructure/templates/competitor-bootstrap.yaml):
  account-owner setup and required ExternalId trust remain separate from the host
  application. Ending an event does not instantly revoke already issued sessions.
- [Pack tooling](../scripts/problem-pack): authoring and immutable installation are
  separate from a hosting adapter accepting an activated pack. Authoring support
  does not establish runtime execution support.

## How to verify a checkout

Read the owning code, schemas and adjacent tests for routes, limits and catalog
membership. Avoid a second handwritten API inventory or per-problem support table
here: those drift independently of implementation.

Keep startup, recovery and destructive-operation guidance in
[local hosting](local-hosting.md) and [cloud hosting](../infrastructure/README.md).
[Clean checkout verification](host-build-verification.md) describes build checks;
[rehearsal records](host-rehearsal.md) distinguish actual runtime evidence from
source-level validation. An offline check does not establish live AWS authorization,
hosted performance or complete catalog playability.
