# TenkaCloud Module Map

> "Where does X live?" reference. For the 10-minute architectural narrative, read [OVERVIEW.md](./OVERVIEW.md) first. For term definitions, see [GLOSSARY.md](./GLOSSARY.md). For "I want to do X, where do I edit?" recipes, see [CONTRIBUTOR_MAP.md](../../CONTRIBUTOR_MAP.md).

This document maps directories to **who owns them**, **what they're responsible for**, and **what the main entry point is**. It does not describe decisions — those live in ADRs (`adr-*.html` in this directory).

## Top-level layout

```
TenkaCloud/
├── apps/                       # Vite + React 19 + Cloudscape SPAs + CLI
├── infrastructure/             # CDK (SBT 0.3.9) — every backend is a Lambda
├── scripts/                    # Orchestration: install / cleanup / deploy / etc
├── packages/                   # Cross-app shared TypeScript packages
├── problems/                   # ← git submodule of TenkaCloudChallenge (catalog)
├── docs/                       # ADRs, harness rules, architecture narratives
├── landing/                    # Static OSS landing page (CloudFront)
├── Makefile                    # Single entry point for every workflow
├── CLAUDE.md / AGENTS.md       # Project rules (humans + AI agents)
├── CONTRIBUTOR_MAP.md          # "I want to do X" navigation
├── ROADMAP.md / SECURITY.md
└── biome.json / package.json / mise.toml
```

## `apps/*`

User-facing SPAs and the CLI. All built with Vite + Bun. Each loads `runtime-config.json` from S3 at boot to learn its backend URL (= per-tenant). No tenant logic in app code — that's an invariant ([`INVARIANT_APP_CODE_IS_UNMODIFIED`](./harness.md)).

| Path                              | Audience                     | Backend it talks to                                   | Dev port | Entry point                              |
| --------------------------------- | ---------------------------- | ----------------------------------------------------- | -------- | ---------------------------------------- |
| `apps/admin-console/`             | System Admin (organizer ops) | Control Plane API (SBT)                               | 5173     | `src/main.tsx`                           |
| `apps/application-admin-console/` | Tenant Admin                 | per-tenant Application Plane API                      | 5174     | `src/main.tsx`                           |
| `apps/participant-portal/`        | Competitor                   | Problem Deploy Backend (participant routes)           | 5175     | `src/main.tsx`                           |
| `apps/cli/`                       | Operator / AI agent          | Cognito Hosted UI + Control Plane API (Phase 2 WIP)   | n/a      | `bin/tenkacloud.ts`                      |
| `apps/landing-page/`              | OSS visitor                  | (static)                                              | n/a      | `index.html`                             |

## `infrastructure/lib/`

CDK stacks and Lambda handlers. **This directory is the user's responsibility** ([AGENTS.md role-split](../../AGENTS.md)). AI agents propose; the user reviews and decides on infra changes.

### Stack-level entries (one CDK stack per file)

| Path                                                                  | Stack name (development)              | Purpose                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `control-plane-stack.ts`                                              | `tenkacloud-control-plane`            | SBT ControlPlane + EventBridge bus + Tenant CRUD API                                     |
| `admin-console-hosting.ts`                                            | `tenkacloud-admin-console-hosting`    | admin-console SPA on S3 + CloudFront                                                     |
| `admin-console-runtime-config-stack.ts`                               | `tenkacloud-admin-console-runtime-config` | Writes `runtime-config.json` into the SPA bucket post-deploy                           |
| `admin-insight/admin-console-insight-stack.ts`                        | `tenkacloud-admin-insight`            | System Admin observability + audit log API                                               |
| `bootstrap-template/bootstrap-template-stack.ts`                      | `tenkacloud-bootstrap`                | TenantMappingTable + deprovisioning Step Functions                                       |
| `tenant-template/tenant-template-stack.ts`                            | `tenkacloud-tenant-template-*`        | Per-tenant API + Cognito + application-admin-console hosting                       |
| `tenant-pipeline/serverless-saas-pipeline.ts`                         | `ServerlessSaaSPipeline`              | PLATINUM-tier silo deploy via CodePipeline                                               |
| `problem-deploy/problem-deploy-backend-stack.ts`                      | `tenkacloud-problem-deploy`           | Deployments DDB + Worker Lambda + Participant Portal hosting + CodeBuild deploy executor |
| `challenge-payload/challenge-payload-stack.ts`                        | `tenkacloud-challenge-payload`        | S3 bucket + GitHub OIDC IAM Role (= dormant; for future "additional problems" repo)      |
| `tenkacloud-lite/*` (under `app-plane-core`)                          | `tenkacloud-lite-*`                   | Lite-mode-specific entries (Cognito + AppPlaneCore wiring without SBT)                   |
| `observability/cloudwatch-dashboard-stack.ts`                         | `tenkacloud-observability`            | CW Dashboard + Cost Budget + Free Tier Alarms                                            |

