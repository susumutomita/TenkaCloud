# TenkaCloud Glossary

> Definitions of recurring terms in TenkaCloud. Each entry says **what it is**, **where it lives in code**, and **which ADR introduced or governs it**. For the narrative, see [OVERVIEW.md](./OVERVIEW.md). For directory ownership, see [MODULE_MAP.md](./MODULE_MAP.md).

Sorted alphabetically. Acronyms are spelled out on first reference.

---

## AppPlane / Application Plane

The per-tenant runtime that hosts a tenant's own Cognito UserPool, API Gateway HTTP API, and `application-admin-console` SPA. Two tier shapes:

- **Pooled** — BASIC / ADVANCED tiers share a single CDK stack (`tenkacloud-tenant-template-pooled`). One Cognito UserPool, one API, one SPA serve all pooled tenants.
- **Silo** — PLATINUM tier gets its own stack (`tenkacloud-tenant-template-<tenantId>`) deployed via the per-tenant `ServerlessSaaSPipeline`.

Distinct from Control Plane (= tenant manager). The Application Plane runs *tenant business logic*; it doesn't manage tenants. Defined by invariant [`INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`](./harness.md).

**Code**: `infrastructure/lib/tenant-template/`, `apps/application-admin-console/`.

---

## Battle vs Challenge

Two problem categories that share scoring engine, portal, and metadata DSL but differ in cadence.

- **Battle**: real-time, head-to-head. Multiple teams deploy concurrently and earn points from uptime / defense / phase progression.
- **Challenge**: self-paced, evergreen. Always open. One deploy = one flag submission is typical.

Distinguished by `metadata.category` (= `"Battle"` or `"Challenge"`). Battle and Challenge are not strict silos — a Battle problem may embed CTF-style sub-quests inside the same metadata. See [ADR-012](./adr-012-problem-plugin-architecture.html).

**Code**: `problems/battles/<id>/`, `problems/challenges/<id>/` (= inside the submodule).

---

## ChallengePayloadStack

A CDK stack (`infrastructure/lib/challenge-payload/challenge-payload-stack.ts`) that materializes the S3 bucket + GitHub OIDC IAM Role used by an external "additional problems" repo. Currently **dormant** — no repo binds its `AWS_CHALLENGE_PUBLISH_ROLE_ARN` secret yet. Reserved for a future private/answer repo that does not want to ship via the OSS `problems/` submodule.

Introduced by [ADR-008](./adr-008-problem-payload-separation.html) Phase 3 + Phase 4 (the bucket is the Phase 3 piece; the OIDC Role is the Phase 4 piece). The deploy-handler path that consumes its presigned URLs (= `resolveChallengePayloadBucket` → `CHALLENGE_PAYLOAD_URL` env into `deploy-battles.sh`) is also live but only fires when the bucket env is bound.

---

## CHALLENGE_PAYLOAD_URL

The env var that `deploy-handler` injects into a CodeBuild execution when a problem's payload should be fetched from S3 instead of read from the local `problems/` directory. When set, `scripts/deploy-battles.sh`'s `resolve_problem_dir` downloads + unzips the URL into `/tmp/...` and substitutes that path before running `aws cloudformation deploy`. When unset, the script uses the in-repo `problems/<category>/<id>/` path directly (= source.zip bundled).

**Code**: `infrastructure/lib/problem-deploy/handlers/deploy-handler/presigned-url.ts`, `scripts/deploy-battles.sh`.

---

## CloudActionIntent

A structured, pre-flight audit record emitted by `deploy-handler` (and other "dangerous" Lambdas) before any AssumeRole / CFn / DDB-mutating operation. It captures who is acting (`tenantId`, `teamSlug`), what action (`deploy` / `delete` / etc), and which AWS API scopes are requested. Currently emitted *shadow-only* (= the operation still proceeds; the record is for forensic audit). Phase 2/3 of [ADR-017](./adr-017-cloud-action-intent-trust-bridge.html) will flip high-risk intents to require explicit operator approval.

**Code**: `packages/trust-bridge/`, `infrastructure/lib/problem-deploy/handlers/shared/trust-bridge-shadow.ts`.

---

## Competitor account

