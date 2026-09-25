# Local competition hosting

Local hosting runs a competition on the organizer's computer. It is a different
entry point from `make local`: individual practice and its existing login flow
are unchanged. The host console requires a host key, while participants sign in
with the team keys issued for their event.

## Initial supported scope

The application server uses Bun and a local SQLite file. There is no AWS,
Cognito, external database, or application container to provision. The browser
interfaces are built using the repository's existing Vite pipelines.

The initial exercise is the existing `challenges/sqli-demo` problem. Its Docker
Compose environment, statement, verifier, hint rules and score calculation are
reused. Each team receives its own Compose project, ports and deployment secret.
Docker is required to start this exercise, not to start the hosting application
or prepare an event. A missing or unhealthy Docker daemon produces a deployment
failure; it never becomes a simulated success.

Other catalog problems are not automatically offered. A problem with a shell,
code execution, a custom portal plugin, a different HTTP surface, or a shared
network needs its own isolation and compatibility review before being enabled.
The sqli-demo-only gateway is not a generic proxy or a sandbox for arbitrary
untrusted workloads.

## Start

Use macOS or Linux, including WSL2. Native Windows is not supported by this entry
point. From the repository root:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
make host      # the same as: bun start
```

Pass options through `HOST_ARGS`, for example
`make host HOST_ARGS="--no-build"`.

Use the repository-pinned Bun version, currently 1.3.11 at the implementation
base. Startup builds the host and participant interfaces and creates
`.tenkacloud/host/hosting.sqlite` and `.tenkacloud/host/host-key`. Generated assets
are separate from the regular application builds, under
`.tenkacloud/host-build/`.

A custom `--data` directory must either not exist yet or already be private to
your user (mode `700`). The application creates a missing directory with that
mode and refuses to change the permissions of an existing one, so pointing
`--data` at a shared project or home directory fails instead of locking other
users and services out of unrelated files.

The terminal prints the two URLs, the exercise-gateway port range and the host
login key. The defaults are the host console at `http://127.0.0.1:5174`, the
participant portal at `http://127.0.0.1:5175` and exercise gateways on ports
`5200-5239`. Use the printed URLs exactly; arbitrary Host aliases are not
accepted. The host key is not included in public browser configuration.

The host console is the normal Application Admin Console running in local-host
mode: the same event list, event creation page, event detail tabs, schedule,
scoreboard, notifications and report, served against this computer's API. Sign in
with the terminal's host key (there is no Cognito). Then:

1. **Create event**: name the event, set the team count and choose the problem.
   Only problems this host can run are selectable; the others are listed as not
   supported locally. There is no AWS account or region to choose. The dialog after
   creation shows each team's key and invitation link once; keys stay copyable in
   the **Teams** tab.
2. **Deploy**: choose **Deploy now** in that dialog, or prepare the environments from
   the **Schedule** tab. Each team/problem environment gets its own block of host
   ports; the application skips blocks whose ports are already bound by another
   process, and a retried environment moves to a free block when its previous ports
   were taken in the meantime.
3. **Start**: in the **Schedule** tab, choose **Start now** (or pick a start time) and,
   optionally, an end time. **End Event** in the page header stops scoring.

Participants use the normal Participant Portal and its actual backend login, not
the practice-mode or demo login.

Console features that need cloud infrastructure are not offered: AWS competitor
accounts, tenant users, the audit log, SAML, the problem catalog's cloud
deployments, disruptions, the progression gate, registration links, capacity
monitoring, scheduled deploy and automatic teardown. Their navigation entries and
tabs are hidden; opening such a URL shows an explanation instead of a failing
request.

### One team's environment

The **Teams** tab lists every team/problem environment with its status and gateway
port. Each row can be operated on its own; other teams' containers, gateways and
scores are not touched:

- **Stop** halts the containers (`docker compose stop`) and keeps their data. The team
  sees the problem as stopped and cannot submit to it.
- **Restart** starts a stopped or running environment again with its data
  (`docker compose restart`). A failed or removed environment is rebuilt from scratch.
  Restart is available while the event is being prepared or is ready.
- **Tear down** removes that team's containers and volumes. Scores and submissions stay.

A deliberately stopped or removed environment does not demote a ready event when
the host restarts.

The initial host sign-in has a 15-minute absolute lifetime, in addition to the
existing idle logout. Sign in again with the terminal key after expiration;
this does not stop the event or discard its results.

Subsequent runs may reuse the compiled interfaces:

```sh
bun start --no-build
```

Rebuild after changing source code. To build without starting servers:

```sh
bun run build:host
```

## Participants on another computer

The host console always listens on loopback. To expose only the participant
portal and authorized exercise gateways on the organizer's private network,
select an explicit private IPv4 address of that computer. For example:

```sh
bun start --lan 192.168.1.20 --unsafe-lan
```

With `make host`, pass the same options as
`make host HOST_ARGS="--lan 192.168.1.20 --unsafe-lan"`.

The address above is an example, not an automatically discovered address. This
mode uses unencrypted HTTP. The explicit `--unsafe-lan` acknowledgement is
required: use a trusted, isolated event network, and do not forward these ports
to the Internet. Host, Origin and bearer checks are not transport encryption.
An attacker who can capture network traffic can steal HTTP credentials.

Participants need the printed participant URL, not the host-console URL. The
operating-system firewall must permit the participant port (default `5175`) and
the printed exercise-gateway range (default `5200-5239`) on the selected address.
Keep the host-console port closed; it listens on loopback only.

