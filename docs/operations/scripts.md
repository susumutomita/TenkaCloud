# Scripts lifecycle inventory

This document is the source of truth for files under `scripts/`. It answers
which files are product surface, CI checks, CodeBuild runtime glue, local
operator tools, archived migrations, or data files.

New files under `scripts/` must add a row here in the same PR. If a script has
no current caller, mark it `candidate-for-removal` instead of leaving ownership
implicit.

## Status taxonomy

| Status | Meaning |
|---|---|
| `active-product` | User-facing CLI or product runtime path. |
| `active-ci` | CI / pre-commit / validation gate. |
| `active-codebuild` | Runtime script executed inside CodeBuild or SBT pipeline jobs. |
| `active-local-ops` | Operator tool for local deploy, teardown, smoke, or observation. |
| `active-helper` | Sourced or imported by another script; do not run directly. |
| `active-data` | Data file consumed by an active script. |
| `archived-migration` | One-shot migration retained for historical recovery only. |
| `candidate-for-removal` | No active caller found; remove in a dedicated PR after confirmation. |

## Inventory

| Script | Status | Called by | Runtime context | Safe to run locally | Owner area | Remove after |
|---|---|---|---|---|---|---|
| `scripts/audit-baseline.json` | `active-data` | `scripts/audit-dependencies.ts` | CI / local audit | No direct run | supply-chain security | - |
| `scripts/audit-dependencies.ts` | `active-ci` | `package.json` `audit:dependencies`; `make audit-deps`; CI | local / CI | Yes, read-only unless `--update` | supply-chain security | - |
| `scripts/build-docs.ts` | `active-ci` | `make build-docs`; `make check-docs`; `make before-commit` | local / pre-commit | Yes | docs | - |
| `scripts/build-problem-index.ts` | `active-ci` | `package.json` `build:problems-index` / `check:problems-index`; `make before-commit` | local / pre-commit | Yes | problem catalog | - |
| `scripts/check-http-magic-numbers.ts` | `active-ci` | `make check-http-status`; `make before-commit` | local / pre-commit | Yes, read-only | code quality | - |
| `scripts/check-template-ascii.ts` | `active-ci` | `make check-template-ascii`; `make before-commit` | local / pre-commit | Yes, read-only | problem template safety | - |
| `scripts/check-template-cfn-refs.ts` | `active-ci` | `make check-template-cfn-refs`; `make before-commit` | local / pre-commit | Yes, read-only | problem template safety | - |
| `scripts/check-template-security.ts` | `active-ci` | `make check-template-security`; `make before-commit` | local / pre-commit | Yes, read-only | problem template safety | - |
| `scripts/cleanup.sh` | `active-local-ops` | `make destroy-saas` | local operator | Risky: deletes SaaS stacks and buckets | SaaS teardown | - |
| `scripts/delete-battles.sh` | `active-codebuild` | Problem deploy CodeBuild delete path; `docs/api/tenant.openapi.yaml`; `docs/operations/deploy-trace.md` | CodeBuild / local recovery | Risky: deletes a named CFn stack | problem deploy | - |
| `scripts/deploy-battles.sh` | `active-codebuild` | Problem deploy CodeBuild create path; `make deploy-battles`; `docs/api/tenant.openapi.yaml` | CodeBuild / local smoke | Yes with AWS target account configured | problem deploy | Rename candidate only; no removal planned |
| `scripts/deprovision-tenant.sh` | `active-codebuild` | SBT tenant offboarding pipeline | CodeBuild | No direct local run | tenant lifecycle | - |
| `scripts/destroy-battles.sh` | `active-local-ops` | `make destroy-battles` | local smoke teardown | Risky: deletes problem stacks by derived name | problem deploy smoke | Rename candidate only; no removal planned |
| `scripts/fix-coverage-paths.ts` | `active-ci` | `package.json` `test:coverage`; CI coverage upload path | local / CI | Yes, rewrites coverage files only | coverage | - |
| `scripts/install.sh` | `active-local-ops` | `make deploy-saas`; README / CLAUDE deploy docs | local operator | Risky: deploys SaaS stacks and uploads source bundle | SaaS deploy | - |
| `scripts/lib/battles-common.sh` | `active-helper` | `deploy-battles.sh`; `delete-battles.sh`; `destroy-battles.sh` | sourced shell helper | No direct run | problem deploy | - |
| `scripts/lib/install-node.sh` | `active-helper` | `provision-tenant.sh`; `update-tenant.sh`; `deprovision-tenant.sh` | CodeBuild bootstrap | No direct run | tenant lifecycle | - |
| `scripts/migrate-tier-premium-to-platinum.sh` | `archived-migration` / `candidate-for-removal` | Manual only; no active Makefile / CI caller | local operator migration | Risky: mutates tenant DDB rows; use `--dry-run` first | historical migration | Remove after confirming no pre-PR-56 tenants remain in supported environments |
| `scripts/package-source-bundle.sh` | `active-helper` | `prepare-source-bundle.sh`; infrastructure tests | local deploy packaging | Yes, AWS credentials are not required | deploy packaging | - |
| `scripts/prepare-source-bundle.sh` | `active-local-ops` | `install.sh`; `tenkacloud-lite.ts`; infrastructure tests | local operator | Yes with AWS env configured; creates/updates source bucket | deploy packaging | - |
| `scripts/print-source-bundle-lifecycle.ts` | `active-helper` | `prepare-source-bundle.sh` | local deploy packaging | Yes, read-only stdout emitter | deploy packaging | - |
| `scripts/provision-tenant.sh` | `active-codebuild` | SBT tenant onboarding pipeline | CodeBuild | No direct local run | tenant lifecycle | - |
| `scripts/tenkacloud-lite.ts` | `active-product` | `make deploy`; `make destroy`; `make lite-*`; README / CLAUDE deploy docs | local operator CLI | Risky for `up` / `down`; read-only for status / URL commands | Lite mode | - |
| `scripts/tenkacloud-ops.ts` | `active-product` | `make ops-health`; direct operator use | local operator CLI | Yes, read-only AWS observation | operations | - |
| `scripts/tenkacloud-problem.ts` | `active-product` | README / AGENTS problem authoring docs; infrastructure tests | local authoring CLI | Yes; `create` writes under `problems/` | problem authoring | Split tracked separately by #1113 / #1114 |
| `scripts/update-tenant.sh` | `active-codebuild` | SBT tenant update pipeline | CodeBuild | No direct local run | tenant lifecycle | - |
| `scripts/validate-problems.ts` | `active-ci` | `package.json` `validate:problems`; `make validate-problems`; `make before-commit` | local / pre-commit | Yes, read-only | problem authoring | - |

