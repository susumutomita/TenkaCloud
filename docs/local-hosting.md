# Local competition hosting

Local hosting runs a competition on the organizer's computer. It is a different
entry point from `make local`: individual practice and its existing login flow
are unchanged. The host console requires a host key, while participants sign in
with the team keys issued for their event.

## Supported problems

The application server uses Bun and a local SQLite file. There is no AWS,
Cognito, external database, or application container to provision. The browser
interfaces are built using the repository's existing Vite pipelines.

| Problem | Runtime | Requirements |
| --- | --- | --- |
| SQL injection (`challenges/sqli-demo`) | One isolated Docker Compose project per team | Docker |
| Cryptography Battle (`battles/ac26-crypto-battle`) | Shared match on the host; private view per team | Bun + SQLite, no Docker or AWS |

Both reuse the catalog's statements, rules and scoring. You can include both in
one event; their points contribute to the same leaderboard. A local event can
have one shared Battle. Other catalog problems require a compatibility and
isolation review before being enabled. The SQL exercise gateway is not a generic
proxy or a sandbox for arbitrary workloads.

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
   the **Schedule** tab. Each Docker team/problem environment gets its own block of host
   ports; the application skips occupied blocks and moves a retried environment
   when its previous ports were taken. Cryptography Battle runs in the participant
   portal and does not allocate exercise ports.
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

### Play Cryptography Battle

1. Create an event, choose **Cryptography Battle** and two or more teams.
2. Deploy, then distribute each team's invitation link/key. No AWS account or
   Docker daemon is needed for this problem.
3. Start the event from **Schedule**. Participants open the problem and press
   **Ready**. Orders begin when every team is ready.
4. Solve an order or choose **LEAK** to score. Published evidence can then be used
   by opponents for **HUNT**. Battle points appear in the portal and leaderboard.

The actual catalog plugin runs on the host. Each participant receives their own
vault and public evidence. The match secret and other teams' vaults stay on the host. State, public evidence,
orders, scores and retry receipts are saved in SQLite. Restart with the same data
directory to resume; restarting does not reset the clock. A running Battle's
start time cannot be changed. Create a new event for a fresh match.

**Stop**, **Restart** and **Tear down** on a Battle team control that team's portal
access. They retain shared match state and scores; the match clock continues.
To end scoring for everyone, use **End Event**. A scoring lock pauses the Battle
clock; unlocking does not apply penalties for the locked interval. The event
end time remains fixed. Teardown settles elapsed play before closing access.
The optional AWS Parameter Store item is not enabled in local hosting. Battle parameters currently use the catalog
defaults; local event duration can be set from Schedule.

### One team's environment

The **Teams** tab lists every team/problem environment with its status and gateway
port. Docker rows can be operated on their own; other teams' containers, gateways and
scores are not touched. Battle access controls are described above:

- **Stop** halts the containers (`docker compose stop`) and keeps their data. The team
  sees the problem as stopped and cannot submit to it.
- **Restart** starts a stopped or running environment again with its data
  (`docker compose restart`). A failed or removed environment is rebuilt from scratch.
  Restart is available while the event is being prepared or is ready.
- **Tear down** removes that team's containers and volumes. Scores and submissions stay.

While an operation runs, the environment is not handed out and its gateway stops
forwarding. A gateway also refuses to forward once its environment was rebuilt in
another slot. A deliberately stopped or removed environment does not demote a ready
event when the host restarts, and an event that has a start time (already started, or scheduled to start) stays ready
even if one environment was lost, so the scoring gate is not closed, or kept from
opening at the scheduled time, for every team; restart that environment from the
**Teams** tab. Only an event without a start time returns to its deployment state. The
event-level deploy never redeploys a stopped environment (redeploying discards its
data), and **Retry failed** redeploys failed environments only. A consequence: an
event that is still being prepared does not become ready while one of its
environments is stopped; the **Schedule** tab says so, and restarting that
environment from the **Teams** tab completes the preparation.

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
the exercise-gateway ports for Docker problems (default `5200-5239`) on the selected
address. A Battle-only event needs only the participant port.
Keep the host-console port closed; it listens on loopback only.

