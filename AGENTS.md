# AGENTS.md — TenkaCloud

Guide for AI agents (Claude Code, Codex CLI, etc.). The source of truth for the product as a whole is @CLAUDE.md. This file is scoped to the operational rules and permission boundaries an agent should follow while it is acting.

Judgment principles live in [`docs/architecture/principles.md`](./docs/architecture/principles.md). Machine-enforced rules and gates are indexed in [`docs/architecture/enforcement-registry.md`](./docs/architecture/enforcement-registry.md). Do not duplicate their full contents here.

## Role split

The infrastructure foundation (SBT Control Plane, Application Plane, problem-deploy backend, the CDK aspects) is established, so **infrastructure is no longer owner-only — the agent may change it too**.

- **All layers are the agent's to change end-to-end**: `apps/*`, `scripts/*`, `problems/*`, **and `infrastructure/*` (CDK / SBT / IAM / `infrastructure/templates/`)**. Write tests, get the gates green, and follow it through to a PR.
- **Infra changes carry extra care** (not extra approval): keep IAM least-privilege by default; verify with `make check-synth` (CDK synth + IAM ASCII) and CDK `Template.fromStack` assertions; and when behavior cannot be checked offline (a live deploy, a cross-account AssumeRole path, SBT-provisioned resources), flag it for one-time live AWS verification in the PR body. The `## Physical impact` PR section must label the CFn diff (CREATE / UPDATE / REPLACE / DELETE / NO-OP).
- **Competitor bootstrap exception**: `infrastructure/templates/competitor-bootstrap.yaml` deliberately attaches `AdministratorAccess` because problem templates can create changing AWS resource types inside the competitor account. Do not generalize this exception to Control Plane, Application Plane, CI, or operator roles. Its compensating controls are the TenkaCloud account restriction, mandatory `ExternalId`, one-hour セッション maximum, and stack deletion as one-shot revocation. See `PRINCIPLE_EXPLICIT_TRUST_BOUNDARY`.
- **Still confirm first** for genuinely irreversible or outward actions in *Run end-to-end* below (production deploys, `make destroy`, force-push, secrets).
- When something is unclear, read the repo first (`git log`, `git diff main...HEAD`, related stack tests). Only ask the user when even that is not enough.
- **Search before you write.** 新しい helper / util / 判定ロジックを書く前に、共有ヘルパーカタログ [`docs/shared-utils.md`](./docs/shared-utils.md) を確認し、既存実装を `git grep` で探して再利用・抽出する。共有 helper を追加したら同じ PR でカタログに 1 行足す。既存コードを調べずに再実装したコピー&ペーストは CI の **duplication baseline ratchet** (`make dup-check`, jscpd) が落とす。重複ゼロが目標ではない。責務分離のための意図的な類似は `scripts/quality/duplication-baseline.json` に焼き込み済みで、baseline を増やす更新 (`make dup-baseline`) は理由を PR body に書く。

## Run end-to-end

Don't pause to ask "should I continue?" in the middle. Run continuously until the task is done, then report the result. Course corrections come back in the next message.

The exceptions are:

- Destructive operations (`rm -rf`, `git reset --hard`, force push, `make destroy`, production deploys)
- Side effects on shared environments — pushing to PR / Slack / external services
- Anything that touches secrets (`.env`, AWS credentials)

For those, ask first.

## SPA dev servers (no AWS)

For frontend iteration without an AWS account:

- `make dev` — start all 3 SPA dev servers in parallel (admin-console :5173 / application-admin-console :5174 / participant-portal :5175).

For a real run use `make deploy` (Lite mode, single-tenant **on AWS**) or `make deploy-saas` (multi-tenant on AWS).

## Quality gates

Run the following **in this order** before opening a PR.

```bash
make harness         # architecture enforcement check (.claude/harness/)
make before-commit   # lint (markdownlint + textlint + biome) / test
/review              # code review
/security-review     # security review
/simplify            # final pass for duplication, complexity, and efficiency
```

If something fails, fix the code. Don't paper over it by editing config files (`biome.json`, `vitest.config.ts`, `tsconfig.json`).

If `make harness` fails, it reports a kebab-case `ruleId` (for example `no-conflict-markers`). Cross-reference it with the matching file under `.claude/harness/src/rules/`. These machine rules are separate from the `INVARIANT_*` / `ONE_PASS_*` process invariants in CLAUDE.md, which need review and execution evidence. The harness's own unit tests are `make harness-test`; entry points are `.claude/harness/bin/architecture.ts` / `bin/tech-debt.ts`, and rule logic lives one-rule-per-file under `.claude/harness/src/rules/` and `.claude/harness/src/tech-debt/`.

