# TenkaCloud

A multi-tenant SaaS cloud competition platform on AWS. Problems are delivered in two categories: **Battle** (real-time, head-to-head) and **Challenge** (self-paced, evergreen) — formerly known as GameDay / JAM. Built on top of SBT (`@cdklabs/sbt-aws` 0.3.9), with the Control Plane, Application Plane, and per-competitor problem deployment all expressed in CDK.

## Architecture

```
TenkaCloud/
├── apps/                                    # Vite + React 19 + Cloudscape SPAs
│   ├── admin-console/                       # System Admin (Control Plane UI, dev :5173)
│   ├── application-admin-console/           # Tenant Admin (Application Plane UI, dev :5174)
│   ├── participant-portal/                  # Competitor portal (dev :5175)
│   └── developer-portal/                    # Pack-author-facing docs/tools SPA
├── packages/                                # Shared workspace libraries (auth-client, saml-utils,
│   │                                         # problem-runtime, problem-sdk, format,
│   │                                         # coordination-plugin-sdk, portal-contracts, web-kit,
│   │                                         # portal-plugin-sdk, problem-cost, problem-test-harness, trust-bridge)
├── infrastructure/                          # CDK (SBT 0.3.9) — every backend is a Lambda
│   ├── bin/infrastructure.ts                # Stack wiring entry point
│   ├── lib/
│   │   ├── control-plane-stack.ts           # SBT ControlPlane (Cognito + EventBridge + API)
│   │   ├── bootstrap-template/              # Tenant pipeline bootstrap (TenantMappingTable)
│   │   ├── tenant-template/                 # One tenant's API + Cognito + ApplicationConsole hosting
│   │   ├── tenant-pipeline/                 # Per-tenant provisioning via CodePipeline
│   │   ├── problem-deploy/                  # Problem deployment into competitor AWS (DDB + Worker Lambda + API)
│   │   ├── admin-console-hosting.ts         # admin-console served via S3 + CloudFront
│   │   ├── cdk-aspect/                      # DynamoDbLowCapacity / DestroyPolicySetter
│   │   ├── config/                          # config.json schema + interface
│   │   └── utils/                           # config-loader, iam-helpers
│   ├── environments/<env>/{config.json,.env}# Per-environment config; .env injects ${VAR:-default}
│   └── templates/competitor-bootstrap.yaml  # One-time IAM Role rolled out in the competitor account
├── scripts/                                 # install.sh / cleanup.sh / provision-tenant.sh, etc.
├── packs/                                   # In-repo sample/golden/reference problem packs (ADR-012 3-asset model)
├── problems/                                # Git submodule → TenkaCloudChallenge (the community catalog).
│   │                                         # Empty until `git submodule update --init`; cloned fresh at deploy time
├── landing/                                 # Static marketing/demo site (GitHub Pages build output + locales)
└── .github/workflows/ci.yml                 # PR-time lint / typecheck / test / build
```

### Plane layout

- **Control Plane** (`ControlPlaneStack`) — SBT-bundled Cognito UserPool + System Admin + Tenant CRUD API + EventBridge bus. `admin-console` is the front end.
- **Application Plane (pooled)** — One `tenkacloud-tenant-template-pooled` instance stands up during Phase 1. BASIC / ADVANCED tenants share a single `application-admin-console` URL behind CloudFront.
- **Application Plane (silo)** — On PLATINUM tier tenant creation, `ServerlessSaaSPipeline` kicks off CodeBuild and deploys a dedicated `tenkacloud-tenant-template-<tenantId>` for that tenant.
- **Problem deploy backend** (`ProblemDeployBackendStack`) — Deployments DDB + Cognito JWT-authenticated HTTP API + Worker Lambda. EventBridge `DeployCreateRequested` is picked up, the worker AssumeRoles into the competitor account using the tenant's ExternalId, then CFn CreateStack runs there.
- **Participant Portal** — App where each competitor sees their team's problem endpoints and scores. Hosted on S3 + CloudFront from `ProblemDeployBackendStack` (enable via `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true`).

