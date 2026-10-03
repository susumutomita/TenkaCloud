# Repository scripts

| Directory or command | Purpose |
| --- | --- |
| `local-host/local.ts` | Managed local start/down, controller ownership and state-preserving shutdown |
| `cloud-hosting/` | Current cloud deployment, standard CDK bootstrap, coordinated teardown and ownership checks |
| `local-host/` | Unified event/team HTTP server, SQLite state, authentication and exercise adapters |
| `local-host/container/` | Compose policy, metadata, verifier/checkpoint scoring and workbench helpers |
| `lib/` | Shared helpers and required AWS ExternalId boundary |
| `problem-pack/` | Authoring, validation and immutable local snapshots; installation is not event integration |
| `release/` | Unpublished candidate identity checks; no publication command |
| `quality/`, `workspace/`, `security/` | Quality gates, workspace checks and dependency audit |
| `landing/` | Documentation and landing page generation |
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

`make deploy` and `make destroy` use the current cloud CLI. They validate the
installation and AWS permissions, request standard CDK bootstrap when missing,
and confirm owned resources before teardown. See [cloud operations](../infrastructure/README.md)
for supported exercises, retained data and recovery. AWS problem-template authoring
commands do not deploy the competition platform.

Use `bun run pack --help` for authoring. Local activation records do
not add a pack to the event catalog. The generic catalog/workbench exposes 106 local definitions and 15 terminal
declarations. Representative real Docker/browser checks cover SQL and PostgreSQL
terminal checkpoints, team separation and preserved work after restart; they do
not prove complete play-throughs of every problem. AWS-service problems are
cloud-only and cannot be enabled through the local entrypoint.