CI (`.github/workflows/ci.yml`) has two jobs that run in parallel. The `ci` job runs Safe Chain setup (best-effort, `continue-on-error: true`) → `make install_ci` → **audit-deps** → **duplication baseline ratchet** (`make dup-check`) → **report-only knip dead-code scan** (`make dead-code`) → **submodule pin guard** → **problem-catalog validation** (`make validate-problems`) → textlint → format check → typecheck → build. The `coverage` job runs a 3-shard matrix (infrastructure / spas / packages); each shard runs its own 100％ coverage gate for agent-owned workspaces and Codecov upload. `before-commit` is a fast local sanity check and does not run every CI-only gate. Run `make ci-local` before opening a PR when you need a full local mirror.

## Available skills

Invoke as `/<skill>`. Implementations live in `.claude/skills/<skill>/SKILL.md`.

| skill | Purpose |
| --- | --- |
| `/change` | Adaptive orchestration for complex cross-plane, trust, data, IaC, cost, or mode changes |
| `/harness` | Run `make harness` to detect deterministic enforcement violations |
| `/tech-debt` | Run `make tech-debt` to generate the tech-debt backlog |
| `/quality-gates` | Run off-body quality-gate checks (HTTP magic / template / coverage / merge / submodule) |
| `/spec` | Write a technical specification in the Open Web Docs (MDN) style |
| `/blindspot-pass` | Review-only unknown-unknowns pass over an Issue / ADR / PR diff / directory |
| `/tenka-drill` | Learner-facing coach for a `make local` drill problem |

Use `/change` for complex work. It selects approach families and agents dynamically; it does not always start the same roles or the same number of agents.

Common skills (`/review`, `/security-review`, `/simplify`, `/init`, etc.) that ship with Claude Code are also available and are not TenkaCloud-specific.

## Working alongside Codex CLI

OpenAI Codex CLI can also load this repo through AGENTS.md. Parallelization is based on independent approach families and non-overlapping file ownership, not permanent product roles.

Examples of useful separation:

- one agent traces the existing data and event flow;
- one agent tests a minimal-change implementation;
- one agent attacks auth, tenant, migration, cost, and physical-impact assumptions;
- one agent implements a selected, isolated workstream on a separate branch.

Before launching another agent:

1. `make harness` passes.
2. Give it framing, acceptance criteria, non-goals, and constraints, but avoid biasing every early explorer with the currently favored solution.
3. Keep agents off the same files where possible.
4. Require concrete evidence, exact gaps, and a PR body with `## Regression analysis` / `## Physical impact`.

Each agent ships its own PR when workstreams are independently mergeable. Conflicts and final product decisions are reconciled by the root orchestrator and human reviewer.

Codex does not see Claude Code slash skills. Translate the `/change` contract into plain natural-language tasks and require the same Approach Registry fields.

## Branches and PRs

- **Don't push to a branch whose PR is already merged.** Confirm state before opening a new PR; if it is `MERGED` or `CLOSED`, cut a new branch.
- Split PRs into small, meaningful units. Title must be one of `feat(...)`, `fix(...)`, `refactor(...)`, `docs(...)`, `test(...)`, `chore(...)`.
- PR titles are under 70 characters. Put Summary and Test plan in the body.
- Issue references align with GitHub's auto-close keywords:
  - **Close on merge** = `Closes #553` / `Fixes #553` / `Resolves #553`.
  - **Related but doesn't close** = `Relates #553`, or mention `#553` without an auto-close keyword.
  - **PR-to-PR references** = use `PR-565`-style number prefix.

## ADR conventions

- ADRs live in `docs/architecture/adr-*.html`. Don't create new ADRs in Markdown. Use HTML's expressive features to make design decisions the source of truth.
- ADRs must be self-contained. Don't leave chat context, rolling-update metadata, role-split notes, or unresolved TODOs.
- Machine checks live in `make harness` as `adr-must-be-html` / `adr-self-contained`. Existing violations are baselined so only new regressions fail.

## Coding rules

- **HTTP status codes use `StatusCodes.*` (`http-status-codes` library).** Numeric literals such as `c.json(body, 200)` / `res.status === 401` are forbidden.
  - backend: `import { StatusCodes } from "http-status-codes"; return c.json(body, StatusCodes.OK);`
  - frontend: `if (res.status === StatusCodes.UNAUTHORIZED) ...`
  - `StatusCodes.*` usage is enforced across the codebase.

## Prohibited

- `npx` → use `bunx` or `nlx`.
- `rm` → use `git rm` or a scoped safe deletion mechanism.
- HTTP status code numeric literals → use `StatusCodes.*`.
- Silent fallbacks via mocks / stubs / empty-array returns.
- Direct edits to config files (`biome.json`, `vitest.config.*`, `tsconfig.json`) to hide a failure.
- On-demand (`PAY_PER_REQUEST`) DynamoDB — `DynamoDbLowCapacity` enforces 1/1 PROVISIONED.
- Introducing SSE / WebSocket — use polling aligned with the Lambda operational model; supplement with EventBridge reconciliation when needed.
- Committing secrets (`infrastructure/environments/<env>/.env`, AWS credentials).
- Adding packages to `package.json` `trustedDependencies` without explicit review.

