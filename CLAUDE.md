# TenkaCloud

A multi-tenant SaaS cloud competition platform on AWS. Problems are delivered in two categories: **Battle** (real-time, head-to-head) and **Challenge** (self-paced, evergreen) — formerly known as GameDay / JAM. Built on top of SBT (`@cdklabs/sbt-aws` 0.3.9), with the Control Plane, Application Plane, and per-competitor problem deployment all expressed in CDK.

## Architecture

```
TenkaCloud/
├── apps/                                    # Vite + React 19 + Cloudscape SPAs
│   ├── admin-console/                       # System Admin (Control Plane UI, dev :5173)
│   ├── application-admin-console/           # Tenant Admin (Application Plane UI, dev :5174)
│   └── participant-portal/                  # Competitor portal (dev :5175)
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
├── problems/<category>/<id>/                # One directory per problem (metadata.json + template.yaml)
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

We don't use a single-table DynamoDB design. Each stack owns its own tables (TenantMappingTable / Deployments / Apps / etc.), and tenant isolation is enforced via the `TenantId` partition key or by stack separation. **Every table is forced to PROVISIONED 1 RCU / 1 WCU by a CDK Aspect (`DynamoDbLowCapacity`)** so the whole platform fits inside the AWS Free Tier 25 RCU/WCU budget.

## Commands

| Command                 | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `make install`          | Install dependencies for every workspace (bun)                           |
| `make build`            | Build every workspace (`infrastructure` → 3 SPAs)                        |
| `make typecheck`        | `tsc --noEmit` across every workspace                                    |
| `make test`             | `vitest` across every workspace                                          |
| `make lint`             | markdownlint + textlint + biome                                          |
| `make fix`              | Auto-fix variant of the above (`make format` works too)                  |
| `make before-commit`    | lint + test (required gate before opening a PR)                          |
| `make deploy`           | **Lite mode** (single-tenant) deploy. Stands up AppPlaneCore + Participant Portal via `infrastructure/bin/tenkacloud-lite.ts` (#955) |
| `make deploy-saas`      | **SaaS mode** (multi-tenant) deploy. Runs `scripts/install.sh` (3-phase deploy, stands up SBT ControlPlane) |
| `make destroy`          | Tear down Lite mode                                                       |
| `make destroy-saas`     | Tear down SaaS mode (`scripts/cleanup.sh` idempotently removes every stack + S3) |
| `make harness`          | Architecture invariant check (`.claude/harness/`)                       |
| `make harness-test`     | Unit tests for the harness itself (`.claude/harness/`)                   |
| `make tech-debt`        | Tech-debt scan (test smell / coupling / responsibility gaps)             |
| `make help`             | List every Makefile target                                               |

Switch environments with `make deploy ENV=production` and similar. It loads `infrastructure/environments/<env>/.env`; if missing, `make env-check` (SaaS mode) / `make env-check-lite` (Lite mode, no `SYSTEM_ADMIN_EMAIL` required) fail with an error.

## Architecture invariants

Codified as one-rule-per-file under `.claude/harness/src/rules/` (summarized in the table below). `make harness` runs `.claude/harness/bin/architecture.ts` against staged files and reports deviations as errors.

| ID                                                    | Summary                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `INVARIANT_CONTROL_PLANE_USES_SBT`                    | The Control Plane must sit on top of the `@cdklabs/sbt-aws` ControlPlane construct |
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

### Available skills

Live under `.claude/skills/` and are invoked as `/<skill-name>`.

| skill              | Purpose                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `/harness`         | Run `make harness` to detect architecture invariant violations                          |
| `/tech-debt`       | Run `make tech-debt` to generate the tech-debt backlog (assertion roulette / coupling / fallback detection) |
| `/quality-gates`   | Run the off-body quality-gate checks (HTTP magic numbers / template / coverage / IAM ASCII / merge / submodule) |
| `/spec`            | Write a technical specification in the Open Web Docs (MDN) style                       |

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

The legacy aliases (`HTTP_OK` / `HTTP_INTERNAL_ERROR` etc. in `infrastructure/lib/problem-deploy/handlers/shared/http-status.ts`) remain as deprecated re-exports. Don't use them in new code. They are derived from `StatusCodes.*`, so library updates flow through automatically.

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
- Dependencies are updated by Renovate / Dependabot; CI uses Safe Chain to detect malicious packages

### Supply chain security (mini Shai-Hulud 2nd-wave mitigation, see [blog.flatt.tech/entry/mini_shai_hulud_2nd](https://blog.flatt.tech/entry/mini_shai_hulud_2nd))

A four-layer defense against credential-exfil attacks that abuse `prepare` / `postinstall` and other transitive lifecycle scripts.

1. **Bun `trustedDependencies`**: Bun blocks transitive lifecycle scripts by default (secure by default). The `trustedDependencies` array in `package.json` is the explicit allowlist (currently empty).
2. **`.npmrc`**: `ignore-scripts=true` + `min-release-age=168h` (7-day quarantine, npm 11+). Even if a contributor uses npm / yarn / pnpm, the protection is automatic.
3. **CI audit** `make audit-deps` (`scripts/audit-dependencies.ts`): Scans `node_modules`, diffs packages with lifecycle scripts against `scripts/audit-baseline.json`, and fails on any new addition or new hook on an existing dep.
4. **CI install policy** `make install_ci`: `bun install --frozen-lockfile --ignore-scripts` + Aikido Safe Chain malicious package detection.

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
| Package manager  | Bun 1.3.11 (workspaces: `infrastructure` + `apps/*`)                  |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                           |

## Deploy flow

### Lite mode (default, `make deploy`)

Issue #955 switched the default for `make deploy` to single-tenant Lite mode. It skips the SBT ControlPlane / tenant pipeline / SystemAdmin invitation entirely and deploys just two stacks via `infrastructure/bin/tenkacloud-lite.ts`: AppPlaneCore (`tenantId="local"`) + ProblemDeployBackend (Participant Portal). It is the single-tenant path for one organizer running one event. Teardown is `make destroy` (`make lite-down`).

### SaaS mode (opt-in, `make deploy-saas`)

For full multi-tenant operation — pooled tiers (BASIC / ADVANCED), silo tier (PLATINUM), and SystemAdmin invitations — use SaaS mode. `make deploy-saas` (`scripts/install.sh`) runs three phases.

1. **Phase 1**: Deploy `ControlPlaneStack` + `tenkacloud-bootstrap` + `tenkacloud-tenant-template-pooled` + `ServerlessSaaSPipeline`. CORS/callback is localhost only at this point.
2. **Phase 2**: Feed Phase 1 outputs into runtime-config env, host-build `apps/admin-console`, then deploy `AdminConsoleHostingStack` (S3 + CloudFront).
3. **Phase 3**: Put the CloudFront URL into `CDK_PARAM_ADMIN_CONSOLE_ORIGIN` and redeploy `ControlPlaneStack` to update callback / CORS.

Teardown is `make destroy-saas` (`scripts/cleanup.sh`). It is written to be idempotent from any partial-failure / partial-delete state.

## Pointers

- **Architecture invariants**: [`.claude/harness/`](./.claude/harness/) — invariant rules + PR Discipline checks (summarized in the table above)
- **Design system**: [Cloudscape](https://cloudscape.design/components/) — pick UI components from here as a default
- **Problem authoring**: catalog repo [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge) — schema, scaffolding, and the authoring CLI live there
- **Competitor-side setup**: [`infrastructure/templates/README.md`](./infrastructure/templates/README.md)
- **Agent guide**: @AGENTS.md
- **Contributing**: @CONTRIBUTING.md