### Lambda handlers (inside `problem-deploy/handlers/`)

All Lambdas use Hono on Lambda + Cognito JWT auth. Validation with Zod at the boundary; no `AUTH_SKIP` anywhere.

| Path                                  | Lambda role                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `handlers/deploy-handler/`            | `POST /deployments` etc. Emits `DeployCreateRequested` event after DDB Put.                      |
| `handlers/event-handler/`             | Events/Teams CRUD + bulk deploy/delete fan-out (`DeployCreateRequested` / `DeployDeleteRequested`) |
| `handlers/generic-scoring-handler/`   | Dispatches by `metadata.scoring.kind` to one of 5 builtin handlers (`kinds/*.ts`)                |
| `handlers/participant-handler/`       | Competitor-facing API: list deployments, submit flag, request Console SSO URL (`sso.ts`)        |
| `handlers/competitor-accounts-handler/` | Verify-and-store competitor's AWS account + region + ExternalId                                |
| `handlers/admin-audit-handler/`       | Read-side for the admin audit log (ADR-020 Phase D)                                              |
| `handlers/event-api-handler/`         | CRUD for organizer events                                                                        |
| `handlers/shared/`                    | catalog parser, visibility resolver, ExternalId store, CFn status helpers, trust-bridge shadow   |

### Cross-cutting Aspects (`infrastructure/lib/cdk-aspect/`)

| File                                  | Effect                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dynamodb-low-capacity.ts`            | Forces all DDB tables to PROVISIONED 1 RCU / 1 WCU (Free Tier guard)                            |
| `destroy-policy-setter.ts`            | Sets `RemovalPolicy.DESTROY` on most resources for dev tear-down                                |
| `kms-key-short-pending-window.ts`     | Trims KMS key deletion window to dev-friendly 7 days                                            |
| `codebuild-use-aws-managed-kms.ts`    | Replaces customer-managed KMS key on CodeBuild artifacts with `alias/aws/s3`                    |

### App composition

| Path                                 | Role                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `infrastructure/bin/infrastructure.ts` | CDK app entry point. Delegates to `app-wiring`.                                                   |
| `infrastructure/lib/app-config/`     | Resolves env vars + `environments/<env>/{config.json,.env}` into `AppConfig`. Pure function.        |
| `infrastructure/lib/app-wiring/`     | `buildTenkaCloudApp(app, config)` — instantiates every stack in the right order with dependencies.  |
| `infrastructure/lib/config/`         | `Config` TypeScript interface + JSON Schema for `config.json` validation.                           |

## `scripts/`

| Script                                | Purpose                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `install.sh`                          | SaaS mode 3-phase install (`make deploy-saas`). Sources `prepare-source-bundle.sh`.          |
| `cleanup.sh`                          | Idempotent teardown of every SaaS stack + S3 buckets.                                        |
| `prepare-source-bundle.sh`            | Builds `source.zip` for CodeBuild. Initializes the `problems/` submodule first.              |
| `package-source-bundle.sh`            | Builds the AWS-free local `source.zip` archive from an explicit root allowlist.              |
| `deploy-battles.sh`                   | Run inside CodeBuild. `aws cloudformation deploy` against the competitor account.            |
| `delete-battles.sh` / `destroy-battles.sh` | Mirror for stack teardown.                                                              |
| `provision-tenant.sh` / `deprovision-tenant.sh` | Per-tenant CodeBuild scripts for the SaaS tenant pipeline.                          |
| `update-tenant.sh`                    | Push a new source.zip + redeploy a single tenant's stack.                                    |
| `tenkacloud-lite.ts`                  | `make deploy` (Lite mode). Brings up AppPlaneCore + ProblemDeployBackend without SBT.        |
| `tenkacloud-ops.ts`                   | One-off operator tasks (e.g., promote tenant tier).                                          |
| `tenkacloud-problem.ts`               | Local problem scaffolding CLI (`create / validate / inspect / list-kinds`). Wraps `problem-cli/`. |
| `validate-problems.ts`                | Runs `metadata.json` schema + cross-ref checks (used by `make validate-problems`).           |
| `build-problem-index.ts`              | Generates `problems/index.json` from all `metadata.json` files (catalog repo owns this now). |
| `check-template-*.ts`                 | CFn template static checks (ASCII safety / security patterns / `!Ref` integrity).            |
| `audit-dependencies.ts`               | Supply-chain audit: diffs lifecycle scripts vs `audit-baseline.json`.                        |
| `migrate-tier-premium-to-platinum.sh` | One-off data migration (one-shot script kept for history).                                   |

## `packages/`

Cross-app shared TypeScript libraries. Published only inside the monorepo (bun workspaces).

| Path                                | Purpose                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/trust-bridge/`            | TrustBridge primitives (ADR-017): CloudActionIntent shape, shadow audit emitter, structured log helpers. Used by both deploy-handler and admin-audit. |
| `packages/portal-plugin-sdk/`       | Public types for `problems/<id>/portal/*.tsx` slot components. Catalog-side authors import these. |

