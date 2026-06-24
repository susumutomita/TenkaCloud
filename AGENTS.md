# AGENTS.md — TenkaCloud

Guide for AI agents (Claude Code, Codex CLI, etc.). The source of truth for the product as a whole is @CLAUDE.md. This file is scoped to the operational rules an agent should follow while it is acting.

## Role split

The infrastructure foundation (SBT Control Plane, Application Plane, problem-deploy backend, the CDK aspects) is established, so **infrastructure is no longer owner-only — the agent may change it too**.

- **All layers are the agent's to change end-to-end**: `apps/*`, `scripts/*`, `problems/*`, **and `infrastructure/*` (CDK / SBT / IAM / `infrastructure/templates/`)**. Write tests, get the gates green, and follow it through to a PR.
- **Infra changes carry extra care** (not extra approval): keep IAM **least-privilege**; verify with `make check-synth` (cdk synth + IAM ASCII) and CDK `Template.fromStack` assertions; and when behavior can't be checked offline (a live deploy, a cross-account AssumeRole path, SBT-provisioned resources) **flag it for a one-time live AWS verification in the PR body** — CI does not deploy. The `## Physical impact` PR section must label the CFn diff (CREATE / UPDATE / REPLACE / DELETE / NO-OP).
- **Still confirm first** for the genuinely irreversible / outward actions in *Run end-to-end* below (production deploys, `make destroy`, force-push, secrets) — those gates are unchanged.
- When something is unclear, read the repo first (`git log`, `git diff main...HEAD`, related stack tests). Only ask the user when even that is not enough.

## Run end-to-end

Don't pause to ask "should I continue?" in the middle. Run continuously until the task is done, then report the result. Course corrections come back in the next message.

The exceptions are:

- Destructive operations (`rm -rf`, `git reset --hard`, force push, `make destroy`, production deploys)
- Side effects on shared environments — pushing to PR / Slack / external services
- Anything that touches secrets (`.env`, AWS credentials)

For those, ask first.

## Run locally (no AWS)

