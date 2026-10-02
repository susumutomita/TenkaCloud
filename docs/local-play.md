# Local event competitions

This page describes the integration candidate, which has not been released. The former standalone
individual-practice backend has been replaced by one organizer/participant
competition system. The command remains `make local`, but its event/team workflow
and shutdown contract have changed.

## Start, join and stop

Follow [local hosting](local-hosting.md) for requirements, organizer bootstrap,
URLs and event operations. From a prepared checkout:

```sh
make local
```

Create an event and teams in the organizer console, prepare the selected jobs,
start the schedule, then use the correct team key in the participant portal.
New Docker jobs are dormant until the participant chooses **Start / resume**.
Use **Stop (keep data)** to release active capacity without resetting the exercise.
Existing Docker events retain their legacy lifecycle. AWS service problems require
cloud hosting; the local entrypoint cannot create or resume AWS environments.
A participant cannot select another team's environment by supplying a team ID.

From another terminal in the same checkout:

```sh
make down
```

Down stops the managed process and owned Docker runtimes without deleting the
SQLite database, scores, keys or Docker data. Restart with `make local` and the
same data directory. New on-demand Docker jobs remain stopped until the participant
resumes them. Stop preserves existing writable layers and volumes, not RAM. There
is no automatic eviction or reset. Event time is not reset. An ordinary stop is not End Event,
Docker volume removal or AWS stack deletion. Explicit event teardown is separate;
keep ownership records until it succeeds.

`make deploy` and `make destroy` call the current Lambda + Turso/DynamoDB CLI after
reviewed AWS setup. The current cloud catalog includes hello-world with scoped CLI
access and native Cryptography Battle. Docker/Compose exercises are local-only and
are not listed in the cloud catalog. The DynamoDB Local 100-participant burst took 5.910 seconds, exceeding the five-second refresh interval; this is not an AWS measurement. Destroy confirms
owned targets and removes platform-owned data by default. Exercise cleanup is
separate; ordinary destroy leaves external Turso rows and explicit destroy-all
resets them. See the
[cloud setup boundary](../infrastructure/README.md#current-checkouts-setup-and-teardown-boundary).

## Admission limits

New Docker events allow up to 512 team/problem jobs. Defaults admit 3 active
environments per team, 12 across the host and a 4096 MiB sum of configured
container-memory caps. The 40 gateway slots apply to active environments only.
Runtime-port assignments are retained across Stop. These are control limits, not
a performance guarantee; see [requirements and evidence](local-play-requirements.md).

## Catalog and verification status

All 106 former Compose problems are intended to run as Challenge competitions.
The pinned catalog contains 8 verify and 98 multi-verify definitions, including
4 whose source category is Battle. A generic runtime should preserve their
checker semantics and normalize the competition presentation. Catalog and
workbench integration is implemented; listing all IDs is not playability proof.

Fifteen problems declare terminal access. That is a separate runtime capability
whose HTTP/WebSocket boundary and a real Docker PostgreSQL exercise have been
verified. Browser checks covered three checkpoints, team isolation and restarting
the same container with its seven inserted rows intact. Other terminal and problem
variants still need representative coverage. Native-only
problems must reject incompatible hosts rather than silently use emulation.

## Verifier and checkpoint boundary

The exercise's verifier is a server-side authority, not a public challenge URL.
The platform derives event/team/problem identity from authenticated state and
forwards submissions only to that environment's retained verifier address.

- `verify` checks one submitted value; the platform owns its score/history
- `multi-verify` adds the declared checkpoint ID; the response must echo it
- Missing or mismatched checkpoint IDs, unavailable verifiers and invalid
  responses fail visibly rather than being treated as a correct or wrong answer
- Checkpoint points, penalties and hints come from metadata; correct awards and
  idempotency receipts must survive restart without duplication
- Error messages must not reveal flags, private fixtures, seeds or paid hints
- Gateway/workbench routes must not expose the verifier or another team's state

The owning contracts are `scripts/local-host/container/manifest.ts`,
`verify-client.ts`, `scoring.ts` and the pinned catalog's `AGENTS.md` / `SCHEMA.json`.
Do not infer generic runtime support from schema acceptance alone.

## Authoring and smoke evidence

Use the pinned `problems/` authoring contract and the problem's own tests, then
run `make agent-gate` from the catalog root. Validate the actual participant route
through the built portal: launch, intended interaction, correct/incorrect answer,
hints, score, restart and cleanup. Include two teams to check isolation.

The book examples are sqli-demo, hello-world, hello-world-battle and the
wp-exposed-backup multi-checkpoint starter. See [book compatibility](book-compatibility.md).
Pack install/activate is not currently connected to the event catalog.
