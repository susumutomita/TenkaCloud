# 30-minute architecture tour for technical evaluators

> 日本語版: [architecture-tour-30min.ja.md](./architecture-tour-30min.ja.md)

This is the technical depth pass, intended for CCoE / platform-team evaluators. It assumes the audience has watched the 5-minute quickstart or read [`docs/demos/quickstart-5min.md`](./quickstart-5min.md). Length: about 30 minutes of facilitated walkthrough.

## Opening (≈ 2 min)

Set the frame: TenkaCloud is built on `@cdklabs/sbt-aws` 0.3.9 and obeys four planes that talk through an EventBridge bus. The tour covers each plane in order, then security, then the multi-cloud roadmap.

**Reading order before this セッション.**

- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10-minute overview
- [`docs/architecture/MODULE_MAP.md`](../architecture/MODULE_MAP.md) — directory-to-module index
- [`docs/architecture/GLOSSARY.md`](../architecture/GLOSSARY.md) — term definitions with ADR back-links

## Plane 1 — Control Plane (≈ 5 min)

**File of interest.** `infrastructure/lib/control-plane-stack.ts`

**Talking points.**

- The Control Plane wraps the SBT `ControlPlane` construct. We do not reimplement Cognito UserPools, Tenant CRUD APIs, or the EventBridge bus — that is the SBT contract. See `INVARIANT_CONTROL_PLANE_USES_SBT` in `docs/architecture/harness.md`.
- The Control Plane is the **tenant manager**, not the tenant runtime. Putting tenant runtime data here would violate `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME` and would surface as a `make harness` failure on PR review.
- `admin-console` (Vite + React 19 + Cloudscape) is the System Admin UI. It fetches `runtime-config.json` at boot, then talks to the Tenant CRUD API with Cognito JWT.

**ADR cross-references.**

- `ADR-018` — Pooled UserPool SAML isolation (how tenant identity is namespaced)
- `ADR-020` — Authorization model (claim shape, scoping rules)

**Inspection trick.** Run `make synth` and grep the output for `ControlPlaneStack` resources to confirm the SBT wiring is intact.

## Plane 2 — Application Plane (≈ 5 min)

**Files of interest.**

- `infrastructure/lib/tenant-template/` — one tenant's API + Cognito + UI hosting
- `infrastructure/lib/tenant-pipeline/` — per-tenant provisioning via CodePipeline (PLATINUM tier only)
- `infrastructure/lib/bootstrap-template/` — `TenantMappingTable` (which tier each tenant is on)

**Talking points.**

- Pooled tiers (BASIC / STANDARD / PREMIUM) share **one** `serverless-saas-ref-arch-tenant-template-pooled` stack. Their tenant rows live in DynamoDB partitioned by `TenantId`. This is the cheapest model.
- PLATINUM tier triggers `ServerlessSaaSPipeline`, which CodeBuilds a dedicated `serverless-saas-ref-arch-tenant-template-<tenantId>` for that tenant. That stack is fully isolated — separate Cognito, separate DDB, separate Application Console URL.
- The frontend `application-admin-console` is **the same dist** for every tier. Differences are injected at runtime through `runtime-config.json`. This is `INVARIANT_APP_CODE_IS_UNMODIFIED`: app artifacts never branch on tenant ID.

**ADR cross-references.**

- `ADR-004` — Event-team data model
- `ADR-016` — TenkaCloud Lite App Plane Core (the `tenantId="local"` simplification used in Lite mode)
- `ADR-019` — Cross-account stack catalog

## Plane 3 — Problem Deploy Backend (≈ 5 min)

**Files of interest.**

- `infrastructure/lib/problem-deploy/` — Deployments DDB + Worker Lambda + scoring dispatcher + JWT-authenticated HTTP API
- `infrastructure/templates/competitor-bootstrap.yaml` — the one CFn the competitor account runs once

**Talking points.**

- The Worker Lambda subscribes to `DeployCreateRequested` events on the EventBridge bus. When one fires, it AssumeRoles into the competitor account using the tenant's `ExternalId` (always required — there is no opt-out) and runs CFn `CreateStack` with the problem's `template.yaml`.
- Scoring is centralized in one Lambda that dispatches by `kind`. The five kinds are `flag`, `uptime-flat`, `uptime-multi`, `phased-polling`, `attack-detection`. **No problem-specific code lives in the platform** — that is `ADR-012`.
- Reconciliation is EventBridge-driven (`ADR-014`). The frontend polls (no SSE — see `AGENTS.md`) and EventBridge supplements the polling so we do not need long-lived sockets.
- The Worker Lambda is fronted by Step Functions for retry / delete orchestration. Idempotency is preserved by keying state on `(tenantId, eventId, teamId, problemId)`.

**ADR cross-references.**

- `ADR-001` — Problem deploy CRUD model
- `ADR-002` and `ADR-009` — Cross-account federation
- `ADR-012` — Problem plugin architecture (the heart of the platform)
- `ADR-013` — Disruption phase 2 (condition-triggered phase advance)
- `ADR-014` — EventBridge-driven state reconciliation
- `ADR-017` — Cloud Action intent / Trust Bridge