### Cross-plane communication

Goes through the EventBridge bus (Control Plane provisions it; `bin/infrastructure.ts` hands the ARN to other stacks). The frontend hits each API using `runtime-config.json` + Cognito JWT.

### Data isolation

We don't use a single-table DynamoDB design. Each stack owns its own tables (TenantMappingTable / Deployments / Apps / etc.), and tenant isolation is enforced via the `TenantId` partition key or by stack separation. **Every table is forced to PROVISIONED 1 RCU / 1 WCU by a CDK Aspect (`DynamoDbLowCapacity`)** to hold DynamoDB capacity at the practical minimum — originally sized to the legacy AWS Free Tier's always-free 25 RCU/WCU allowance. This is a **standing cost**, not free: new-style AWS Free Tier accounts (2025-07 onward) are credit-based and have **no** always-free 25 RCU/WCU DynamoDB tier, so provisioned tables accrue Usage from the first hour (credits may zero out the visible bill, but the charge is real once credits run out). The near-$0 personal path is an opt-in Turso (libSQL) control-data backend (`CDK_PARAM_CONTROL_DATA_BACKEND`, tracker #2435), selectable per problem-deploy-backend deploy: `dynamodb` (default, unset) leaves every table on DynamoDB unchanged; `turso`/`sql` is **pure SQL** — CDK does not synth the Events / Teams / Deployments / ProblemEndpoints / CompetitorAccounts / Disruptions / AdminAuditLog DynamoDB tables at all, and as of #2499 (C5) the same holds for the eighth and last Lite-mode control-data table, SamlIdps, whose `/tenant/idp*` CRUD Lambda is decoupled from table presence and keeps working against the SQL repository — `CDK_PARAM_CONTROL_DATA_BACKEND=turso` now yields a Lite synth with **zero `AWS::DynamoDB::Table` resources**, which is what actually removes the standing cost, not just the read/write path; `turso-mirror`/`sql-mirror` is a **migration bridge** that keeps DDB canonical (all tables still exist) while mirroring writes into SQL, for validating a cutover before switching to the pure value. This is implemented and covered by CDK-synth (`Template.fromStack`) and repository-seam unit tests, but has not yet been exercised as a live end-to-end deploy against a real Turso database. See the README "Running costs" section for the opt-in walkthrough.

## Commands

| Command                 | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `make install`          | Install dependencies for every workspace (bun)                           |
| `make build`            | Build every workspace (`infrastructure` → 3 SPAs)                        |
| `make typecheck`        | `tsc --noEmit` across every workspace                                    |
| `make test`             | `vitest` across every workspace                                          |
| `make test-scripts`     | Fast path: infrastructure script/CLI tests only (`test/scripts/`) — no CDK synth |
| `make lint`             | markdownlint + textlint + biome                                          |
| `make fix`              | Auto-fix variant of the above (`make format` works too)                  |
| `make before-commit`    | lint + test — fast local sanity check, NOT a full CI mirror (see below)  |
| `make ci-local`         | Full CI mirror (audit-deps / submodule guard / lint / typecheck / coverage-gate / build), minus Codecov upload |
| `make dev`              | Start all 3 SPA dev servers in parallel (admin-console :5173 / application-admin-console :5174 / participant-portal :5175) |
| `make synth`            | Full `cdk synth` (real Lambda bundling — matches what `deploy` runs)     |
| `make check-synth`      | Fast synth-shape check (`CDK_SKIP_BUNDLING=1`) + IAM Description ASCII gate |
| `make deploy`           | **Lite mode** (single-tenant) deploy. Stands up AppPlaneCore + Participant Portal via `infrastructure/bin/tenkacloud-lite.ts` (#955) |
| `make deploy-saas`      | **SaaS mode** (multi-tenant) deploy. Runs `scripts/install.sh` (3-phase deploy, stands up SBT ControlPlane) |
| `make destroy`          | Tear down Lite mode                                                       |
| `make destroy-saas`     | Tear down SaaS mode (`scripts/cleanup.sh` idempotently removes every stack + S3) |
| `make harness`          | Architecture invariant check (`.claude/harness/`)                       |
| `make harness-test`     | Unit tests for the harness itself (`.claude/harness/`)                   |
| `make tech-debt`        | Tech-debt scan (test smell / coupling / responsibility gaps)             |
| `make doctor`           | Diagnose local toolchain / environment setup issues                      |
| `make audit-deps`       | Supply-chain dependency lifecycle-script audit (see Supply chain security below) |
| `make install_ci`       | CI-only install: `bun install --frozen-lockfile --ignore-scripts` + Safe Chain |
| `make local`            | Docker local-play (no AWS) for one problem — `make local-up` / `local-down` / `local-status` / `local-evaluate` |
| `make help`             | List every Makefile target                                               |

Switch environments with `make deploy ENV=production` and similar. It loads `infrastructure/environments/<env>/.env`; if missing, `make env-check` (SaaS mode) / `make env-check-lite` (Lite mode, no `SYSTEM_ADMIN_EMAIL` required) fail with an error.

## Architecture invariants

Codified as one-rule-per-file under `.claude/harness/src/rules/` (summarized in the table below). `make harness` runs `.claude/harness/bin/architecture.ts` against staged files and reports deviations as errors.

| ID                                                    | Summary                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `INVARIANT_CONTROL_PLANE_USES_SBT`                    | The **SaaS-mode** Control Plane must sit on top of the `@cdklabs/sbt-aws` ControlPlane construct. Lite mode (ADR-016) and Always-On mode (ADR-049) do not use SBT and are out of scope. |
| `INVARIANT_CONTROL_PLANE_DOES_NOT_HOST_TENANT_RUNTIME`| The Control Plane is the tenant manager. Tenant runtime must not live there       |
| `INVARIANT_TENANT_ISOLATION_AT_INFRA_LAYER`           | Tenant isolation lives in the infra layer (DDB PK / stack separation). No tenant logic in the app |
| `INVARIANT_APP_CODE_IS_UNMODIFIED`                    | `apps/*/dist/` is shared across tenants. Differences must flow through `runtime-config.json` |
| `INVARIANT_AUTH_INJECTED_AT_INFRA_LAYER`              | Auth is injected at the infra layer. Don't add `AUTH_SKIP`-style bypasses to the app |
| `INVARIANT_PR_SHIPS_WORKING_INCREMENT`                | Every PR ships an observable, working slice. Scaffolding-only PRs are not allowed  |
| `INVARIANT_PR_TESTS_COUPLED_WITH_CHANGE`              | Code and tests change in the same PR. If existing tests already cover it, say so in the PR body |
| `INVARIANT_PR_REGRESSION_ANALYSIS_DOCUMENTED`         | PR body must include a `## Regression analysis` section listing what could break    |
| `INVARIANT_PR_PHYSICAL_IMPACT_DOCUMENTED`             | PR body must include a `## Physical impact` section labeling CFn / artifact diffs as CREATE/UPDATE/REPLACE/DELETE/NO-OP |
| `ONE_PASS_LOCAL`                                      | Locally, tenant creation → application console → problem deploy → participant join all flow in a single browser pass |
| `ONE_PASS_AWS`                                        | `make deploy-saas` (SaaS mode) runs all three phases end-to-end: SystemAdmin invite → tenant creation → problem deploy → competitor login |

We also machine-check the following enforcement rules:

- `secrets-manager-forbidden` — `@aws-sdk/client-secrets-manager` is forbidden (use SSM Parameter Store SecureString — cost-zero principle)
- `handler-must-not-call-fetch` — `lib/handlers/` must not call `fetch(` directly (keep it inside Service / Repository)
- `adr-must-be-html` — ADRs live in `docs/architecture/adr-*.html`. Markdown ADRs are forbidden
- `adr-self-contained` — ADRs must not retain chat context, rolling-update metadata, or notes about which AI agent owns what

## Development flow

### ADR conventions

ADRs are authored in `docs/architecture/adr-*.html` as the source of truth; we do not write them in Markdown. Use HTML's expressive features (row spans, color, SVG, collapsible sections, etc.) to make design decisions easier to read.

ADRs must be self-contained for OSS readers. Do not leave chat context, rolling-update metadata, role-split notes such as `Claude proposes` / `user owns`, or unresolved TODOs. Write the background, decision, impact, alternatives, and migration plan so each ADR is understandable on its own.

### Gates (before opening a PR)

1. `make harness` — zero architecture invariant violations
2. `make before-commit` — lint / test must pass
3. `/review` — code review
4. `/security-review` — security review
5. `/simplify` — final pass for duplication, complexity, and wasted code

You are not done until they all pass. If something fails, find the root cause and fix the code (don't edit `biome.json` / `vitest.config.ts` / etc. to mask it).

`make before-commit` (lint + test) is a fast sanity check, not a full CI mirror — CI (`.github/workflows/ci.yml`) additionally runs `audit-deps`, the submodule pin guard, **problem-catalog validation** (`make validate-problems` — schema + the bilingual `README.md`/`README.ja.md` invariant, #2254), and a 3-shard coverage matrix (infrastructure / spas / packages, #2513) that runs a per-shard 100％ coverage gate for agent-owned workspaces plus a per-shard Codecov upload that Codecov merges into one commit report, so a green `before-commit` does not guarantee a green CI. Run `make ci-local` for the full mirror (same checks CI runs, same order, minus the Codecov upload) before opening a PR if you want that guarantee locally.

### Available skills

Live under `.claude/skills/` and are invoked as `/<skill-name>`.

| skill              | Purpose                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `/harness`         | Run `make harness` to detect architecture invariant violations                          |
| `/tech-debt`       | Run `make tech-debt` to generate the tech-debt backlog (assertion roulette / coupling / fallback detection) |
| `/quality-gates`   | Run the off-body quality-gate checks (HTTP magic numbers / template / coverage / IAM ASCII / merge / submodule) |
| `/spec`            | Write a technical specification in the Open Web Docs (MDN) style                       |
| `/blindspot-pass`  | Review-only pass over an Issue / ADR / PR diff / directory to surface unknown-unknowns (unconnected producer/consumer, per-route default drift, split data seams) with code-backed evidence |

### TDD

Write tests first. Test titles use the English `should ...` pattern. Vitest runs per workspace (`infrastructure/vitest.config.ts`, plus each SPA's `vite.config.ts`).

```typescript
describe("AdminConsoleHostingStack", () => {
  it("should place runtime-config.json on the CloudFront distribution", () => {
    // ...
  });
});
```

### Issue reference rules

Use GitHub's auto-close keywords **without parentheses**.

- **Closes the issue on merge** = `Closes #553` / `Fixes #553` / `Resolves #553` (auto-closes on merge)
- **Related but does not close** (partial fix / pure backlink) = `Relates #553`, or mention `#553` in a non-keyword position
- **PR-to-PR references** = write `PR-565` with a number prefix to distinguish from issue numbers

The old rule of wrapping `(#N)` in parentheses to suppress auto-close was a misunderstanding of the spec. Without a keyword like `Closes`, a bare `#N` does **not** trigger auto-close — it only creates a backlink.

### HTTP status codes: no magic numbers

Writing numeric literals like `c.json(body, 500)` is forbidden. Use the `StatusCodes` enum from `http-status-codes`.

```ts
import { StatusCodes } from "http-status-codes";

return c.json({ ok: true }, StatusCodes.OK);                         // ✅
return c.json({ error: "..." }, StatusCodes.INTERNAL_SERVER_ERROR);  // ✅
return c.json({ ok: true }, 200);                                    // ❌ magic number
```

The frontend response checks follow the same rule.

```ts
if (res.status === StatusCodes.UNAUTHORIZED) throw new PortalAuthError();  // ✅
if (res.status === 401) throw new PortalAuthError();                       // ❌
```

`StatusCodes.*` usage is enforced across the codebase — the legacy `HTTP_OK`-style numeric aliases have been removed entirely (0 usages remain).

## Prohibited

- **No `npx`** → use `bunx` or `nlx`
- **No `rm`** → delete files through `git rm`
- **No HTTP status code literals** — use `StatusCodes.*` (`http-status-codes` library)
- **No silent fallbacks via mocks / stubs** — if it fails, fail loudly
- **No on-demand DynamoDB (PAY_PER_REQUEST)** — the `DynamoDbLowCapacity` Aspect enforces 1/1 PROVISIONED; any change that breaks this will show up in the CFn output
- **No direct edits to config files (`biome.json`, each `vitest.config.ts`, `tsconfig.json`)** — fix the code instead
- **No committed secrets (`.env`, AWS credentials)** — they are excluded by `.gitignore`; only `infrastructure/environments/<env>/.env.example` is committed

## Security

- Validate user input / external API boundaries with Zod
- Do not implement auth bypasses (this repo has no `AUTH_SKIP`; every request goes through Cognito JWT)
- No `innerHTML` / `eval` / `dangerouslySetInnerHTML`
- AssumeRole into competitor accounts **always requires `ExternalId`** (`CDK_PARAM_DEPLOY_EXTERNAL_ID`)
- The IAM Role in `infrastructure/templates/competitor-bootstrap.yaml` is least-privilege (only CFn CreateStack + whatever AWS services each problem template touches)
- Dependencies are updated by Renovate / Dependabot; CI runs Safe Chain as a best-effort check for malicious packages (`continue-on-error: true` — its own outage doesn't block CI; `--ignore-scripts` + `audit-deps` are the hard defense)

### Supply chain security (mini Shai-Hulud 2nd-wave mitigation, see [blog.flatt.tech/entry/mini_shai_hulud_2nd](https://blog.flatt.tech/entry/mini_shai_hulud_2nd))

A four-layer defense against credential-exfil attacks that abuse `prepare` / `postinstall` and other transitive lifecycle scripts.

1. **Bun `trustedDependencies`**: Bun blocks transitive lifecycle scripts by default (secure by default). The `trustedDependencies` array in `package.json` is the explicit allowlist (currently empty).
2. **`.npmrc`**: `ignore-scripts=true` + `min-release-age=168h` (7-day quarantine, npm 11+). Even if a contributor uses npm / yarn / pnpm, the protection is automatic.
3. **CI audit** `make audit-deps` (`scripts/audit-dependencies.ts`): Scans `node_modules`, diffs packages with lifecycle scripts against `scripts/audit-baseline.json`, and fails on any new addition or new hook on an existing dep.
4. **CI install policy** `make install_ci`: `bun install --frozen-lockfile --ignore-scripts` + Aikido Safe Chain malicious package detection (Safe Chain's own setup step is `continue-on-error: true` — best-effort, not a hard CI gate; layers 1-3 are).

Add packages to `trustedDependencies` in a stand-alone PR. Manually verify the script contents and summarize them in the PR body (if you see suspicious `curl` / `wget` / OS persistence / env-var exfil, do not add to the baseline — report it instead).

## Tech stack

| Layer            | Tech                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| Frontend         | Vite 7, React 19, react-router 7, Cloudscape Design System            |
| Backend          | AWS Lambda (Node.js / Hono on Lambda), API Gateway HTTP API           |
| IaC              | AWS CDK 2 + `@cdklabs/sbt-aws` 0.3.9, cdk-nag                         |
| Auth             | AWS Cognito (Hosted UI + OAuth Code + PKCE)                           |
| Data             | DynamoDB (forced PROVISIONED 1/1)                                     |
| Events           | EventBridge (cross-plane: tenant creation / DeployCreateRequested / DeployDeleteRequested) |
| Tests            | Vitest                                                                |
| Lint / Format    | Biome (TS), markdownlint-cli2 + textlint (Markdown)                   |
| Package manager  | Bun 1.3.11 (workspaces: `infrastructure` + `apps/*` + `packages/*`)   |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                           |

## Deploy flow

### Lite mode (default, `make deploy`)

Issue #955 switched the default for `make deploy` to single-tenant Lite mode. It skips the SBT ControlPlane / tenant pipeline / SystemAdmin invitation entirely and deploys just two stacks via `infrastructure/bin/tenkacloud-lite.ts`: AppPlaneCore (`tenantId="local"`) + ProblemDeployBackend (Participant Portal). It is the single-tenant path for one organizer running one event. Teardown is `make destroy` (runs `scripts/tenkacloud-lite.ts down`).

### SaaS mode (opt-in, `make deploy-saas`)

For full multi-tenant operation — pooled tiers (BASIC / ADVANCED), silo tier (PLATINUM), and SystemAdmin invitations — use SaaS mode. `make deploy-saas` (`scripts/install.sh`) runs three phases.

1. **Phase 1**: Deploy `ControlPlaneStack` + `tenkacloud-bootstrap` + `tenkacloud-tenant-template-pooled` + `ServerlessSaaSPipeline`. CORS/callback is localhost only at this point.
2. **Phase 2**: Feed Phase 1 outputs into runtime-config env, host-build `apps/admin-console`, then deploy `AdminConsoleHostingStack` (S3 + CloudFront).
3. **Phase 3**: Put the CloudFront URL into `CDK_PARAM_ADMIN_CONSOLE_ORIGIN` and redeploy `ControlPlaneStack` to update callback / CORS.

Teardown is `make destroy-saas` (`scripts/cleanup.sh`). It is written to be idempotent from any partial-failure / partial-delete state.

### Always-On mode (ADR-049)

A third mode whose goal is **zero always-on AWS compute between events**. It does not use SBT (see the `INVARIANT_CONTROL_PLANE_USES_SBT` row) and is deployed as independent pieces rather than one `make` target:

- **Control plane** — the Cloudflare Worker `apps/always-on-control-plane` (D1 store; events / teams / score summaries / the Auth0-org→tenant projection). Organizer auth is Auth0 (RS256 JWKS); participants use SHA-256-hashed team keys. Deployed via the manual-approval `deploy-always-on-control-plane.yml` workflow. Reconciliation (event status + prune) runs on a Workers Cron (`triggers.crons`), so the control plane needs no AWS tick.
- **Command seam** — the Worker mints ES256-signed `CloudActionIntent`s (`packages/trust-bridge`) and POSTs them to the AWS **signed-intent ingress** (a Lambda Function URL, `make deploy-always-on-ingress`), which verifies + scope-authorizes them and re-emits the frozen deploy events onto the existing bus. Zero idle compute (a Function URL, not a constant tick).
- **Per-event runtime** — a per-event CDK stack (`bin/tenkacloud-always-on-runtime.ts`, stack id `tenkacloud-event-runtime-<eventId>`) deployed / destroyed by the `deploy-` / `destroy-always-on-runtime.yml` workflows (GitHub OIDC, no long-lived keys). Its `TenkaCloud:*` tags mark expired runtimes for the cleanup sweeper (`infrastructure/lib/always-on-runtime/sweeper/`, run manually — the nightly scheduled workflow is retired until Always-On GA #2294) and drive per-event cost attribution. It exists **only during an event**.

The store-convergence decision (D1 as the Always-On control store; the DynamoDB/Turso seam as the Lambda-era bridge; AWS runtime writes summaries into the control store via the Worker API) is recorded in ADR-049 §16. Remaining GA work (uptime-kind scoring inside the per-event runtime + the score-summary feed, and the live fixed/variable-cost measurement) is tracked in #2294.

## Pointers

- **Architecture invariants**: [`.claude/harness/`](./.claude/harness/) — invariant rules + PR Discipline checks (summarized in the table above)
- **Design system**: [Cloudscape](https://cloudscape.design/components/) — pick UI components from here as a default
- **Problem authoring**: catalog repo [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) — schema, scaffolding, and the authoring CLI live there
- **Competitor-side setup**: [`infrastructure/templates/README.md`](./infrastructure/templates/README.md)
- **Agent guide**: @AGENTS.md
- **Contributing**: @CONTRIBUTING.md