## `problems/`

Git submodule of [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge). Layout inside (= catalog repo's repo root):

```
battles/<id>/                  metadata.json + template.yaml + optional portal/ services/
challenges/<id>/               same
SCHEMA.json                    JSON Schema for metadata.json (= contract with platform)
index.json                     Catalog index built from all metadata
scripts/validate-problems.ts   Catalog-side validator (catalog CI uses this)
```

To bump the submodule pointer: `git submodule update --remote problems && git add problems && git commit`.

## `docs/`

| Path                                | Audience              | Format             |
| ----------------------------------- | --------------------- | ------------------ |
| `docs/architecture/adr-*.html`      | Anyone making design decisions | HTML (= ADR convention; see [`adr-must-be-html`](./harness.md) rule) |
| `docs/architecture/harness.md`      | Anyone editing CDK    | Markdown (machine-checked invariants) |
| `docs/architecture/OVERVIEW.md`     | First-time contributor | Markdown (this doc set) |
| `docs/architecture/MODULE_MAP.md`   | "Where is X?" lookups | Markdown (this doc set) |
| `docs/architecture/GLOSSARY.md`     | Term definitions       | Markdown (this doc set) |
| `docs/problems/AUTHORING.html`      | Problem author        | HTML (30-min onboarding) |
| `docs/operations/`                  | Operator on-call       | HTML |
| `docs/lore/world.html`              | Problem worldbuilding  | HTML |
| `docs/api/`                         | Backend API consumers  | HTML |
| `docs/gallery.{md,html}`            | Problem catalog viewer | both |
| `docs/ux/`, `docs/go-to-market/`, `docs/requirements/` | Background context | HTML |

## Build / CI / lint

| Path                                | Role                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Makefile`                          | Single entry point. All workflows go through `make <target>`. Run `make help` for the full list.    |
| `package.json` (root)               | bun workspaces, lint scripts (`lint:md`, `lint:text`, `lint:format`), shared dev deps.              |
| `infrastructure/package.json`       | CDK deps + per-stack vitest cases.                                                                  |
| `apps/*/package.json`               | Per-app Vite + React deps + per-app vitest.                                                         |
| `.github/workflows/ci.yml`          | PR-time gate: install_ci + audit-deps + lint_text + format_check + typecheck + test-coverage + build. |
| `.claude/harness/`                  | Architecture invariant harness + tech-debt scanner. Entry points: `bin/architecture.ts`, `bin/tech-debt.ts`; rules one-per-file under `src/rules/` + `src/tech-debt/`. |
| `biome.json`                        | Lint / format config. `files.includes` excludes the `problems/` submodule.                          |
| `.textlintignore`                   | Excludes vendor docs + the `problems/` submodule from Japanese style linting.                       |

## `infrastructure/templates/`

CFn templates rolled out **into the competitor's AWS account** (not the platform account).

| File                                | Purpose                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `competitor-bootstrap.yaml`         | One-time IAM Role + trust policy (= ExternalId required) the competitor deploys before joining. |
| `README.md`                         | Competitor-side setup instructions.                                                              |
