# Repository scripts

| Directory or command | Purpose |
| --- | --- |
| `local-host/local.ts` | Managed local start/down, controller ownership and state-preserving shutdown |
| `cloud-hosting/` | Current Lambda/DynamoDB CLI preparation and ownership checks; full public deploy/destroy remains incomplete |
| `local-host/` | Unified event/team HTTP server, SQLite state, authentication and exercise adapters |
| `local-host/container/` | Compose policy, metadata, verifier/checkpoint scoring and workbench helpers |
| `lib/` | Shared helpers and required AWS ExternalId boundary |
| `problem-pack/` | Authoring, validation and immutable local snapshots; installation is not event integration |
| `release/` | Unpublished candidate identity checks; no publication command |
| `quality/`, `workspace/`, `security/` | Quality gates, workspace checks and dependency audit |
| `landing/`, `form/` | Documentation/landing generation and contact form tooling |
| `deploy-battles.sh`, `destroy-battles.sh`, `delete-battles.sh` | Explicit AWS problem-template author tools; never an implicit startup action |

From the repository root, `make local` starts the unified competition system.
`make down` stops the owned local process and Docker runtimes, preserving event
and Docker data. Pass options with `LOCAL_ARGS`; a custom data directory must
match between start and down. New on-demand Docker jobs remain stopped until a
participant resumes them; writable layers and volumes survive, not RAM. There is
no automatic eviction or reset. Do not remove its database or keys to reset it.

New Docker events prepare up to 512 dormant jobs. Defaults allow 3 active
environments per team, 12 across the host and 4096 MiB of summed configured
container-memory caps. Override with `--max-active-per-team`,
`--max-active-environments` and `--container-memory-mib` through `LOCAL_ARGS`.
The 40 gateway slots are active-only; runtime-port assignments survive Stop.
The synthetic 100-job / 105-port test is allocation evidence, not a Docker benchmark.
Existing events retain their legacy lifecycle.

`make deploy` and `make destroy` are the cloud command names, but currently exit
with an unimplemented error and do not change resources. They are not aliases for
AWS exercise deployment. Lambda/DynamoDB onboarding and coordinated platform
teardown remain in progress. The complete `cloud-pipeline.yaml` launcher uses its
fixed historical source refs. The old host launch target has been removed.

Use `bun run pack --help` for authoring. Retained legacy activation records do
not add a pack to the event catalog. The generic catalog/workbench exposes 106 local definitions and 15 terminal
declarations. Representative real Docker/browser checks cover SQL and PostgreSQL
terminal checkpoints, team separation and preserved work after restart; they do
not prove complete play-throughs of every problem. AWS-service problems are
cloud-only and cannot be enabled through the local entrypoint.

For existing SaaS/Lite deployments, use the [pinned legacy scripts](https://github.com/susumutomita/TenkaCloud/blob/825415fcda5075ad723daf9e4514eac47d7b8bb9/scripts/README.md)
and the version that created the environment. There is no automatic migration.
