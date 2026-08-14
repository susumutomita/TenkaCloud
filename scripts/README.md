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
| `tenkacloud.ts` | `tenkacloud` / `bun run tenkacloud` | Unified Bun developer CLI for host local play, developer diagnosis, and Turso live verification |
| `tenkacloud-lite.ts` | `make deploy` / `make destroy` | Lite mode up/down CLI |
| `tenkacloud-local.ts` | `tenkacloud local` / `make local-dev` / advanced `make local-*` helpers | Host Bun/Vite local-play commands for developers (no AWS; not the Docker-only `make local`) |
| `tenkacloud-onboard.ts` | `make doctor-dev` / `make local-onboard` | Bun/mise developer doctor + consent-based onboarding CLI |
| `local/doctor.sh` | `make doctor` | Bun-free participant prerequisite and resource-profile diagnosis |
| `local/docker-prerequisites.sh` | `make doctor` / `make local` | Shared Docker CLI, Compose v2, daemon, and local-context checks |

## Subdirectories — domain tooling

| Directory | Contents |
| --------- | -------- |
| `workspace/` | Workspace-task orchestration: `run-workspaces.ts` (root `build` / `typecheck` / `test`), `run-coverage.ts` (3-shard coverage runner, #2513), `fix-coverage-paths.ts`, and their tests |
| `security/` | Supply-chain and content security: `audit-dependencies.ts` + `audit-baseline.json` (lifecycle-script audit, `make audit-deps`), `detect-suspicious-comment.ts` (issue/PR comment scanner) |
| `quality/` | Code-quality ratchets: `check-duplication.ts` + `duplication-baseline.json` (jscpd baseline gate, `make dup-check` — fails only when duplication grows past the baseline); `check-infra-critical-coverage.ts` + `infra-critical-paths.ts` + `infra-critical-coverage-baseline.json` (infrastructure high-risk file coverage ratchet, `make infra-coverage-check` — fails only when coverage drops below baseline for a registered AssumeRole/ExternalId, tenant-isolation, deploy-state-machine, scoring, delete-lifecycle, or auth-boundary file, #2758) |
| `landing/` | Landing-site generators: `generate-landing-docs.ts`, `generate-landing-locales.ts` (both support `--check`), `landing-seo.test.ts`, and `onboarding-videos/` (YouTube upload masters render only to an explicit external output directory) |
| `onboard/` | First-run onboarding helpers behind `tenkacloud-onboard.ts`: `diagnose.ts`, `plan.ts`, `report.ts`, `onboard-bootstrap.sh`, `codespaces-setup.sh` (devcontainer `postCreateCommand`) |
| `ops/` | Operator utilities for a running deployment: `env-init.ts` (`make env-check` wizard), `turso-live-guide.ts` (`make turso-live-guide` / read-only preflight and CFn verification), `scan-lite-residual-resources.ts` (read-only Lite residual proof foundation, #2977), `scale-event-capacity.ts` + `capacity-model.ts` (DDB capacity), `backfill-tenant-registrations.ts` (one-time SBT 0.9.5 migration), `disruption-live-fire.ts`, `report-retained-tables.ts` (used by `cleanup.sh`), `participant-portal-runtime-config.ts` (`make dev` mock config), `print-source-bundle-lifecycle.ts` |
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

## Lite residual-resource scanner foundation (#2977)

`ops/scan-lite-residual-resources.ts` inventories CloudFormation, DynamoDB,
S3, CloudWatch Logs, SNS, Budgets, and CodeBuild after an STS account
preflight. It only uses identity, list, describe, and tag reads; it has no
delete or other mutation path. Do not use its existence as evidence that the
full #2977 golden path driver is complete: launcher, deploy/destroy, and
release-manifest integration remain separate work.

Capture a strict ownership JSON artifact before teardown. It must contain the
same run/account/region/environment, the immutable release identity, and all
seven exact resource-ID arrays (stack, table, bucket, log-group, budget, and
project names; SNS topic ARNs):

```json
{
  "evidenceVersion": 1,
  "runId": "<correlation-id>",
  "mode": "lite",
  "environment": "development",
  "accountId": "<12-digit-account-id>",
  "region": "ap-northeast-1",
  "releaseIdentity": {
    "releaseVersion": "1.2.3-rc.1",
    "platformCommit": "<40-character-lowercase-git-commit>",
    "catalogCommit": "<40-character-lowercase-git-commit>",
    "simulatorImage": "<repository>@sha256:<64-character-lowercase-digest>"
  },
  "resources": {
    "cloudformation": [],
    "dynamodb": [],
    "s3": [],
    "logs": [],
    "sns": [],
    "budgets": [],
    "codebuild": []
  }
}
```

Run the scanner directly so every safety-critical value is explicit:

```bash
bun run scripts/ops/scan-lite-residual-resources.ts \
  --run-id=<correlation-id> \
  --environment=development \
  --expected-account=<12-digit-account-id> \
  --expected-region=ap-northeast-1 \
  --release-version=1.2.3-rc.1 \
  --platform-commit=<40-character-lowercase-git-commit> \
  --catalog-commit=<40-character-lowercase-git-commit> \
  --simulator-image=<repository>@sha256:<64-character-lowercase-digest> \
  --ownership-file=<pre-teardown-ownership.json>
```

The command emits a versioned JSON report. Exit `0` means every supported
inventory passed, `1` means owned residual resources were found, and `2`
means the result is undecidable (for example, access denied, expired
credentials, malformed output, or evidence mismatch). Invalid arguments or
ownership schema exit `64` before AWS access. There is intentionally no Make
target: the explicit run and release identity values are part of the safety
boundary.

## SBT 0.9.5 tenant-registration backfill

Follow the complete
[SBT 0.9.5 migration runbook](../docs/operations/sbt-0.9.5-tenant-registration-migration.md).
After the staged Control Plane deployment, pass the exact deployed table,
account, region, and environment identifiers. The first invocation is always a
read-only inventory and plan:

```bash
bun run scripts/ops/backfill-tenant-registrations.ts \
  --tenant-details-table=<exact-tenant-details-table-name> \
  --tenant-registration-table=<exact-tenant-registration-table-name> \
  --expected-account=<12-digit-account-id> \
  --expected-region=<aws-region> \
  --environment=<environment-tag>
```

Resolve every reported blocker and review the deterministic
`legacy-<tenantId>` mappings before repeating the same command with `--apply`.
Each apply uses one DynamoDB transaction to create the registration and link
the existing tenant. A final dry-run must report `createCount: 0` and no
blockers. Do not use `--apply` before the SBT 0.9.5 table exists, and do not
substitute a table from another environment.