The AWS account owned by a **team** (= competitor). Problem stacks are CFn-deployed *into* this account, not into the platform account. The competitor pre-deploys [`infrastructure/templates/competitor-bootstrap.yaml`](../../infrastructure/templates/competitor-bootstrap.yaml) which creates an IAM Role with a trust policy requiring `ExternalId`. The platform's Worker Lambda then `sts:AssumeRole`s into that account using the per-tenant ExternalId stored in SSM.

This is the most security-sensitive boundary in the system. ExternalId is **always required** (no exceptions) and is verified at every AssumeRole call. The Role's permissions are the minimum needed to run that specific problem's `template.yaml`.

---

## Control Plane

The tenant manager. Built on top of SBT's `ControlPlane` construct ([`INVARIANT_CONTROL_PLANE_USES_SBT`](./harness.md)). Provides: System Admin Cognito UserPool, Tenant CRUD HTTP API, EventBridge bus, `admin-console` SPA. Does NOT run tenant business logic ([`INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`](./harness.md)).

**Code**: `infrastructure/lib/control-plane-stack.ts`, `apps/admin-console/`.

---

## deploy chain

The end-to-end sequence that starts when an operator clicks "Deploy" in `application-admin-console` and ends when CFn finishes inside the competitor account.

```
HTTP POST → deploy-handler (DDB Put + EventBridge Publish)
         → EventBridge DeployCreateRequested
         → Step Functions DeployCreateStateMachine
         → CodeBuild (scripts/deploy-battles.sh) → aws cloudformation deploy
         → CFn (in competitor account) → CREATE_COMPLETE
         → generic-scoring-handler picks up and starts polling
```

**Code**: `infrastructure/lib/problem-deploy/{deploy-api-lambda,deploy-event-rule,deploy-codebuild-project,deploy-create-state-machine}.ts`.

---

## Disruption

A scheduled or condition-triggered event that fires *during* a Battle to inject a complication (attack, hosting outage, score handicap). Declared in `metadata.disruptions[]` with a `trigger.kind` (`after-deploy` / `team-score-above` / `phase-entered`). The dispatcher Lambda subscribes to EventBridge and invokes a per-problem `disruption-fire` handler.

See [ADR-013](./adr-013-disruption-phase2-condition-triggered.html). Code: `infrastructure/lib/problem-deploy/handlers/event-handler/disruption-fire.ts`.

---

## EventBridge bus

The single cross-plane communication channel, owned by the Control Plane stack. Every other stack receives the bus ARN at synth time. Recurring detail types:

