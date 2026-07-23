# scripts/

Operational entry points and repo tooling. Two rules decide where a file
lives:

1. **Top level = deploy-time contract.** Everything at the top level is
   either invoked by AWS at deploy time (CodeBuild buildspecs and Lambda
   handlers reference these paths as strings — moving them is a
   CloudFormation change), or is a primary `make` entry point
   (`tenkacloud-*.ts`). Do not rename or move top-level files without
   checking `infrastructure/lib/` for embedded path references.
2. **Subdirectories = domain tooling.** Everything else is grouped by what
   it operates on. These are referenced only from `Makefile`,
   `package.json`, CI workflows, and tests, so CI verifies any move.

## Top level — deploy-time scripts and product CLIs

| File | Called by | Purpose |
| ---- | --------- | ------- |
| `install.sh` | `make deploy-saas` | 3-phase SaaS-mode deploy orchestration |
| `cleanup.sh` | `make destroy-saas` | Idempotent SaaS-mode teardown |
| `provision-tenant.sh` | CodeBuild (tenant pipeline) | Per-tenant stack deploy |
| `deprovision-tenant.sh` | CodeBuild (tenant pipeline) | Per-tenant stack teardown |
| `update-tenant.sh` | CodeBuild (tenant pipeline) | Per-tenant stack update |
| `deploy-battles.sh` | CodeBuild (problem deploy) | Deploy Battle problems into the competitor account |
| `delete-battles.sh` | CodeBuild (problem deploy) | Delete deployed Battle problem stacks |
| `destroy-battles.sh` | `make destroy-battles` | Operator-side Battle teardown wrapper |
| `package-source-bundle.sh` | CodeBuild (problem deploy) | Build the problem source bundle artifact |
| `prepare-source-bundle.sh` | `tenkacloud-lite.ts`, docs | Stage the source bundle S3 object |
| `tenkacloud.ts` | `tenkacloud` / `bun run tenkacloud` | Unified local, doctor, and Turso live-verification CLI |
| `tenkacloud-lite.ts` | `make deploy` / `make destroy` | Lite mode (ADR-016) up/down CLI |
| `tenkacloud-local.ts` | `tenkacloud local` / `make local-*` | Internal Docker local-play commands (no AWS) |
| `tenkacloud-onboard.ts` | `make doctor` / `make onboard` | Toolchain doctor + first-run onboarding CLI |

## Subdirectories — domain tooling

| Directory | Contents |
| --------- | -------- |
| `workspace/` | Workspace-task orchestration: `run-workspaces.ts` (root `build` / `typecheck` / `test`), `run-coverage.ts` (3-shard coverage runner, #2513), `fix-coverage-paths.ts`, and their tests |
| `security/` | Supply-chain and content security: `audit-dependencies.ts` + `audit-baseline.json` (lifecycle-script audit, `make audit-deps`), `detect-suspicious-comment.ts` (issue/PR comment scanner) |
| `quality/` | Code-quality ratchets: `check-duplication.ts` + `duplication-baseline.json` (jscpd baseline gate, `make dup-check` — fails only when duplication grows past the baseline) |
| `landing/` | Landing-site generators: `generate-landing-docs.ts`, `generate-landing-locales.ts` (both support `--check`), `landing-seo.test.ts`, and `onboarding-videos/` (YouTube upload masters render only to an explicit external output directory) |
| `onboard/` | First-run onboarding helpers behind `tenkacloud-onboard.ts`: `diagnose.ts`, `plan.ts`, `report.ts`, `onboard-bootstrap.sh`, `codespaces-setup.sh` (devcontainer `postCreateCommand`) |
| `ops/` | Operator utilities for a running deployment: `env-init.ts` (`make env-check` wizard), `turso-live-guide.ts` (`make turso-live-guide` / read-only preflight and CFn verification), `scale-event-capacity.ts` + `capacity-model.ts` (DDB capacity), `disruption-live-fire.ts`, `report-retained-tables.ts` (used by `cleanup.sh`), `participant-portal-runtime-config.ts` (`make dev` mock config), `print-source-bundle-lifecycle.ts` |
| `local-play/` | Modules behind `tenkacloud-local.ts` (container runner, manifest, readiness, scoring API) |
| `cli/` | Unified CLI command adapters and process boundary behind `tenkacloud.ts` |
| `lib/` | Shared helpers for the top-level shell scripts and `ops/` CLIs (`battles-common.sh`, `names.sh`, capacity/disruption/retained-tables logic) |

## Related directories (not scripts)

- [`apps/`](../apps/) — deployable applications (SPAs + Cloudflare Worker).
- [`packages/`](../packages/) — shared workspace libraries imported by
  `apps/` and `infrastructure/`; never deployed on their own.
- [`packs/`](../packs/) — problem-pack content (data, not platform code).
- [`infrastructure/`](../infrastructure/) — CDK stacks; Lambda handlers live
  there, not here.

Tests for scripts live either next to the script (`bun test`, wired into the
root `test` script) or under `infrastructure/test/scripts/` (vitest, runs in
the `infrastructure` workspace — `make test-scripts` is the fast path).
