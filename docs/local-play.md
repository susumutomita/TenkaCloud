# Local play (Docker and multi-cloud simulation, no cloud account)

Local play lets a participant solve a problem entirely on their machine — no
cloud account and no billed cloud resources. It has two explicit runtimes:

- Docker drills keep the established Compose + problem-owned `/verify` contract.
- Cloud and Composite problems use TenkaCloud Simulator through protocol
  `2026-07-11`; the Simulator owns provider behavior and its event-sourced world.

The participant API, portal, leaderboard, hints, and lifecycle stay common. A
cloud runtime is never silently converted to Docker or sent to a real cloud.
The boundary is recorded in
[ADR-051](./architecture/adr-051-local-multicloud-simulator.html).

## How it works

```
make local [PROBLEM=<id>]
  ├─ local scoring API    scripts/local-play (reuses the portal contract)
  │     • a flag submission is forwarded to the container's /verify
  │     • the verdict is recorded (score / leaderboard / hints / score events)
  │     • PROBLEM=<id> pre-starts a container; otherwise containers start on demand
  ├─ Docker Compose up    the selected problem container (loopback only)
  │     • per-deploy random secret (FLAG_SEED, …) injected as env
  │     • the container serves the challenge surface AND POST /verify
  ├─ OR Simulator         a selected cloud / Composite problem (loopback only)
  │     • capability preflight runs before world creation
  │     • deployment outputs and the unified console URL return to the portal
  │     • stop/reset deletes the isolated world; snapshots support recovery
  ├─ runtime-config.json   points the portal at the local API
  └─ participant portal    Vite dev server (cloudMode:"local")
make local-up → scoring API only (advanced / scripts)
make local-portal → attach the portal to an already-running local API
make local-down → Docker Compose down + restore runtime-config
```

| Layer                       | Owns     | Responsibility                                                        |
| --------------------------- | -------- | -------------------------------------------------------------------- |
| Problem container (catalog) | problem  | Docker challenge surface **and `/verify`** (answer and hidden tests stay here) |
| TenkaCloud Simulator        | simulator | Provider APIs, IaC/resource projections, deterministic worlds, snapshots, and unified console |
| TenkaCloud platform         | platform | Catalog, scoring/probes, portal, leaderboard, hints, and provider-neutral lifecycle orchestration |

For Docker, the platform never holds the answer: it delegates each submission
to the container and trusts the container's `correct` verdict. Cloud scoring
remains catalog-driven and is evaluated against the Simulator state/probe
boundary; the platform does not invent a successful verdict when a capability
or operation is unsupported.

## Run it

```bash
make local                        # start the scoring API + browser portal; containers start on demand
make local PROBLEM=sqli-demo      # also pre-start that problem container, then open the portal
make local-list                   # print every playable problem id
make local-status                 # is local play running?
make local-evaluate FLAG='TC{…}'  # submit a flag from the CLI
make local-down                   # stop everything and restore runtime-config
```

Cloud problems use the reviewed, immutable Simulator image by default:

```bash
make local PROBLEM=hello-world

# Override the pinned default with another reviewed immutable build:
TENKACLOUD_SIMULATOR_IMAGE='ghcr.io/susumutomita/tenkacloud-simulator@sha256:<64-hex>' \
  make local PROBLEM=hello-world

# Simulator contributors may instead point to a real executable process:
TENKACLOUD_SIMULATOR_COMMAND='/absolute/path/to/tenkacloud-simulator' \
  make local PROBLEM=hello-world

# Or connect to an already-running loopback instance:
TENKACLOUD_SIMULATOR_URL='http://127.0.0.1:42123' \
TENKACLOUD_SIMULATOR_LAUNCH_SECRET='<base64url-32-byte-secret>' \
  make local PROBLEM=hello-world
```

Image tags are rejected: the value must contain `@sha256:`. The launched
Simulator binds a random loopback port and receives a fresh 256-bit launch
secret. TenkaCloud signs a short-lived `tc_sim_v1` namespace token; it is sent
to the console only as a URL fragment and is never printed. The default image
is pinned to
`ghcr.io/susumutomita/tenkacloud-simulator@sha256:8e9ab4b3da59b268b12174251d10022bc2fd1ecea88b6cdc497820a6ae942f91`;
an explicit command, image, or externally managed URL replaces that default,
and configuring more than one explicit source fails before resource creation.