## Supply chain security

Reference: [blog.flatt.tech/entry/mini_shai_hulud_2nd](https://blog.flatt.tech/entry/mini_shai_hulud_2nd)

The four defense layers are:

1. **Bun `trustedDependencies`**: transitive lifecycle scripts are blocked by default; the root allowlist is currently empty.
2. **`.npmrc`**: `ignore-scripts=true` + `min-release-age=168h` protects contributors using npm / yarn / pnpm.
3. **CI audit** (`make audit-deps`): scans dependency lifecycle scripts against `scripts/security/audit-baseline.json` and fails on drift.
4. **`--ignore-scripts` install + Safe Chain in CI**: `make install_ci` uses a frozen lockfile and ignores scripts; Safe Chain is additional best-effort detection.

### Updating the baseline

When adding or updating a dependency whose lifecycle scripts change:

1. Read the package's `package.json` lifecycle scripts and verify there is no suspicious remote download, OS persistence, env-var exfiltration, file write, or process spawn.
2. Run `bun run scripts/security/audit-dependencies.ts --update`.
3. Document the reason and reviewed scripts in the PR body.

If something is suspicious, do not add it to the baseline. Stop and report.

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

In CDK tests, assert against generated CFn via `Template.fromStack(stack)`. For Lambda handler unit tests, mock AWS SDK clients with `vi.mock` at the external boundary.

## Directory cheat sheet

```text
apps/                               # 5 workspaces
  admin-console/                   # System Admin
  application-admin-console/       # Tenant Admin
  participant-portal/              # Competitor portal
  developer-portal/                # Pack-author-facing docs/tools SPA
  always-on-control-plane/         # Cloudflare Worker
packages/                          # Shared workspace libraries
infrastructure/
  bin/infrastructure.ts            # Wiring for every stack
  lib/control-plane-stack.ts       # SBT ControlPlane
  lib/control-plane/               # ControlPlane helpers
  lib/bootstrap-template/          # TenantMappingTable
  lib/tenant-template/             # Tenant API + Cognito + console
  lib/tenant-pipeline/             # Per-tenant provisioning
  lib/problem-deploy/              # Deployment backend into competitor AWS
  lib/problem-pack/                # Offline Problem Pack CLI
  lib/app-plane-core/              # Lite-mode Application Plane
  lib/app-config/                  # Per-environment config resolution
  lib/app-wiring/                  # Cross-stack wiring
  lib/tenkacloud-lite/             # Lite mode stack + CLI
  lib/always-on-runtime/           # Always-On runtime + sweeper
  lib/admin-insight/               # Cross-tenant SystemAdmin insight
  lib/security/                    # CloudFront/Cognito security
  lib/observability/               # Dashboard, budget, alarms
  lib/cdk-aspect/                  # Capacity / destroy policy aspects
  environments/<env>/              # config.json + .env
  templates/competitor-bootstrap.yaml
scripts/                           # Deploy and product tooling
packs/                             # In-repo problem packs
problems/                          # TenkaCloudChallenge submodule
landing/                           # Static marketing/demo site
```

## Cross-plane contracts (do not break)

- **EventBridge bus** is provisioned by `ControlPlaneStack`; new stacks use the same bus.
- **Tenant creation event** (`onboardingRequest`) is handled by `ServerlessSaaSPipeline`. BASIC / ADVANCED share pooled runtime; PLATINUM gets silo runtime.
- **DeployCreateRequested** is handled by `ProblemDeployBackendStack`, which AssumeRoles into the competitor account using mandatory `ExternalId` and runs CFn CreateStack.
- **Frontend URLs** are injected through `runtime-config.json`. New URLs require both hosting-stack injection and config interface updates.

## Problem authoring (ADR-012)

Problem authoring lives in [TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge). The schema source of truth is [`problems/SCHEMA.json`](./problems/SCHEMA.json).

Problems use the 3-asset model:

```text
problems/<category>/<id>/
├── metadata.json
├── template.yaml
└── portal/
```

Scoring declares exactly one `scoring.kind` per problem. The platform's generic scoring Lambda dispatches supported kinds. Don't put problem-specific scoring code into the platform.

Private problems use the offline Problem Pack CLI documented in the README.

## References

- @CLAUDE.md — product overview, architecture, command list.
- [`docs/architecture/principles.md`](./docs/architecture/principles.md) — judgment principles.
- [`docs/architecture/enforcement-registry.md`](./docs/architecture/enforcement-registry.md) — machine enforcement index.
- [`.claude/harness/`](./.claude/harness/) — architecture enforcement rules and tech-debt checks.
- [`infrastructure/templates/README.md`](./infrastructure/templates/README.md) — competitor-side setup.
- [`problems/README.md`](./problems/README.md) — problem authoring.
- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — CI contract.
