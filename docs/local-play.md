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

> **Simulator (cloud / Composite) problems are experimental and hidden by
> default (Issue #2632).** Their endpoint URLs, access instructions, and problem
> framing are still being brought up to catalog quality, so `tenkacloud local` neither
> lists nor serves them unless you opt in with `TENKACLOUD_LOCAL_SIMULATOR=1`.
> Docker drill problems are unaffected and remain on by default.

## How it works

```
tenkacloud local [--problem <id>] [--database sqlite|turso]
  ├─ local scoring API    scripts/local-play (reuses the portal contract)
  │     • a flag submission is forwarded to the container's /verify
  │     • the verdict is recorded (score / leaderboard / hints / score events)
  │     • --problem <id> pre-starts a runtime; otherwise runtimes start on demand
  ├─ Docker Compose up    the selected problem container (loopback only)
  │     • per-deploy random secret (FLAG_SEED, …) injected as env
  │     • the container serves the challenge surface AND POST /verify
  ├─ OR Simulator         a selected cloud / Composite problem (loopback only)
  │     • capability preflight runs before world creation
  │     • participant-safe endpoint outputs return to the portal
  │     • an authenticated one-time handoff opens the unified console
  │     • stop/reset deletes the isolated world; snapshots support recovery
  ├─ runtime-config.json   points the portal at the local API
  └─ participant portal    Vite dev server (cloudMode:"local")
tenkacloud local up → scoring API only (advanced / scripts)
tenkacloud local portal → attach the portal to an already-running local API
tenkacloud local down → stop runtimes + restore runtime-config + clear progress
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

For a fresh clone, use the same participant path documented in both READMEs and
the Portal onboarding drill:

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make local-onboard
make local
```

On macOS, Linux, and Windows through WSL2, `make local-onboard` diagnoses Bun,
the catalog submodule, Docker Compose, and the Docker daemon before `make local`
starts the Portal. GitHub Codespaces performs that setup and starts the Portal
automatically; run the **▷ ローカルプレイ開始** task only as a fallback when
automatic startup reports a failure.

The developer CLI exposes advanced launch options:

```bash
tenkacloud local                         # scoring API + portal; local SQLite persistence
tenkacloud local --problem sqli-demo     # pre-start one problem, then open the portal
tenkacloud local down                    # stop runtimes and clear all progress
```

Run `bun link` once to install the repository's `tenkacloud` executable, or
prefix any command with `bun run` (for example, `bun run tenkacloud local`).
The default backend is the embedded SQLite file
`.tenkacloud/local/local-play.sqlite`, with owner-only permissions. It retains
team progress and scores while local play is running and across unexpected API
restarts. An explicit `tenkacloud local down` clears that progress. The store
never persists the participant token, process/container ownership, or a running
Simulator world.
Use the remote backend only when explicitly requested:

```bash
TENKACLOUD_LOCAL_TURSO_URL='https://<database>.turso.io' \
TENKACLOUD_LOCAL_TURSO_AUTH_TOKEN='<token>' \
  tenkacloud local --database turso
```

The token is read from the environment; the CLI has no token-valued argument
and never writes it to `.env` or the SQLite database. Local runtime imports do
not cross into the AWS SDK-backed Lambda repository adapters.

Simulator (cloud / Composite) problems are hidden by default; enable them
with `TENKACLOUD_LOCAL_SIMULATOR=1` (see the note above). When enabled, cloud
problems use the reviewed, immutable Simulator image by default:

```bash
TENKACLOUD_LOCAL_SIMULATOR=1 tenkacloud local --problem hello-world

# Override the pinned default with another reviewed immutable build:
TENKACLOUD_LOCAL_SIMULATOR=1 \
TENKACLOUD_SIMULATOR_IMAGE='ghcr.io/susumutomita/tenkacloud-simulator@sha256:<64-hex>' \
  tenkacloud local --problem hello-world

# Simulator contributors may instead point to a real executable process:
TENKACLOUD_LOCAL_SIMULATOR=1 \
TENKACLOUD_SIMULATOR_COMMAND='/absolute/path/to/tenkacloud-simulator' \
  tenkacloud local --problem hello-world

# Or connect to an already-running loopback instance:
TENKACLOUD_LOCAL_SIMULATOR=1 \
TENKACLOUD_SIMULATOR_URL='http://127.0.0.1:42123' \
TENKACLOUD_SIMULATOR_LAUNCH_SECRET='<base64url-32-byte-secret>' \
  tenkacloud local --problem hello-world
```

Image tags are rejected: the value must contain `@sha256:`. The launched
Simulator binds a random loopback port and receives a fresh 256-bit launch
secret. TenkaCloud signs a short-lived `tc_sim_v1` namespace token; browser
console access receives it only as a URL fragment and it is never printed. The
private native-CLI environment uses the token as a bearer credential. The default image
is pinned to
`ghcr.io/susumutomita/tenkacloud-simulator@sha256:049c6c165f9947b386b2c5864983aebefba26e996ec62859dae0e9814c52d505`;
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

On a bare clone, `tenkacloud local` is a single, self-healing entry point: it
installs missing workspace dependencies (`ensure-deps`, only when `vite` is
absent — a no-op on a warm tree) and initializes an empty `problems/`
submodule (`git submodule update --init problems`) automatically before it
starts, so a fresh checkout can run `tenkacloud local` straight away with no
separate `make install` or `git submodule update --init` step (#2525, #2533).
`tenkacloud local portal` self-heals the same way. The `make local-*` targets
remain thin compatibility wrappers around these CLI commands.

Prefer a guided walkthrough instead? `tenkacloud doctor` reports on prerequisites
(mise trust / the `problems/` submodule / Bun / Docker Compose / the Docker
daemon) without installing anything; `tenkacloud onboard` runs the same
checks interactively and offers to fix what it finds (trusting mise,
installing Bun, initializing the submodule, Docker Compose help) — add
`YES=1` to pre-approve every install for unattended use. Both wrap
`scripts/tenkacloud-onboard.ts`.

Without `--problem`, `tenkacloud local` pre-starts no problem containers. It starts the
loopback scoring API and browser portal so you can deploy/start a problem from
the portal screen. Use `--problem <id>` when you want the CLI to
pre-start one or more containers before the portal opens. The generated portal
runtime config pre-fills a fresh random team key for each run; the
Simulator console handoff accepts only that key. The challenge endpoints are
shown on the problem page;
attack them, recover the flag, and submit it.

Started containers keep running until an explicit stop — there is no idle
timeout, so you can leave a problem up, come back later, and its endpoints are
still there (#2512). The portal problem page's **Stop** button stops one
problem; `tenkacloud local down` stops local play and every recorded container,
then clears all persisted progress and scores. The
one automatic stop is the running cap (3 containers by default): starting
another problem beyond the cap stops the least-recently-played one to free its
slot.

> Docker problems require Docker Compose. Both `docker compose` and standalone `docker-compose`
> are supported. TenkaCloud auto-detects the frontend; set
> `TENKACLOUD_COMPOSE_CLI='docker-compose'` or
> `TENKACLOUD_COMPOSE_CLI='docker compose'` to force one. The scoring API uses a
> fresh loopback port per session and can be fixed with `LOCAL_API_PORT`. If it is already
> taken, `tenkacloud local` fails loudly rather than adopting a foreign server.
> For API-only automation, use `tenkacloud local up`; attach the browser later with
> `tenkacloud local portal`.

Simulator sessions are recorded under `.tenkacloud/local` with private file
permissions. A self-contained protected generation is committed atomically
before its participant-safe public projection; restart rebuilds a missing or
older projection from that protected source. Owned process/container launch also
commits a private intent before spawn. Process mode registers supervisor and
child identities and keeps a private lease until Stop, so `up`/`down` can reclaim
a parent-crash generation without signaling a reused PID. `tenkacloud local down` deletes every recorded Simulator world before
terminating an owned process/container. The local CLI also exposes explicit
snapshot export/import and reset commands; recovery verifies the recorded
protocol, token namespace, process, and deployment instead of trusting a stale
state file. Shutdown is best-effort across every Docker problem and simulated
world: one teardown failure is aggregated and reported only after the remaining
worlds and the owned Simulator launcher have also been stopped. Simulator HTTP
calls have finite abort deadlines, so a loopback process that accepts a request
and then stalls cannot wedge start, reset, scoring, or shutdown indefinitely.

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
an ISO `clock` and the provider-neutral `appliedTransitions` list. Every score
cycle is deduplicated per problem, while Simulator lifecycle, clock, probe, and
snapshot operations share a per-problem queue. A deployment-generation check
discards scoring results if stop/reset replaced the world while a probe was in
flight. The leaderboard counts a solved simulated flag or
composite problem in the same completed-problem total as a solved Docker problem.

Each synthetic provider HTTP target is exposed on its own random loopback
listener and origin. TenkaCloud rewrites only Simulator-owned AWS/Azure/GCP/Sakura
HTTP endpoint outputs to the matching target listener; external URLs and resource
identifiers remain unchanged internally. AWS-owned HTTP URLs that remain after
that rewrite (for example an AWS Console deep link or stale `*.on.aws`
value) are omitted from the participant projection because they cannot address
the local world. The CLI prints only projected HTTP access URLs, so resource
identifiers such as an RDS hostname are not mislabeled as challenge endpoints.
A browser origin for one problem or target cannot read another target, and the
participant API does not expose a shared data-plane route. Simulator credentials,
launch tokens, console URLs, and any namespaced
`*.Simulator...` output are omitted from the participant view. The portal
authenticates `POST .../console-handoff`, receives only a 30-second one-time
ticket, and navigates to a no-store redirect that consumes the ticket before
placing the launch token in the Simulator URL fragment. The proxy accepts only
the methods required by the current catalog (`GET`, `HEAD`, `POST`, and
`QUERY`) and preserves the method, query string, content type, and body while
injecting the short-lived launch token server-side. Other methods fail with
HTTP 400 before reaching Simulator, so the HTTP client cannot silently
normalize an accepted method.

The token-injecting route accepts requests without an `Origin` header for CLI
use, or requests from an allowed loopback Participant Portal origin and the
exact current Codespaces Participant Portal origin. Other browser origins fail
with HTTP 403 before target lookup. TenkaCloud answers an allowed `OPTIONS`
preflight locally and replaces every upstream CORS header, including wildcard
`Access-Control-Allow-Origin`, with the exact allowed origin. Polling scoring
uses the Origin-free CLI path. Codespaces exposes the Participant API and each
challenge/Simulator port on separate forwarded origins. Browser cookies are never forwarded
to Simulator/workloads, upstream cookies are never returned, and both request
and response I/O have finite time and size bounds.

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

The protected file also exports the Simulator URL/token/world fields for the bundled
Simulator CLI, provider/engine identity, a local-only AWS signing secret, and
the Azure/GCP/Sakura endpoint and credential pairs. None is a real cloud
credential. Query parameters are not used for routing because native Query and
ARM APIs own their query strings. The native proxy also applies finite request,
response, and time bounds and recomputes response framing after buffering; it
never forwards a stale upstream `Content-Length`.

In Codespaces, the portal, Participant API, each challenge, and Simulator
console remain on distinct forwarded-port origins. For example:

```text
https://<codespace>-18180.app.github.dev/...
```

The generated runtime config points directly at that run's forwarded API
port, and browser-facing output URLs use their own forwarded port. Nothing is
proxied through the portal's `5175` origin, so challenge content cannot read the
portal runtime config or storage. Terminal commands can still use loopback.

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
ADR-012). The platform is problem-agnostic: `tenkacloud local --problem <id>` resolves
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
- A browser request that carries an unapproved `Origin` is rejected before any
  local API route executes, even when the request would otherwise qualify as a
  CORS simple request. Origin-free CLI traffic remains supported.
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