For iterating on the participant flow without an AWS account, use the no-AWS local-run path (#1975) — it wraps the `tenkacloud local` CLI and needs no AWS / Cognito / SBT / CloudFormation.

- `make local` — run locally: start the Local Participant API then the participant-portal dev server (Participant Portal only).
- `make local-up` / `make local-down` / `make local-status` — manage the local-mode lifecycle (start / stop / health-check the Local Participant API).
- `make local-open` — open the portal (sign in with any team key); `make local-evaluate` — submit a flag from the terminal.
- `make dev` — start all 3 SPA dev servers in parallel (admin-console :5173 / application-admin-console :5174 / participant-portal :5175).

This is distinct from `make deploy` (Lite mode, single-tenant **on AWS**) and `make deploy-saas` (multi-tenant on AWS). Use `make local` when no AWS is involved.

## Quality gates

Run the following **in this order** before opening a PR.

```bash
make harness         # architecture invariant check (docs/architecture/harness.md)
make before-commit   # lint (markdownlint + textlint + biome) / typecheck / test / validate-problems
/review              # code review
/security-review     # security review
/simplify            # final pass for duplication, complexity, and efficiency
```

If something fails, fix the code. Don't paper over it by editing config files (`biome.json`, `vitest.config.ts`, `tsconfig.json`).

If `make harness` fails, cross-reference the invariant ID with `docs/architecture/harness.md`. The harness's own unit tests are `make harness-test`; the entry points are `.claude/harness/bin/architecture.ts` / `bin/tech-debt.ts`, and the rule logic lives one-rule-per-file under `.claude/harness/src/rules/` and `.claude/harness/src/tech-debt/`.

CI (`.github/workflows/ci.yml`) runs `make install_ci` → textlint → format check → typecheck → test → build. If `make before-commit` passes locally, CI passes — that's the contract.

## Available skills

Invoke as `/<skill>`. Implementations live in `.claude/skills/<skill>/SKILL.md`.

| skill              | Purpose                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `/harness`         | Run `make harness` to detect invariant violations                                       |
| `/tech-debt`       | Run `make tech-debt` to generate the tech-debt backlog                                  |
| `/create-problem`  | Scaffold `problems/<category>/<id>/` with the `metadata.json` + `template.yaml` convention |
| `/spec`            | Write a technical specification in the Open Web Docs (MDN) style                       |

In addition, the common skills (`/review`, `/security-review`, `/simplify`, `/init`, etc.) that ship with Claude Code itself are also available; they are not TenkaCloud-specific.

## Working alongside Codex CLI ("total war" mode)

OpenAI's Codex CLI can also load this repo through this AGENTS.md file. The typical pattern for parallelizing work is:

- **Claude Code** drives the `apps/*` and `scripts/*` implementation (matches the role split above).
- **Codex CLI** runs on a separate branch and tackles cross-cutting concerns (naming refactors, dead code removal, helper extraction, etc.) in parallel.
- Each agent ships its own PR. Conflicts are reconciled by the user (the final reviewer).

Before launching Codex CLI, check the following:

1. `make harness` passes (don't hand it a branch with invariant violations)
2. The work scope respects this file's role split and prohibitions (no `rm`, no committed secrets, etc.). Infra/CDK edits are allowed (see *Role split*); just keep the two agents off the same files to avoid conflicts.
3. Codex's PR body must also include the `## Regression analysis` / `## Physical impact` sections

We do not maintain Codex CLI-specific skills or config — AGENTS.md alone guides both agents. The `.claude/skills/*` slash commands on the Claude Code side are invisible from Codex, so give Codex plain natural-language tasks that don't require `/<skill>` invocations.

## Branches and PRs

- **Don't push to a branch whose PR is already merged.** Always confirm state with `gh pr view --json state` before opening a new PR; if it is `MERGED` / `CLOSED`, cut a new branch.
- Split PRs into small, meaningful units. Title must be one of `feat(...)` `fix(...)` `refactor(...)` `docs(...)` `test(...)` `chore(...)` (Conventional Commits).
- PR titles are under 70 characters. Put Summary + Test plan in the body.
- Issue references must align with GitHub's auto-close keywords:
  - **Close on merge** = `Closes #553` / `Fixes #553` / `Resolves #553` (GitHub auto-closes at merge time)
  - **Related but doesn't close** (partial fix / backlink) = `Relates #553`, or mention `#553` in a non-keyword position
  - **PR-to-PR references** = use a `PR-565`-style number prefix
  - The old rule of wrapping `(#N)` to suppress auto-close was a misunderstanding. Without a keyword like `Closes`, a bare `#N` does **not** auto-close — it just makes a backlink.

## ADR conventions

- ADRs live in `docs/architecture/adr-*.html`. Don't create new ADRs in Markdown. Use HTML's expressive features (row spans, color, SVG, collapsible) to make design decisions the source of truth.
- ADRs must be self-contained. Don't leave chat context, rolling-update metadata, role-split notes like `Claude proposes` / `user owns`, or unresolved TODOs. The benchmark is "an OSS reader can understand background, decision, and impact from this ADR alone."
- Machine checks live in `make harness` as the `adr-must-be-html` / `adr-self-contained` rules. Existing violations are baselined at `.claude/harness/baselines/adr-self-contained.json` so only new regressions fail.

## Coding rules

- **HTTP status codes use `StatusCodes.*` (`http-status-codes` library).** Numeric literals such as `c.json(body, 200)` / `res.status === 401` are forbidden. Names make intent explicit (200 vs 202, 400 vs 409, etc.) and let you grep / lint by meaning.
  - backend: `import { StatusCodes } from "http-status-codes"; return c.json(body, StatusCodes.OK);`
  - frontend: `if (res.status === StatusCodes.UNAUTHORIZED) ...`
  - The legacy aliases (`HTTP_OK` etc. in `infrastructure/lib/problem-deploy/handlers/shared/http-status.ts`) are deprecated. Don't use them in new code.

## Prohibited

- `npx` → use `bunx` or `nlx`
- `rm` (risk of nuking the environment) → use `git rm`
- HTTP status code numeric literals — use `StatusCodes.*`
- Silent fallbacks via mocks / stubs / empty-array returns
- Direct edits to config files (`biome.json`, `vitest.config.*`, `tsconfig.json`)
- On-demand (`PAY_PER_REQUEST`) DynamoDB — the `DynamoDbLowCapacity` Aspect enforces 1/1 PROVISIONED
- Introducing SSE / WebSocket — write **polling** so it aligns with the Lambda operational model
  - To reduce polling pressure, supplement with EventBridge-driven reconciliation per [ADR-014](./docs/architecture/adr-014-eventbridge-driven-state-reconciliation.html). The frontend polling policy stays.
- Committing secrets (`infrastructure/environments/<env>/.env`, AWS credentials)
- Adding packages to `package.json` `trustedDependencies` on your own — that's a supply chain attack vector

## Supply chain security (mini Shai-Hulud 2nd wave, 2026-05)

Reference: [blog.flatt.tech/entry/mini_shai_hulud_2nd](https://blog.flatt.tech/entry/mini_shai_hulud_2nd)

The four defense layers are:

1. **Bun's `trustedDependencies` model**: Bun does not run transitive lifecycle scripts by default. The root `package.json` `trustedDependencies` array is the allowlist (currently empty).
2. **`.npmrc`**: To protect contributors who fall back to npm / yarn / pnpm, set `ignore-scripts=true` + `min-release-age=168h` (7-day quarantine).
3. **CI audit** (`make audit-deps`): `scripts/audit-dependencies.ts` scans under `node_modules`, diffs packages with lifecycle scripts (preinstall / install / postinstall / preprepare / prepare / postprepare) against `scripts/audit-baseline.json`, and fails CI on any new addition or any new hook on an existing dep.
4. **`--ignore-scripts` install + Safe Chain in CI**: `make install_ci` runs `bun install --frozen-lockfile --ignore-scripts`, plus Aikido Safe Chain to detect malicious packages.

### Updating the baseline

When adding / updating a dependency, a new package with lifecycle scripts may end up in the baseline. Procedure:

1. Read the package's `package.json` lifecycle scripts by eye and verify there is no suspicious behavior (`curl` / `wget` / OS detection / env-var exfil / file writes / process spawn)
2. Run `bun run scripts/audit-dependencies.ts --update` to refresh `scripts/audit-baseline.json`
3. Document in the PR body the reason for the baseline change and a summary of the scripts you reviewed

If you see something genuinely suspicious (remote download / OS-level persistence / `curl | sh`), do **not** add it to the baseline — stop the PR and report.

## TDD

Write tests first. Test titles use the English `should ...` pattern.

```typescript
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { App, Stack } from "aws-cdk-lib";

describe("AdminConsoleHostingStack", () => {
  it("should place runtime-config.json on the CloudFront distribution", () => {
    const app = new App();
    const stack = new AdminConsoleHostingStack(app, "Test", { /* ... */ });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::Bucket", { /* ... */ });
  });
});
```

In CDK tests, assert against the generated CFn via `Template.fromStack(stack)`. For Lambda handler unit tests, mock the AWS SDK clients with `vi.mock`.

## Directory cheat sheet

```
apps/
  admin-console/                   # System Admin (Cognito Hosted UI / OAuth Code+PKCE)
  application-admin-console/       # Tenant Admin (per-tenant Application Plane)
  participant-portal/              # Competitor portal (per-team login key)
infrastructure/
  bin/infrastructure.ts            # Wiring for every stack
  lib/control-plane-stack.ts       # SBT ControlPlane
  lib/bootstrap-template/          # TenantMappingTable
  lib/tenant-template/             # One tenant's API + Cognito + ApplicationConsole
  lib/tenant-pipeline/             # Per-tenant provisioning via CodePipeline
  lib/problem-deploy/              # Problem deployment backend into competitor AWS
  lib/admin-console-hosting.ts     # admin-console S3 + CloudFront hosting
  lib/cdk-aspect/                  # DynamoDbLowCapacity / DestroyPolicySetter
  environments/<env>/              # config.json + .env
  templates/competitor-bootstrap.yaml  # IAM Role to roll out in the competitor account
scripts/
  install.sh                       # 3-phase deploy orchestration
  cleanup.sh                       # Idempotent teardown
  provision-tenant.sh              # Per-tenant deploy invoked from CodeBuild
  deprovision-tenant.sh            # Tenant teardown
problems/<category>/<id>/          # metadata.json + template.yaml are the source of truth
```

## Cross-plane contracts (do not break)

- **EventBridge bus** is provisioned by `ControlPlaneStack`; `bin/infrastructure.ts` hands the ARN to every other stack. New stacks must use the same bus.
- **Tenant creation event** (`onboardingRequest`) is picked up by `ServerlessSaaSPipeline`, which deploys the per-tenant stack. BASIC / ADVANCED share the pooled stack; only PLATINUM gets a silo stack.
- **DeployCreateRequested event** is picked up by the `ProblemDeployBackendStack` Worker Lambda, which AssumeRoles into the competitor account using the tenant's ExternalId and runs CFn CreateStack. **`ExternalId` is always required** (no omission allowed).
- **Frontend URLs** are injected through `runtime-config.json` (served under CloudFront). `apps/*/src/config.ts` has a `loadConfig()`. When you add a new URL, update both the hosting stack env and the `config.ts` interface.

## Problem authoring (ADR-012)

The three sources of truth when adding a problem are:

- **Schema source of truth**: [`problems/SCHEMA.json`](./problems/SCHEMA.json) — JSON Schema for `metadata.json`
- **Onboarding guide**: [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html) — step-by-step + 5-kind decision tree + 4 worked examples
- **Claude Code skill**: `.claude/skills/create-problem/SKILL.md` — invoked as `/create-problem`; walks through requirements gathering → scaffold generation → metadata editing

Problems use the **3-asset model** (ADR-012):

```
problems/<category>/<id>/
├── metadata.json    # Source of truth for catalog display + scoring engine + portal plugin wiring
├── template.yaml    # A single-page CFn (the deploy body, deployed straight into the competitor account)
└── portal/          # Optional (.tsx files declared in dashboard.slots)
```

Scoring uses one of six built-in kinds (`flag` / `multi-flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`) — one per problem. The platform's generic scoring Lambda (ADR-012 Phase 3) dispatches them. Don't put problem-specific scoring code into the platform.

A scaffolding CLI is available:

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>
bun run scripts/tenkacloud-problem.ts validate <id>
bun run scripts/tenkacloud-problem.ts list-kinds
```

Scaffold templates live under `.claude/templates/problems/<kind>/` — one per kind (`flag` / `multi-flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection`).

## References

- @CLAUDE.md — full product overview, architecture, command list
- [`docs/architecture/harness.md`](./docs/architecture/harness.md) — source of truth for invariants + PR Discipline
- [`docs/architecture/adr-012-problem-plugin-architecture.html`](./docs/architecture/adr-012-problem-plugin-architecture.html) — problem = plugin, platform = host design
- [`docs/problems/AUTHORING.html`](./docs/problems/AUTHORING.html) — problem authoring onboarding
- [`infrastructure/templates/README.md`](./infrastructure/templates/README.md) — competitor-side setup
- [`problems/README.md`](./problems/README.md) — problem authoring steps + schema
- `apps/<app>/README.md` — local development steps per SPA
- [`apps/cli/README.md`](./apps/cli/README.md) — `tenkacloud local` no-AWS run mode (the `make local*` targets wrap it)
- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — what CI runs