When the validated catalog contains a digest-pinned workload, the local launcher
also enables Simulator's bounded workload runner. A Simulator process uses the
user-owned Docker CLI directly. A Simulator container receives only the Docker
daemon UNIX socket, its numeric socket group, the reviewed workload image
allowlist, fixed resource quotas, and its own container identity. The process
remains non-root; workload containers remain read-only, non-root, capability
dropped, quota bounded, and attached to a world-internal network. Catalog
overlays cannot add host mounts, Docker flags, credentials, or secrets. If the
socket or policy cannot be established, workload capability discovery fails
closed before deployment resources are created. This socket-enabled boundary is
for single-user local play only, not a hosted or shared deployment mode.

On a bare clone, `make local` is a single, self-healing entry point: it
installs missing workspace dependencies (`ensure-deps`, only when `vite` is
absent — a no-op on a warm tree) and initializes an empty `problems/`
submodule (`git submodule update --init problems`) automatically before it
starts, so a fresh checkout can run `make local` straight away with no
separate `make install` or `git submodule update --init` step (#2525, #2533).
`make local-portal` self-heals the same way.

Prefer a guided walkthrough instead? `make doctor` reports on prerequisites
(mise trust / the `problems/` submodule / Bun / Docker Compose / the Docker
daemon) without installing anything; `make local-onboard` runs the same
checks interactively and offers to fix what it finds (trusting mise,
installing Bun, initializing the submodule, Docker Compose help) — add
`YES=1` to pre-approve every install for unattended use. Both wrap
`scripts/tenkacloud-onboard.ts`.

Without `PROBLEM=`, `make local` pre-starts no problem containers. It starts the
loopback scoring API and browser portal so you can deploy/start a problem from
the portal screen. Use `PROBLEM=<id>` when you want the CLI to
pre-start one or more containers before the portal opens. Log in with any
non-empty team key. The challenge endpoints are shown on the problem page;
attack them, recover the flag, and submit it.

Started containers keep running until an explicit stop — there is no idle
timeout, so you can leave a problem up, come back later, and its endpoints are
still there (#2512). The portal problem page's **Stop** button stops one
problem; `make local-down` stops local play and every recorded container. The
one automatic stop is the running cap (3 containers by default): starting
another problem beyond the cap stops the least-recently-played one to free its
slot.

> Docker problems require Docker Compose. Both `docker compose` and standalone `docker-compose`
> are supported. TenkaCloud auto-detects the frontend; set
> `TENKACLOUD_COMPOSE_CLI='docker-compose'` or
> `TENKACLOUD_COMPOSE_CLI='docker compose'` to force one. The scoring API port
> defaults to `3199` and can be overridden with `LOCAL_API_PORT`. If it is already
> taken, `make local` fails loudly rather than adopting a foreign server.
> For API-only automation, use `make local-up`; attach the browser later with
> `make local-portal`.

Simulator sessions are recorded under `.tenkacloud/local` with private file
permissions. `make local-down` deletes every recorded Simulator world before
terminating an owned process/container. The local CLI also exposes explicit
snapshot export/import and reset commands; recovery verifies the recorded
protocol, token namespace, process, and deployment instead of trusting a stale
state file.

Catalog metadata may reference a strict `simulation.json` document with
`simulationOverlay: { "schemaVersion": "1", "entry": "simulation.json" }`.
TenkaCloud validates paths, symlinks, target ids, duplicate identities, size
limits, digest-pinned workloads, and artifact hashes before launch, then sends
the parsed document as the deployment request's top-level `simulationOverlay`
field. It never embeds the document under `metadata`. Every artifact referenced
by a requirement or workload is also included exactly once in that target's
deterministically ordered Simulator artifact bundle, even when the runtime
entry itself is a single file. This lets Simulator verify the declared digest
against the exact bytes it compiles or materializes.

Polling scoring sends ordinary health requests to the materialized workload's
real loopback HTTP endpoint. Catalog attack probes instead use the authenticated
`HTTP::Endpoint/AttackProbe` provider operation so the attack and its observed
status update the same Simulator world. Phased scoring advances virtual time via
authenticated `POST /v1/worlds/{worldId}/clock/advance`; the response must contain
an ISO `clock` and the provider-neutral `appliedTransitions` list.

Synthetic provider HTTP outputs are exposed through the local server at
`/local/simulator-data/<problem>/<target>/...`. TenkaCloud rewrites only
Simulator-owned AWS/Azure/GCP/Sakura HTTP endpoint outputs to that loopback
route; external URLs, credentials, resource identifiers, and the Simulator
console URL remain unchanged. The proxy accepts only the methods required by
the current catalog (`GET`, `HEAD`, `POST`, and `QUERY`) and preserves the
method, query string, content type, and body while injecting the short-lived
launch token server-side. Other methods fail with HTTP 400 before reaching
Simulator, so the HTTP client cannot silently normalize an accepted method.

The token-injecting route accepts requests without an `Origin` header for CLI
use, or requests from an allowed loopback Participant Portal origin and the
exact current Codespaces Participant Portal origin. Other browser origins fail
with HTTP 403 before target lookup. TenkaCloud answers an allowed `OPTIONS`
preflight locally and replaces every upstream CORS header, including wildcard
`Access-Control-Allow-Origin`, with the exact allowed origin. Polling scoring
uses the Origin-free CLI path. Codespaces applies the existing
participant-portal port proxy to this route.

After a simulated problem starts, `.tenkacloud/local/simulator-native.env` is a
private, source-able multi-profile file. Standard provider CLIs cannot attach
TenkaCloud's world-routing headers, so their endpoint must be the generated
loopback route proxy, not the Simulator origin directly. The proxy preserves
the native authorization and body, strips only its local profile prefix, and
injects the selected world/deployment/target routing server-side:

```bash
source .tenkacloud/local/simulator-native.env
aws sts get-caller-identity                  # AWS_ENDPOINT_URL is already set

# Composite/multi-problem session:
TENKACLOUD_SIMULATOR_PROFILE='hello-multicloud:gcp-hello' \
  source .tenkacloud/local/simulator-native.env
```

The file also exports the Simulator URL/token/world fields for the bundled
Simulator CLI, provider/engine identity, a local-only AWS signing secret, and
the Azure/GCP/Sakura endpoint and credential pairs. None is a real cloud
credential. Query parameters are not used for routing because native Query and
ARM APIs own their query strings.

In Codespaces, browser-facing challenge and Simulator console links are
rewritten through the
Participant Portal dev server on port `5175`:

```text
https://<codespace>-5175.app.github.dev/__tenkacloud-local-port/18180/...
```

The portal proxies that path to `http://127.0.0.1:18180/...` inside the
codespace, so users do not need to manually forward every problem port. Terminal
commands can still use the raw loopback URL.

## The `/verify` contract

The problem container exposes `POST /verify` on a loopback admin port:

```jsonc
// request
{ "submission": "<string>", "context": { "teamId": "local", "problemId": "<id>" } }
// response
{ "correct": true, "points": 200, "message": "Flag accepted." }
```

- `points` is optional; the platform falls back to the manifest's `scoring.points`.
- `message` must be safe — it must **not** leak the answer or any hidden test on
  a wrong submission.

The platform's `POST /portal/me/submit-flag` forwards the submission verbatim and
reflects `correct` into the score. If `/verify` is unreachable or returns an
invalid verdict, the submission fails loudly (HTTP 502) — it is never silently
marked right or wrong.

### Multi-checkpoint problems (`scoring.kind: multi-verify`, #2252)

A container Challenge can score several independent checkpoints with partial
points. `metadata.json` declares them (points are the platform's single source
of truth — the container's `points` override is ignored for multi-verify). The
worked reference is [`wp-exposed-backup`](https://github.com/susumutomita/TenkaCloudChallenge/tree/main/challenges/wp-exposed-backup)
(4 checkpoints); a minimal copy-pasteable shape:

```jsonc
"scoring": {
  "kind": "multi-verify",
  "checks": [
    { "id": "public-backup", "label": "公開バックアップ", "points": 50,
      "wrongAnswerPenalty": 5,
      "hints": [{ "id": "h-backup", "content": "公開パスを確認する", "penalty": 2 }] },
    { "id": "exposed-config", "label": "設定ファイルの控え", "points": 50,
      "wrongAnswerPenalty": 5 }
  ]
}
```

- `checks` has 2–8 entries (4–6 recommended). Each `checks[].id` matches
  `^[a-z0-9][a-z0-9-]{0,63}$` and is unique; hint ids must be unique across the
  whole problem (the portal reveal route is keyed on `hintId`).
- `checks[].label` is ≤80 chars; `wrongAnswerPenalty` (if set) is ≤ that
  check's `points`. Points are positive integers and their sum is the problem
  total. These structural rules are enforced identically by the platform SDK
  parser, the local-play manifest loader, and the catalog validator.
- `checks[].label` / `hints` are competitor-facing: never spoil the
  vulnerability class in them. Translate them via `i18n.en.checks[]`
  (`id` + `label` + `hints` — never repeat points/ids in the overlay).
- The verify exchange adds `checkpointId`, and the container **must echo it**:

```jsonc
// request
{ "checkpointId": "public-backup", "submission": "<string>", "context": { ... } }
// response
{ "checkpointId": "public-backup", "correct": true, "message": "..." }
```

A missing/mismatched echo, or a `checkpointId` that is not declared in
`metadata.json`, fails closed — it is never forwarded, scored, or attributed to
another checkpoint. Scoring is idempotent per `(problemId, checkpointId)`: a
solved checkpoint is never re-awarded or re-penalized, and the problem counts
as completed on the leaderboard only when every checkpoint is solved. The
portal renders checkpoints through the existing multi-flag panel (one
submission box per checkpoint, per-checkpoint hints).

## Authoring a container problem

One directory = one problem. Problems live **only** in the
[TenkaCloudChallenge](https://github.com/susumutomita/TenkaCloudChallenge)
catalog (the `problems/` submodule) — never in this platform repo (ADR-008 /
ADR-012). The platform is problem-agnostic: `make local PROBLEM=<id>` resolves
`<id>` under `problems/challenges` or `problems/battles` when you choose to
pre-start a container from the CLI. Otherwise the portal deploys selected
problems on demand. The reference container problem is `sqli-demo` in the
catalog.

```
<problem>/
├── metadata.json            # the local manifest + scoring
└── local/
    ├── docker-compose.yml   # bind every port to 127.0.0.1 only
    ├── Dockerfile
    └── app/…                # challenge surface + /verify; answer lives only here
```

The manifest's `runtime` (container delivery, ADR-023) + `scoring` sections wire
the harness (no answer, no scoring conditions):

```jsonc
{
  "scoring": { "kind": "verify", "points": 200, "wrongAnswerPenalty": 10, "hints": [ … ] },
  "runtime": {
    "provider": "docker",
    "engine": "compose",
    "entry": "local/docker-compose.yml",
    "challengeEndpoints": { "Web": "http://127.0.0.1:18080" },
    "verifyUrl": "http://127.0.0.1:18081/verify",
    "secretEnv": ["FLAG_SEED"]
  }
}
```

- `scoring.kind` must be `"verify"` (the platform delegates instead of comparing)
  and `runtime.engine` must be `"compose"`.
- Every URL must be loopback (`localhost` / `127.0.0.1` / `[::1]`); the loader
  refuses anything else.
- Each name in `secretEnv` is filled with a fresh 256-bit secret per deploy and
  injected into the container as an env var. Derive the flag and any privileged
  credential from it so each run is unique and nothing secret is committed.

## Security

- Containers are loopback-only. Bind ports as `127.0.0.1:<host>:<container>` —
  `/verify` included.
- A container that fetches an external URL (cloud-style self-deploy) must apply
  SSRF defenses itself: a protocol and host allowlist, no redirect following, a
  timeout, and a response body cap.
- The portal stays HTTPS-only in backend mode; loopback HTTP is the one
  exception, because it never leaves the machine (#871 / #1975).

## Enterprise / internal training

Local play also works for closed-network company trainings and internal drills. If
you are considering TenkaCloud for enterprise or internal training use, please feel
free to reach out via the
[contact form](https://forms.gle/djVprYmq3hFgJA7P9) or
[GitHub Discussions](https://github.com/susumutomita/TenkaCloud/discussions) — we
would love to learn about real-world training needs and custom exercise requirements.