## Plane 4 — Participant Portal (≈ 4 min)

**Files of interest.**

- `apps/participant-portal/` — the Vite + React 19 + Cloudscape SPA
- `infrastructure/lib/problem-deploy/` (Participant Portal hosting lives here, behind `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true`)

**Talking points.**

- The portal logs participants in via the team's Cognito UserPool. After login, the portal fetches the team's deployed problems, endpoints, flags, and disruption phases.
- One-click AWS Console SSO is implemented by federating into the team's read-only `ParticipantViewerRole` (see each problem's `template.yaml` for the scoping IAM statements).
- Inter-team coordination (router updates / alliances / shared resource queues) is **not** baked into the platform. It is dispatched to the problem's portal plugin (`portal/`) per `ADR-028`. The platform exposes a primitive; the problem owns the semantics.

**ADR cross-references.**

- `ADR-005` — Battle Portal UI
- `ADR-006` — Notifications
- `ADR-028` — Inter-team coordination plugin

## Security posture (≈ 5 min)

**Talking points.**

- **AssumeRole always requires `ExternalId`.** The CDK parameter `CDK_PARAM_DEPLOY_EXTERNAL_ID` is non-optional. Competitor accounts are bootstrapped with a role that trusts only `(TenkaCloud platform account, ExternalId)`.
- **Least-privilege IAM in the bootstrap CFn.** `infrastructure/templates/competitor-bootstrap.yaml` grants CFn CreateStack plus the union of AWS services that any problem template touches. Problems do not get a god-mode role.
- **Auth at the infra layer, not the app.** There is no `AUTH_SKIP` anywhere in the repo (`INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`). Every request goes through Cognito JWT validation at API Gateway.
- **Tenant isolation by stack separation + DDB partition key.** No single-table cross-tenant design. Pooled tiers share a stack but partition by `TenantId`. PLATINUM tier gets a dedicated stack.
- **Supply-chain defense (mini Shai-Hulud 2nd wave).** Four layers: Bun `trustedDependencies` empty allowlist, `.npmrc` with `ignore-scripts=true` and 7-day quarantine, `make audit-deps` baseline diff in CI, and `make install_ci` with `--ignore-scripts` plus Aikido Safe Chain.
- **No on-demand DynamoDB.** The `DynamoDbLowCapacity` CDK Aspect forces 1 RCU / 1 WCU PROVISIONED on every table. Free-Tier-safe by construction, not by review discipline.
- **No `@aws-sdk/client-secrets-manager`.** SSM Parameter Store SecureString is the only secret store. This is enforced by `secrets-manager-forbidden` in `make harness`.

**ADR cross-references.**

- `ADR-021` — Dependency major-bump decisions (how we update without breaking)
- `ADR-022` (tenant-isolation-audit) — How tenant isolation is verified

## Operations (≈ 2 min)

**Talking points.**

- **Two deploy modes from the same code.** `make deploy` (Lite, default) and `make deploy-saas` (multi-tenant). The same Lambdas and scoring kinds are reused — only the control-plane stack count and tenant pipeline differ.
- **Idempotent teardown.** `scripts/cleanup.sh` works from any partial-failure or partial-delete state. Re-running it is safe.
- **Polling-based UI by design.** SSE / WebSockets are prohibited by `AGENTS.md` because they fight the Lambda operational model. The frontend polls; EventBridge supplements the polling.
- **PR Discipline is machine-enforced.** Every PR runs `make harness`, which checks invariants like "the PR body has a `## Regression analysis` section" and "the PR body has a `## Physical impact` section". Architecture invariants and PR hygiene are the same check.

## Multi-cloud roadmap (≈ 2 min)

**Talking points.**

- Today: **AWS only**. We do not claim production-grade multi-cloud. We do not pretend Cognito is Azure AD.
- The plan: `ADR-023` (provider-specific problem runtime). Problems will be able to declare a target provider (`aws` / `azure` / `gcp`), and the platform will dispatch deploy + scoring to a provider-specific worker. The platform layer (events, scoring kinds, EventBridge) stays cloud-agnostic.
- Community contribution model: `ADR-024` (community voting and problem registry). A problem registry with voting + curation, so problem packs propagate without becoming forks.

**ADR cross-references.**

- `ADR-023` — Provider-specific problem runtime
- `ADR-024` — Community voting and problem registry

## Q&A frame (≈ 1 min)

When fielding questions, anchor each answer to a file or an ADR. If a question cannot be answered with a file path or an ADR, that is a signal we need to write one. The harness rule `adr-must-be-html` and `adr-self-contained` (see `docs/architecture/harness.md`) keep the ADRs OSS-readable.

## Where to go next

- [`docs/architecture/harness.md`](../architecture/harness.md) — invariants + PR Discipline (the source of truth)
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](../architecture/adr-012-problem-plugin-architecture.html) — the central design decision
- [`infrastructure/templates/README.md`](../../infrastructure/templates/README.md) — competitor-side bootstrap
- [`problems/README.md`](../../problems/README.md) — problem authoring
- [`ROADMAP.md`](../../ROADMAP.md) — what is shipped vs in flight