Each environment's gateway always uses the port of its runtime slot: slot `n`
listens on the range's start plus `n - 1`, and slots never share a port. The
**Teams** tab shows each environment's port, and the terminal logs
`Exercise gateway for <team> / <problem>: <URL>` when a gateway opens. A slot whose
gateway port is held by another process is skipped when environments are
prepared. Choose another range with `--gateway-ports`, for example
`--gateway-ports 6200-6239`; it must lie within 1024-65535 and not include the
console or portal port. A range narrower than 40 ports lowers the number of
environments the host can run at once.

The exercise containers' verifier ports remain loopback-only; do not expose them
or rewrite their Compose bindings to `0.0.0.0`.

Gateway access is issued from an authenticated team view. Links are short-lived
and single-use, and each browser receives its own HttpOnly Cookie. Different
teammates can open independent links concurrently. Team-key rotation revokes
old team access, including existing exercise-gateway sessions.

## Stop, restart and teardown

Ctrl+C closes the host's HTTP listeners first, waits for environment
operations that are already in flight, and then closes SQLite. It preserves
SQLite state and running problem environments. Restart using the same data
directory to recover event state, team credentials, score history and
environment ownership; recorded environments are re-adopted concurrently, so an
unreachable environment delays startup by one readiness timeout, not one per
environment.

If an environment disappeared or recovery fails, the event returns to a
retryable deployment state. The host console can retry failed environments.
The original event timestamps are retained, so a recovery does not secretly
extend the competition deadline.

When Docker is not running, preparing environments fails with
`Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry
the deployment from the host console.` Ownership of any partial environment is
kept. Start Docker and deploy again from the **Schedule** tab (or **Retry failed**):
the retry removes what the failed attempt left and starts the environments.

Use the host console's teardown action to remove the event's Docker projects
and volumes. This keeps event records and results. Failed cleanup retains its
ownership record and remains retryable. An event that was torn down before it
ever started (for example after a failed first deployment) can be prepared again;
an event that already ran stays final, so create a new event to host again. Do
not delete the data directory while it still owns environments; the directory
contains the safe cleanup plan and per-deployment secrets.

An archive request is refused while environments remain owned. Ending an event
prevents further scoring but does not itself remove its Docker resources.

## Persistence and trust boundaries

SQLite and its state directory are private to the operating-system user.
Only one host process may open a particular database for writing. Team secrets
and runtime descriptors live in that private state, not in a publicly served
JSON file. Back up the entire data directory after stopping the application;
when using a custom backup process, include SQLite's WAL state correctly.

The host console, participant portal and exercise pages use separate origins.
Host APIs require a host sign-in token issued by the application. Participant identity is derived from
the authenticated team key, never from a submitted `teamId`. The exercise
proxy does not forward portal credentials, cookies or the verifier endpoint.
Submitted answers, hint fees and score updates are serialized per event and
stored transactionally. The server checks the event deadline again after an
external verifier responds, so a late result is not awarded.

Repeated correct submissions cannot receive another award. API clients may
add an `Idempotency-Key` header for retrying a specific submission, including an
incorrect submission. Reusing that key for different content is rejected.
The normal portal's existing submission interface is retained.

The build has a separate allowlist for catalog metadata. Author descriptions,
writeups, hint content and problem implementation files must not be distributed
through browser metadata. Only the initial reviewed exercise is included in
hosting catalog/plugin globs. Participant instructions are returned by the
authenticated backend after the event starts.

The organizer's own account, local operating-system processes and the checked-out
repository are trusted. This feature does not protect against a malicious
organizer or an attacker already running code as that operating-system user.

## Validation commands

The dependency-free hosting boundary suite uses real HTTP listeners and SQLite,
with an explicitly test-only exercise adapter. It does not stand in for a
production Docker or browser-interface test:

```sh
bun run test:host
```

The production smoke test runs the catalog's unmodified Docker exercise for two
teams. It checks isolated deployment, real flag acquisition, the shared scorer,
concurrent-submission behavior, recovery in a new adapter instance, and teardown.
It requires a working Docker daemon and does not skip failures:

```sh
bun run test:host:docker
```

The Docker smoke also covers an unreachable daemon (reported as such, then
recovered by the advised retry) and stopping, restarting and removing one team's
environment while checking that the other team's containers, gateway and score
are unchanged.

The browser rehearsal builds the interfaces and drives them in Chromium: the
organizer signs in with the host key in the normal console, creates a two-team
event, deploys and starts it; two independent participant browsers sign in with
their team keys, open their own exercise, submit its flag and see the ranking;
the organizer then ends the event and tears the environments down:

```sh
bun run test:host:e2e                          # test-only exercise adapter
HOST_E2E_ENGINE=docker bun run test:host:e2e   # the real sqli-demo in Docker
```

It uses an installed Chromium (`HOST_E2E_CHROMIUM`, or Playwright's browser under
`PLAYWRIGHT_BROWSERS_PATH`) and never downloads one itself. Failure screenshots
are written to `.tenkacloud/host-e2e/`.

The **Local hosting rehearsal** workflow performs type checks, boundary tests,
interface builds, the real-Docker smoke test and the real-Docker browser rehearsal
for pull requests changing hosting code or either console. It can also be invoked
manually. Existing root test/type-check/build commands include the relevant
local-host checks. Before committing, run the repository's existing
`make before-commit`.

A LAN rehearsal from other devices is still a manual check: open the participant
URL from another computer on the event network, and confirm that the wrong team
key and direct attempts to access host or other-team resources fail.

## Not included

Single-binary release packaging, identity verification, wallet integration,
participant payments, cost splitting, cloud provisioning from local hosting,
automatic deploy/teardown schedules, arbitrary problem packs, and public
Internet hosting are not implemented in this increment.