## Explicitly retained migration

`scripts/migrate-tier-premium-to-platinum.sh` is intentionally kept in place
for now. It has no Makefile, CI, or CodeBuild caller and should not be treated
as active product surface. The script documents the historical `premium` to
`platinum` tenant tier rename and includes a `--dry-run` mode, so it remains a
manual recovery tool until supported environments are known to have no legacy
tenant rows.

Do not move or delete it in mixed refactor PRs. A dedicated cleanup PR may
remove it after:

1. caller search still shows no active automation path,
2. supported environments have no `tier="premium"` tenant rows, and
3. the PR body lists the operational confirmation used for removal.

## Rename candidates

`deploy-battles.sh` and `destroy-battles.sh` still carry early Battle-only
names, but they are active paths for generic problem CloudFormation stacks.
They should not be removed. Any rename must be a separate PR because it touches
Makefile targets, CodeBuild commands, docs, tests, and operator habits.

`delete-battles.sh` is also historically named, but it is the active CodeBuild
delete path. Treat it as product runtime until a dedicated rename PR updates all
callers.

## Source bundle packaging contract

`scripts/prepare-source-bundle.sh` owns AWS orchestration: source bucket setup,
lifecycle configuration, frontend builds, archive upload, and cleanup.
`scripts/package-source-bundle.sh` owns deterministic local packaging and does
not call AWS APIs.

The local packager copies only the root allowlist: `infrastructure/` as `cdk/`,
`scripts/`, `problems/`, `packages/`, the root `.nvmrc`, the root
`package.json`, and the two required frontend `dist/` directories. Generated
directories such as `node_modules`, `cdk.out*`, `coverage`, `.cache`, and
`.git` are excluded before copy. Unknown repo-root directories are omitted by
construction.

The packager fails before archive creation when staged files exceed
`SOURCE_BUNDLE_MAX_STAGING_MB` (default: `256`) and before upload when the
archive exceeds `SOURCE_BUNDLE_MAX_ARCHIVE_MB` (default: `128`).