Each Docker environment's gateway always uses the port of its runtime slot: slot `n`
listens on the range's start plus `n - 1`, and slots never share a port. The
**Teams** tab shows each environment's port, and the terminal logs
`Exercise gateway for <team> / <problem>: <URL>` when a gateway opens. A slot whose
gateway port is held by another process is skipped when environments are
prepared. Choose another range with `--gateway-ports`, for example
`--gateway-ports 6200-6239`; it must lie within 1024-65535 and not include the
console or portal port. The host refuses to start when the range overlaps a port a
supported problem publishes in any runtime slot. An event whose teams × Docker problems
exceeds the range is refused at creation and deployment with an error naming
`--gateway-ports`. Gateway ports are probed on the address the gateways listen on
(the `--lan` address in LAN mode); problem ports are probed on loopback, where
Compose publishes them.

Battle teams do not reserve or probe exercise-gateway ports. The overall limit
of 40 team/problem environments still applies.

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

When Docker is not running, preparing SQL exercise environments fails with
`Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry
the deployment from the host console.` Ownership of any partial environment is
kept. Start Docker and deploy again from the **Schedule** tab (or **Retry failed**):
the retry removes what the failed attempt left and starts the environments.

Use the host console's teardown action to remove the event's Docker projects
and volumes. This keeps event records and results. Failed cleanup retains its
ownership record and remains retryable; once every environment is removed, and for
an archived event, teardown is refused. An event that was torn down before it
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
through browser metadata. Only reviewed SQL metadata and the Battle portal are included in
hosting catalog/plugin globs; server reducers, fixtures and private seeds are excluded. Participant instructions are returned by the
authenticated backend after the event starts.

The organizer's own account, local operating-system processes and the checked-out
repository are trusted. This feature does not protect against a malicious
organizer or an attacker already running code as that operating-system user.

## Capacity

Fixed limits:

- 1–40 teams per event, and at most 40 team/problem pairs per event.
- At most 40 Docker exercise environments at once on one host, across all events (one
  exercise-gateway port each). A Battle uses no such environment.
- A Battle's saved match state must stay under 2 MiB.

One host process serves every request on one thread, so the number of open
participant browser tabs sets the load. Measured in a browser, a tab on the
Cryptography Battle page reads the match every 5 seconds, its team view and the
leaderboard every 30 seconds, and notifications every 60 seconds.

Measured on an Apple M5 (10 cores, 32 GB), Bun 1.3.11, over loopback, with the
load generator on the same computer. One event with 40 teams, one organizer
tab, and the participant tabs spread evenly across the teams, 60 seconds per
step:

"Latency p95" means 95 out of 100 requests were answered within that time.

| Participant tabs | Tabs per team | Latency p95 | Errors | Host CPU (avg) |
| --- | --- | --- | --- | --- |
| 40 | 1 | 16 ms | 0 | 13% |
| 160 | 4 | 17 ms | 0 | 27% |
| 320 | 8 | 17 ms | 0 | 40% |
| 640 | 16 | 23 ms | 0 | 61% |
| 960 | 24 | 34 ms | 0 | 84% |

These numbers are from the start of a match. In a simulated 90-minute match
where every team published every Order it could, the 40-team match state
stayed under 100 KB, and one match read took 3.3 ms at the start and 5.5 ms at
the end (p95). That suggests, but does not measure, less headroom late in a
match, possibly about half. The table does not cover Wi-Fi or other LAN
transport, SQL exercises in Docker, or slower computers. The load generator
waits for a tab's previous request before sending its next one, while real
browsers do not, so the point where the host falls behind comes earlier than
the tool shows.

Each match read also saves the whole match state to SQLite: about 50–95 KB
with 40 teams, growing during the match. Estimated from that size, not
measured on disk: 40 teams with 2 tabs each write about 1.3 MB/s, roughly 7 GB
during a 90-minute match. SQLite writes whole pages and later copies its
write-ahead log into the database file, so the actual disk writes are higher.

Measure your own computer with the same tool. It starts a separate host on
ports 6274, 6275 and 6300-6339 with a temporary data directory:

```sh
BUN_CONFIG_MAX_HTTP_REQUESTS=4096 bun run bench:host -- --mode http --teams 40 --tabs 40,160,320,640,960
bun run bench:host -- --mode state --teams 2,10,20,40
```

## Validation commands

The hosting suite uses real HTTP listeners and SQLite. It tests the actual
Battle plugin through Ready, LEAK, HUNT, score/rank updates, event isolation and
restart recovery. SQL boundary tests use an explicitly test-only exercise adapter. It does not stand in for a
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
