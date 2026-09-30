# Repository scripts

| Directory or command | Purpose |
| --- | --- |
| `local-host/` | Bun HTTP host, SQLite state, AWS/Docker/Battle adapters and runtime tests |
| `local-host/container/` | Canonical Docker problem manifest, Compose policy, verifier and score/snapshot helpers |
| `lib/` | Shared pure helpers and AWS AssumeRole boundary |
| `problem-pack/` | Offline problem authoring, validation, immutable snapshots and local activation records |
| `release/` | Local unpublished host candidate identity record; no publication command |
| `quality/`, `workspace/`, `security/` | Existing quality gates, workspace orchestration and dependency audit |
| `onboarding/verify-custom-challenge.ts` | Offline authoring tutorial verification |
| `landing/`, `form/` | Documentation/landing generation and contact form tooling |
| `deploy-battles.sh`, `destroy-battles.sh`, `delete-battles.sh` | Explicit AWS problem-template author smoke tools; never run as an implicit host startup step |

Use `bun run pack --help` for authoring and `make host` to start the competition
host. `make local`, SaaS/Lite deployment and their operator commands are retired.
Use [legacy operations](../docs/legacy-operations.md) for an existing installation.