| Detail Type            | Producer                       | Consumer                                          |
| ---------------------- | ------------------------------ | ------------------------------------------------- |
| `onboardingRequest`    | SBT ControlPlane (tenant create) | `ServerlessSaaSPipeline` (PLATINUM silo deploy)  |
| `DeployCreateRequested` | `deploy-handler` / `event-handler` (bulk fan-out) | EventBridge Rule → DeployCreate state machine (CodeBuild) |
| `DeployDeleteRequested` | `deploy-handler` / `event-handler` (bulk delete) | EventBridge Rule → DeployDelete state machine (CodeBuild delete) |
| `BulkDeployCreateRequested` | `event-handler` (Distributed Map 経路, #910) | EventBridge Rule → BulkDeployCreate state machine |

Deploy completion and scoring are NOT bus events: completion is reconciled from CloudFormation
status into the Deployments table (describe-stack polling + state-machine writeback), and the
generic scoring Lambda runs on a 1-minute scheduled tick.

No SSE / WebSocket. Frontend uses polling (= matches Lambda operational model). [ADR-014](./adr-014-eventbridge-driven-state-reconciliation.html) supplements polling with EventBridge-driven reconciliation.

---

## ExternalId

Per-tenant secret (ULID) stored in SSM SecureString that gates AssumeRole into the competitor account. The competitor sets it when deploying `competitor-bootstrap.yaml`; the platform stores it in SSM after verification (`competitor-accounts-handler/verify.ts`). Every subsequent AssumeRole call passes it. Without ExternalId match, AssumeRole fails — this is the *only* thing preventing cross-tenant deployments if the platform's IAM Role identity were ever compromised.

---

## Generic scoring dispatcher

The platform-side Lambda (`generic-scoring-handler/`) that reads `metadata.scoring.kind` from each deploy and routes to one of 5 builtin handlers:

| `kind`                | Handler                                | Use case                                          |
| --------------------- | -------------------------------------- | ------------------------------------------------- |
| `flag`                | `kinds/flag.ts`                        | Challenge: one submission, exact-match a CFn Output |
| `uptime-flat`         | `kinds/uptime-flat.ts`                 | Battle: poll N endpoints independently, +pt per OK |
| `uptime-multi`        | `kinds/uptime-multi.ts`                | Battle: all-or-nothing, points only when all N OK   |
| `phased-polling`      | `kinds/phased-polling.ts`              | Battle: score rule changes by `phases[]` time       |
| `attack-detection`    | `kinds/attack-detection.ts`            | Battle: read attack counter, +pt per detection      |

The point is: **scoring code lives in the platform**, not in the problem. A new problem author picks a kind; they don't add new scoring code. ADR-012 governs this contract.

---

## Lite mode

The default deploy mode. `make deploy` (= `bun run scripts/tenkacloud-lite.ts up`) brings up exactly two stacks (AppPlaneCore + ProblemDeployBackend) with a single hardcoded `tenantId="local"`. Skips SBT ControlPlane, tenant pipeline, and the SystemAdmin invitation flow. Use case: one organizer running one event. Boots in ~10 min.

Opposite of SaaS mode (`make deploy-saas`). See Issue #955 and [ADR-016](./adr-016-tenkacloud-lite-app-plane-core.html).

---

## NamePrefix

The `tc-{problemSlug}-{teamSlug}` prefix injected as a CFn parameter into every problem template. Used to scope all resource names, tags, and IAM trust conditions when multiple teams' stacks coexist in the same competitor (account, region). The deploy chain auto-generates this from `metadata.id` + `team.name` slugified.

---

## ParticipantViewerRole

A required IAM Role inside every problem's `template.yaml` (= [`INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE`](./harness.md) is partially enforced via `problem-template-participant-viewer-role.test.ts`). The portal AssumeRoles into it via the Console federation flow (= one-click "open in AWS Console" button), giving the competitor read-only access to *their own* problem resources via tag-based IAM conditions.

The baseline policy must restrict `Resource: "*"` to either a tag-based Condition (`aws:ResourceTag/TenkaCloud:NamePrefix`) or a small allowlist of metadata-only / self-identity API SIDs (`ConsoleEc2Metadata`, `ConsoleSelfIdentity`). Cross-tenant resource leak is the threat model. Test enforces this via `RESOURCE_STAR_OK_SIDS`.

**Code**: `infrastructure/lib/problem-deploy/handlers/participant-handler/sso.ts` (the AssumeRole caller), `problems/**/template.yaml` (the resource itself).

---

## Plugin (problem-as-plugin)

The architectural pattern from ADR-012: a problem ships **content + UI slot + scoring metadata** to a generic platform host. The platform doesn't know what `microservice-migration-battle` *is*; it only knows how to read its `metadata.json`, deploy its `template.yaml`, mount its `portal/<slot>.tsx` into the participant portal, and poll its endpoints per the metadata.

Three-asset model (+ optional fourth): `metadata.json` (required) + `template.yaml` (required) + `README.md` (English, primary) / `README.ja.md` (Japanese mirror) (required) + `portal/` (optional UI) + `services/` (optional in-stack code).

---

## Pooled vs Silo

The two SaaS tenant isolation models, both supported in SaaS mode.

- **Pooled** — BASIC / ADVANCED tenants share one CDK stack. Cheaper, faster onboarding.
- **Silo** — PLATINUM tenants each get their own stack via `ServerlessSaaSPipeline`. Stronger isolation, higher cost.

Lite mode is implicitly pooled (= one tenant, one stack). See [ADR-018](./adr-018-pooled-userpool-saml-isolation.html).

---

## Problem (catalog item)

A single directory inside the `problems/` submodule that the platform can deploy as one unit. Composed of metadata + a CFn template + optional portal/services code. The "problems repo" is [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge).

See "Plugin" for the architectural framing and "Battle vs Challenge" for the two category shapes.

---

## SaaS mode

The opt-in multi-tenant deploy mode. `make deploy-saas` runs `scripts/install.sh` to do a 3-phase install: (1) ControlPlane + bootstrap + pooled tenant template + per-tenant pipeline, (2) host-build admin-console + deploy `AdminConsoleHostingStack`, (3) re-deploy ControlPlane with the CloudFront URL to fix callback / CORS. Use case: multi-organizer SaaS.

Opposite of Lite mode.

---

## Scoring kind

See "Generic scoring dispatcher" — one of 5 builtin handlers chosen by `metadata.scoring.kind`. Adding a new kind = a platform-side PR (new file in `kinds/`), not a problem-side change.

---

## source.zip

The packaging artifact uploaded to S3 (`s3://tenkacloud-source-<account>-<region>/source.zip`) by `scripts/prepare-source-bundle.sh`. Contains the repo + the `problems/` submodule contents + per-app `dist/`. CodeBuild pulls this every time it runs `scripts/deploy-battles.sh`. Re-running `prepare-source-bundle.sh` is how an operator pushes a problem update without redeploying any Lambda.

---

## SystemAdmin

The Cognito user role in the Control Plane UserPool. Created via email invitation during `make deploy-saas` (env `SYSTEM_ADMIN_EMAIL`). In Lite mode there is no SystemAdmin — the single tenant is hardcoded and the admin console is the only auth boundary.

---

## TenantId

The string that scopes every per-tenant resource. In Lite mode it is hardcoded to `"local"`. In SaaS mode it is `"pooled"` for pooled-tier tenants or a ULID for silo (PLATINUM) tenants. Used as the DDB partition key on every per-tenant table and as the EventBridge detail field for cross-plane routing.

---

## TenkaCloudChallenge

The catalog repo: <https://github.com/susumutomita/TenkaCloudChallenge>. Mounted as a Git submodule at `problems/` in this repo. Holds the actual problem content (battles + challenges) while the platform repo holds the host that deploys/scores them. The split is the physical manifestation of [ADR-012](./adr-012-problem-plugin-architecture.html) + [ADR-008](./adr-008-problem-payload-separation.html).

---

## Tier

The pricing tier a tenant belongs to: BASIC / ADVANCED / PLATINUM (the old PREMIUM name was renamed to PLATINUM in PR-56). BASIC / ADVANCED are pooled; PLATINUM is silo. Determined at tenant-create time and stored on `TenantDetails`. The pipeline decides pooled vs silo based on tier. (SBT's internal per-tier API-key SSM parameters still use SBT's own basic/standard/premium/platinum names — those are SBT-internal and distinct from the product tiers.)

---

## TrustBridge

The audit-and-eventually-approval layer for risky cross-account actions. See "CloudActionIntent" above for the implementation handle and [ADR-017](./adr-017-cloud-action-intent-trust-bridge.html) for the full design. The name comes from the role it plays: a logged bridge between the platform's identity and the competitor's account, where every crossing is recorded and (in future phases) gated.

**Code**: `packages/trust-bridge/`, `infrastructure/lib/problem-deploy/handlers/shared/trust-bridge-shadow.ts`.

---

## visibility

A metadata field (`metadata.visibility`) on each problem. `"public"` problems ship via the OSS `problems/` submodule (= source.zip route). `"private"` problems would ship via a separate answer repo using the dormant ChallengePayloadStack S3 route. Currently all problems in the catalog repo are `"public"`. The `parseProblemsVisibility` helper remains in the codebase to support the private route when an answer repo gets set up.

---

## Pointer-only entries (= things you'll see in the codebase but that have their own canonical docs)

| Term                                  | Where it's defined                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ADR (Architecture Decision Record)    | `docs/architecture/adr-*.html` (HTML by convention; markdown ADRs are forbidden by harness rule) |
| Cloudscape Design System              | <https://cloudscape.design/components/> — picked as the SPA UI library default                  |
| CDK Aspect                            | `infrastructure/lib/cdk-aspect/` — see MODULE_MAP for the active Aspects                        |
| SBT (SaaS Builder Toolkit)            | `@cdklabs/sbt-aws` 0.3.9 — provides `ControlPlane` construct + tenant onboarding events         |
| Mini Shai-Hulud (2nd wave)            | Supply-chain attack pattern. Mitigation: see CLAUDE.md / AGENTS.md "Supply chain security"      |
| Conventional Commits                  | <https://www.conventionalcommits.org/> — PR title format requirement                            |
