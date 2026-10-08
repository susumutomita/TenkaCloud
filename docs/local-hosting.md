# Local competition hosting

Local hosting runs a competition on the organizer's computer through `make local`.
The host console uses
one organizer key, with no username, password or local SAML sign-in. Participants
sign in with the separate team keys issued for their event. Cloud organizer
authentication remains Cognito.

## Supported problems

The application server uses Bun and a local SQLite file. There is no Cognito,
external database, or application container to provision. The local entrypoint does
not use AWS credentials; [AWS problems require cloud hosting](#aws-problems-use-cloud-hosting). The browser interfaces are built
using the repository's existing Vite pipelines.

| Problem | Runtime | Requirements |
| --- | --- | --- |
| 106 local Compose exercises, including `sqli-demo` | One isolated, on-demand Compose project per team/problem; workbenches and 15 opted-in terminals | Docker |
| Cryptography Battle (`battles/ac26-crypto-battle`) | Shared match on the host; private view per team | Bun + SQLite, no Docker or AWS |
| Forensic Casebook (`battles/forensic-casebook`) | Three synthetic incident investigations; evidence-cited answers and private progress per team | Bun + SQLite, no Docker or AWS |

The local exercises reuse their catalog statements, verifiers, hints and scoring.
The four former local Battle-shaped exercises are offered as Challenges; native
Cryptography Battle retains its shared-match rules. Catalog/workbench/terminal
boundary tests do not establish real Docker playability of every exercise.
Installed pack activation records are not yet part of the host runtime catalog.

### Forensic Casebook

Select **Forensic Casebook** when creating an event, issue the team keys, deploy, and
start the event. One team can study alone; multiple teams compete on the same
300-point ceiling. The participant panel contains three cases: identity and
authorization, log correlation and exfiltration scope, and backup administrative
trust. Each answer includes evidence-file citations. Wrong answers can be retried;
three free hints and explanations after correct answers support learning. No
cloud account, paid API, Docker, malware, or ESXi installation is required.

Evidence is synthetic and team-specific. A supplied SHA-256 digest checks download
consistency, not the truth or provenance of an incident. The pack does not recreate
a named real incident or claim comprehensive security coverage.

Competition state and scores use the host's SQLite persistence. Participants cannot
reset a competition. For a fresh competition, create another event. A separate
loopback-only practice harness in the catalog offers an explicit reset that creates
new evidence and clears practice progress. See the catalog's
[practice and instructor instructions](../problems/battles/forensic-casebook/README.md).

The open-source host is authoritative only when run by a trusted organizer. A
participant controlling the host, database, or source can inspect or change grading;
local practice is not a tamper-resistant competition. Keep organizer keys and the
host filesystem outside participant access. Browser answers and grading inputs stay
on the server until the relevant question has been solved.

### Structured local practice

For individual practice, create a normal event with one team and select the built-in
Docker exercises you want to study. The participant sidebar's **Course tracks** view
groups only that team's assigned problems by their authored track/chapter order.
Assigned drafts remain visible. Unassigned exercises are not offered as next steps;
the ordinary **Problems** list still contains every assigned problem.

Checkpoint and completion progress come from the same team scoring state as the
competition pages and survive a host restart. The existing optional event progression
gate remains authoritative: locked problems are labeled and are not recommended until
unlocked. Track order is guidance, not an additional prerequisite graph. A one-team
event retains the normal event timing, hint penalties and writeup disclosure rules.

This reuses the local competition host and team-key sign-in. It does not restore the
retired individual-practice backend, execute installed external Packs, or offer Docker
courses in cloud hosting. Course source links omit embargoed alignment; problem answers,
writeups, hints and executable Pack plugins remain outside the public metadata bundle.

New Docker events prepare dormant jobs. Participants start or resume their own
environments as needed. Stopping preserves container writable layers and volumes,
not process memory. There is no automatic eviction of another problem or team.
The HTTP gateway supports the owned application's paths, assets, forms and
server-managed cookies; application cookies are namespaced per job because browser
cookies do not isolate TCP ports. Custom apps that manipulate Cookie names directly
in browser JavaScript require a compatibility check.

## Start

Use macOS or Linux, including WSL2. Native Windows is not supported by this entry
point. From the repository root:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile --ignore-scripts
make local      # foreground console; keep this terminal open
# In a second terminal, with the same --data option if one was used:
make down       # stop owned local runtimes; preserve event and runtime data
```

Pass options through `LOCAL_ARGS`, for example
`make local LOCAL_ARGS="--no-build"`.

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

The terminal prints the two URLs and the exercise-gateway port range. Each
interactive `make local` start generates a new organizer key and shows it once on
the private terminal. Previous organizer keys and sessions are revoked; events,
scores, participant keys and problem data are retained. Noninteractive and
public/container starts retain existing keys and never print them to redirected
output or container logs; use an interactive `make local-reset` to obtain a key.
The defaults are the host console at `http://127.0.0.1:5174`, the
participant portal at `http://127.0.0.1:5175` and exercise gateways on ports
`5200-5239`. Use the printed URLs exactly; arbitrary Host aliases are not
accepted. The organizer key is not included in browser configuration and the
browser keeps it only until submission. SQLite stores only its SHA-256 hash and
rotation version. The private `host-key` file is an internal token-signing key,
not the organizer login key; keep it with the database when backing up state.

The host console is the normal Application Admin Console running in local-host
mode: the same event list, event creation page, event detail tabs, schedule,
scoreboard, notifications and report, served against this computer's API. On the
first and later visits, enter the organizer key. The key grants organizer Admin
access. Local **Users**, password and SAML management are not offered. Dedicated
audit collection, settings and read/export endpoints are retired. This change does
not migrate or purge existing audit tables or rows. Older organizer records remain historical
state and cannot authenticate after key mode is enabled. There is no local Cognito.

To rotate the key while the host is running, run `make local-reset` in another
interactive terminal. If the key is lost, this command displays a replacement;
restarting with interactive `make local` also displays a new key. For a custom
state directory use the same `LOCAL_ARGS="--data <directory>"`. Rotation works with
the managed host running or stopped. It invalidates the old organizer key and all
organizer sessions, preserving events, scores, progress, participant keys and
running/stopped problem environments. It does not stop containers or delete data.
A redirected or noninteractive reset refuses before mutation. `make local-clear`
retains the organizer key and deletes event history; it is not a key-recovery command.
An unrecognized or
unreachable running controller is not replaced and no process is killed. Before upgrading an
already running older host, stop it with Ctrl+C in its original terminal. New
commands refuse controllers without directory-bound request support; copied
launcher metadata cannot rotate or stop a different live host.

After signing in:

1. **Create event**: name the event, set the team count and choose the problem.
   Only problems this host can run are selectable; the others are listed as not
   supported locally. Local Docker and Battle events do not select an AWS account. The dialog after
   creation shows the participant URL and each team's key; keys stay copyable in
   the **Teams** tab.
2. **Prepare**: choose **Deploy now** in that dialog or the **Schedule** tab.
   New Docker jobs receive exact durable port maps but stay stopped. Native Battle
   preparation keeps its existing behavior. Docker port reservations are
   retained while stopped so resume never recreates a played environment merely
   to move its ports. Only active jobs lease an exercise-gateway slot.
3. **Start**: in the **Schedule** tab, choose **Start now** (or pick a start time) and,
   optionally, an end time. **End Event** in the page header stops scoring.

Participants use the normal Participant Portal and its actual backend login, not
the practice-mode or demo login. They use **Start / resume** and **Stop (keep data)**
for on-demand exercises. Admission errors do not stop another environment.
A played generation is always resumed in place; a first start that never became
playable can clean up its owned partial resources before retrying.

Cloud-only features that are not implemented by this local host are not offered:
capacity monitoring, scheduled deploy and automatic teardown. Their navigation entries and
tabs are hidden; opening such a URL shows an explanation instead of a failing
request.

### Disruptions (Red Team)

The retained disruption engine and its tests cover SSM inject/revert ownership,
scheduled work, uncertain outcomes and durable cleanup. This is not an available
AWS execution feature of `make local`: the current entrypoint does not configure
AWS clients, and `hello-world-battle` is not selectable for local hosting.

AWS disruption execution and its cloud UI/API wiring remain part of cloud-hosting
acceptance. Retaining these modules or displaying authored fault declarations does
not make those actions executable. Unsupported declarations must not be reported
as successful fires.

For an event created by an earlier AWS-enabled host revision, retain that exact
revision and its private state for reviewed cleanup. Pending SSM revert work must
not be redirected to a new account or replacement stack. See
[AWS problems use cloud hosting](#aws-problems-use-cloud-hosting).

### Play Cryptography Battle

1. Create an event, choose **Cryptography Battle** and two or more teams.
2. Deploy, then distribute the participant URL and each team's key. No AWS account or
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

### Progression gates

Open **Progression / Gate** in the event detail page. The host flag
`challengePrerequisiteGate` defaults to OFF. Enable it, choose one gate problem
and the problems it unlocks, then save. Team overrides can bypass the prerequisite
or change the completion bonus. With the flag OFF, the host retains the settings
and permits ordinary play, while rejecting gate configuration PUT and DELETE.
The flag itself remains editable by an Admin; viewing saved settings remains available.

The first positive cumulative score or correct flag completes a problem. SQLite
records that fact under the event, team and problem, independently of deployments.
Removing and adding the configuration, rebuilding the environment, changing the
bonus or switching the feature OFF and ON does not erase completion or award the
bonus twice. A completion recorded while OFF can receive its configured bonus
when the feature is enabled. A zero bonus is also recorded as settled.

Locked problems reveal only their card identity. Their instructions, hints,
outputs and endpoints are withheld; flag submissions, hint reveals, Battle
operations and exercise-gateway requests are rejected. Shared Battle time still
advances; scores for locked teams are skipped and are not awarded retroactively.
Invalid stored gate settings close participant access until an organizer repairs
them; the host and admin settings remain available.

This gate controls local host APIs and newly issued exercise access. Cloud AWS
resource isolation requires its own account/role policy review. A host progression
gate is not proof that already-issued AWS sessions have been revoked.

### One team's environment

The **Teams** tab lists every team/problem environment with its status and gateway
port. Docker rows can be operated on their own; other teams' containers, gateways and
scores are not touched. Battle access controls are described above:

- **Stop** halts the containers (`docker compose stop`) and keeps their data. The team
  sees the problem as stopped and cannot submit to it.
- **Restart** starts a stopped or running environment again with its data
  (`docker compose restart`). On-demand environments retain their played generation
  even after a failed resume; only an incomplete first start is cleaned up and retried.
  Legacy eager events retain the older failed/removed-environment rebuild behavior.
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
data), and **Retry failed** redeploys failed environments only. New on-demand
events are ready while Docker jobs remain stopped: participants start them when needed.
Older eager events still require every prepared environment to be running.

An organizer login expires after eight hours or 15 minutes without a request.
Sign in again with the organizer key after expiration. `make local-reset`
revokes all organizer sessions, including sessions issued before an upgrade from
password/SAML authentication. Participant access is independent. Expiry and key
rotation do not stop the event or discard its results.

Subsequent runs may reuse the compiled interfaces:

```sh
make local LOCAL_ARGS="--no-build"
```

Rebuild after changing source code. To build without starting servers:

```sh
bun run build:host
```

## Update the problem catalog

Source updates and running-host updates are separate. `make submodule-latest`
fetches the tracked branch of `problems/` and stages a fast-forward Git pin for review.
It does not rebuild the browser interfaces, reload a running process, or change
saved event definitions. Use it between events, before creating the next event.

`submodule-latest` follows the configured `main` branch, unless overridden in
the submodule settings. Its tip can be older than an ahead-of-main trial pin.
Keep that reviewed pin until the tracked branch contains its commits. The updater rejects
older or divergent targets before checkout or staging, including squash-equivalent
history. A deliberate switch to divergent history requires a separately reviewed
pin selection; this command has no force option.

The updater requires an initialized catalog and refuses staged, unstaged or
untracked problem-source changes, or a checkout that differs from the staged pin.
It does not stash or discard work. Unrelated platform files and staged changes
are preserved. Fetch failure or unknown ancestry also stops the update; a failed
guard leaves source files and the index unchanged, although fetched Git objects
and remote refs may have advanced.

Local events copy their selected problem definitions when they are created.
Docker definitions also pin the original source directory and every source-file
hash. Replacing those files can block an existing job's start, recovery or resume,
even after a normal stop/restart. Stopping retains data; it does not make a catalog
replacement safe for an event you still need to resume. Keep its original checkout
and data directory intact and use a separate clone for the next catalog revision
when old and new events must coexist. A different `--data` directory alone does
not preserve the old problem source files.

For an installation whose previous events no longer need their original sources:

```sh
# Use the same LOCAL_ARGS (especially --data) as the running host.
make down
git -C problems rev-parse HEAD # record the old catalog commit
make submodule-latest
git diff --cached --submodule=log -- problems
make validate-problems
make local                    # rebuild both interfaces and load the catalog
```

If you deliberately checked out another problem commit, stage it with
`git add problems` before validation and skip `make submodule-latest`.
`make validate-problems` initializes/aligns the submodule to its staged pin;
it must not be used to select a newer commit. Review local content edits with
`git -C problems diff` as well. The validator installs the catalog's locked
dependencies with lifecycle scripts disabled and checks schemas and both READMEs.

Do not pass `--no-build` after replacing catalog content unless you have already
run `bun run build:host` against that exact content. `make build` also includes
the host build, but builds the other workspaces too. Building alone does not
reload the server's in-memory catalog; restart with `make local`, then reload the
browser and create a new test event. Check the problem statement, verifier and
score before admitting participants. Existing events retain their saved definitions;
they are not upgraded to the new catalog by these commands. No AWS deployment is
needed for this local workflow.

## Participants on another computer

The host console always listens on loopback. To expose only the participant
portal and authorized exercise gateways on the organizer's private network,
select an explicit private IPv4 address of that computer. For example:

```sh
make local LOCAL_ARGS="--lan 192.168.1.20 --unsafe-lan"
```

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
supported problem publishes in a legacy runtime slot. New on-demand events can
have more dormant jobs than gateway ports: a slot is leased only while active.
Legacy eager events still need a gateway slot for every Docker job. Gateway ports are probed on the address the gateways listen on
(the `--lan` address in LAN mode); problem ports are probed on loopback, where
Compose publishes them.

Battle teams do not reserve or probe exercise-gateway ports. New events support up
to 512 team/problem entries; the active Docker budget is separate.

### Docker network address capacity

Stopping a container preserves its private network as well as its unfinished work.
The active CPU/memory limit therefore does not bound retained Docker network count.
A host can run out of Docker's default address pools after visiting many problems,
even when only a few environments are active. The host does not prune networks or
silently delete stopped work to make room.

For a larger event, an organizer can supply a private IPv4 pool with
`--docker-network-pool <CIDR>` in `LOCAL_ARGS`. It must be an aligned `/16` through
`/24` range that does not overlap the organizer's LAN, VPN, or other routed networks.
Do not copy a subnet from an example without checking the local network.

New environments then get separate project-owned `/28` subnets. The allocator
checks existing Docker networks, local interface ranges and current reservations;
it fails when no free subnet remains. It preserves declared network separation
and internal-network settings. Subnets are saved with runtime ownership and kept
on stop/resume; only explicit teardown releases the owned environment. Existing
Docker daemon settings and unrelated networks are not changed. Older environments
keep their original plans. VPN routes not visible as local interface ranges still
need the organizer's review before choosing the pool.

This is capacity planning, not a guarantee that 100 running containers fit the host.
See Docker's [per-project IPAM options](https://docs.docker.com/reference/compose-file/networks/#ipam).

The exercise containers' verifier ports remain loopback-only; do not expose them
or rewrite their Compose bindings to `0.0.0.0`.

Gateway access is issued from an authenticated team view. Links are short-lived
and single-use, and each browser receives its own HttpOnly Cookie. Different
teammates can open independent links concurrently. Team-key rotation revokes
old team access, including existing exercise-gateway sessions.

## AWS problems use cloud hosting

AWS-service problems belong to cloud hosting. `make local` refuses the old
`--aws-region` option before initializing AWS clients. Local hosting offers the
non-AWS Compose catalog and native Battle games; it does not create AWS resources.

Cloud hosting uses Lambda and Turso or DynamoDB:
generic CloudFormation deployment, flag/multi-flag and scheduled scoring,
participant Console/CLI access and native coordination. Docker/Compose remains
local-only. `make deploy` handles standard CDK bootstrap and source-bundle upload;
see the [cloud setup guide](../infrastructure/README.md#current-checkouts-setup-and-teardown-boundary).
Finish event Teardown before platform `make destroy`; `--drain-events` is unavailable.
Destroy honors deployed removal policies. DynamoDB defaults to Delete; external
Turso rows remain unless explicitly reset with `make destroy-all`. Source buckets,
CDKToolkit and competitor bootstrap roles remain outside platform destruction.
Live AWS/hosted Turso performance and all-catalog playability are unverified; nine
current AWS templates exceed the restored deployer's TemplateBody size limit.

If an earlier integration revision created AWS resources, keep its private state
and account records. Use that exact reviewed revision for an explicitly authorized
cleanup, or a verified cloud migration procedure. The new local entrypoint does not
adopt, delete or reset those AWS resources. It reports unsupported legacy jobs
without losing their resource references or tournament results.

## Hosting behind a TLS proxy

This optional local-runtime rehearsal image is separate from Lambda-based cloud
hosting and is not the implementation of `make deploy`. It can run behind a
TLS-terminating proxy, which publishes the host console and participant portal at two
HTTPS origins, and the host checks every request's Host and Origin against them:

```sh
docker build -f docker/host/Dockerfile -t tenkacloud-host .
docker run --read-only --tmpfs /tmp --cap-drop ALL \
  --volume tenkacloud-host-data:/data \
  --publish 127.0.0.1:5174:5174 --publish 127.0.0.1:5175:5175 \
  tenkacloud-host \
  --public-admin-origin https://admin.example.com \
  --public-participant-origin https://play.example.com \
  --behind-proxy
```

- **Only the proxy may reach the ports.** The example publishes on loopback for a
  proxy on the same VM. A client that reaches the container directly could forge the
  Host and `X-Forwarded-For` headers, and would speak plain HTTP. On a container
  platform, keep the ports private to its load balancer.
- **The image refuses to start without the public origins.** Inside a container
  loopback is unreachable from the proxy.
- **The proxy must pass the original Host header.** Caddy does this by default.
  nginx needs `proxy_set_header Host $host`. A request with another Host is refused
  with `Untrusted Host header. Expected <host>.`
- **Rate limiting behind the proxy.** `--behind-proxy` rate-limits failed logins by
  the last `X-Forwarded-For` entry, which is the one the proxy appended. Without the
  flag, every request would appear to come from the proxy, so one client's failures
  would lock out everyone. Use the flag only when the proxy sets that header.
- **HTTPS only.** Public origins must be `https:`. `--unsafe-http` exists for local
  smoke tests only.
- **The organizer key.** It never enters container logs. Generate/recover it with
  `docker exec -it <container> bun run scripts/local-host/local.ts reset --data /data`
  in a private terminal. This rotates organizer access while preserving the event
  and participant keys. The `/data` volume contains the hash, database and internal
  signing key; `cat /data/host-key` is not a login or recovery procedure.
- **Health checks.** `GET /healthz` answers on either port whatever the Host header,
  and returns only a status.
- **Supported problems.** Docker Compose problems are not offered. Their sibling
  containers publish on the host's loopback, which the container cannot reach. The
  Cryptography Battle runs in-process and is offered. AWS service problems are not
  offered by this entrypoint. The image is a native-Battle rehearsal target.

`bun run test:host:container` runs a built image, logs in, and plays a started
Cryptography Battle for two teams at the advertised origins.

## Stop, restart and teardown

For a host started with `make local`, Ctrl+C or `make down` closes HTTP listeners,
waits for in-flight operations, stops owned Docker environments and closes SQLite.
SQLite state, runtime Compose plans, problem seeds, container writable layers and
volumes are retained. Restart using the same data directory to recover event state,
team credentials, scores and environment ownership. Participants resume on-demand
problems from their portal; retained eager events keep their restart behavior.

If an environment disappeared or recovery fails, the event returns to a
retryable deployment state. The host console can retry failed environments.
The original event timestamps are retained, so a recovery does not secretly
extend the competition deadline.

Preparing on-demand jobs does not require a Docker daemon. Starting a problem
while Docker is unavailable reports
`Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry
the deployment from the host console.` Ownership of any partial environment is
kept. Start Docker and retry **Start / resume** in the participant portal.
A partial first deployment is cleaned up before retry; a previously playable
environment keeps its data and resumes in place.

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

### Clear local event history

Use `make local-clear` when you want to discard the local competition history and
start fresh. This is separate from `make down` (stop and retain) and
`make local-reset` (rotate the organizer key). Stop the host first:

```sh
make down
make local-clear
```

The clear command lists the exact `hosting.sqlite` path, event IDs and names,
team/job counts and owned Docker projects, then asks for confirmation in the same
terminal. Answer `y` or `yes` to proceed. For a custom data directory, pass the same
`LOCAL_ARGS="--data /absolute/private/directory"` to both commands.

```sh
# Optional preview; no event or Docker data is changed.
make local-clear LOCAL_ARGS="--data /absolute/private/directory --plan"
# Explicit noninteractive confirmation, after reviewing the target and impact.
make local-clear LOCAL_ARGS="--data /absolute/private/directory --yes"
```

Clearing removes every event, team, participant login key, result, score,
submission receipt, progress snapshot, registration and event/audit/uptime/disruption
history in that database. The existing per-project Compose teardown uses
`down --volumes --remove-orphans`: it removes owned containers, writable layers,
volumes and networks, including files and databases edited inside the exercises.
Owned generated Compose plans and problem seeds are also removed. This cannot be
undone without a backup. The SQLite file, organizer keys and sessions, host settings,
account connections, installed problems and cached plugin code are retained.

The command refuses a running host, retained AWS ownership, unknown database tables,
untracked runtime directories, unknown files and unsafe links. It never searches for unrelated Docker resources or
prunes shared images and caches. Preserve and review ambiguous legacy files rather
than deleting the state directory to get past a refusal.

Old generated directories from before ownership markers are supported when their
job retains a valid Compose ownership record. The existing engine validates the
saved paths, project and Compose plan before teardown. A job already recorded as
`DELETED` with no owned environment can also have the seed-only directory left by
old successful teardown, or an empty directory left by interrupted file cleanup.
Only the expected regular files in that job's private directory are accepted;
the command lists their exact paths before confirmation. It does not adopt the
directory, create an ownership marker or read seed values to infer ownership.
A legacy directory with no matching job, an unresolved job with no ownership record,
or additional files remains blocked.

Successful Docker teardown is recorded before legacy seed and empty-directory
removal. If either file operation fails, all event/history rows remain, and retry
finishes the known remainder without repeating the completed Docker teardown.

If any owned teardown fails, event/history rows and failed ownership plans remain.
Successful removals are recorded immediately, so the next `make local-clear` retries
only the remaining owned environments. A database or file cleanup failure is reported
without claiming the history was cleared. Start Docker Desktop or Docker Engine if
it is unavailable, resolve the reported job's error, and retry with the same data
directory. Backups and browser downloads are outside this cleanup.

When `make down` reports, for example, `2 owned Docker jobs are not confirmed stopped`,
that means two retained team/problem environments, not necessarily two containers.
It can include earlier failed deployments that were already unresolved before
shutdown. The report identifies each event, team, problem, job, expected Compose
project, status and safe error category. No keys or raw Docker output are printed.

## Generated files and retained data

- `.tenkacloud/host/`, or the selected `--data` directory, holds resumable event
  data. Its SQLite database, keys and `runtimes/<jobId>/` files are not a cache.
  Normal `make down` retains them, including each problem's seed and Compose plan.
- After a successful explicit Docker teardown, a newly marked runtime directory
  loses only its known generated Compose file, seed and ownership marker. Failed
  teardown retains those files. Unknown files, changed markers and symbolic links
  stop file cleanup. Legacy unmarked runtime directories retain their other files;
  they are not automatically adopted or recursively deleted.
- Shared fixture helpers, browser-rehearsal data and host benchmarks use
  `.tenkacloud/cache/tmp/`. Cleanup checks the owning process and run marker, then
  waits for the run's children and resources to close. Interrupted runs, reused PIDs
  and old or unmarked temporary directories are not automatically swept.
- `.tenkacloud/host-build/` is replaced at its fixed paths by the next host build.
  Screenshots in `.tenkacloud/*-e2e/` and reports in `.tenkacloud/bench/` remain as
  diagnostic evidence. Docker images and shared build caches are not pruned.

Do not delete the entire `.tenkacloud/` tree to clear temporary files. It also
contains the event database and optional installed pack snapshots. Review retained
ownership before removing old files; age or a `tmp`/`cache` name alone is insufficient.

## Persistence and trust boundaries

SQLite and its state directory are private to the operating-system user.
Only one host process may open a particular database for writing. Team secrets
and runtime descriptors live in that private state, not in a publicly served
JSON file. Back up the entire data directory after stopping the application;
when using a custom backup process, include SQLite's WAL state correctly.

The host console, participant portal and exercise pages use separate origins.
Host APIs require an organizer sign-in token issued by the application. Participant identity is derived from
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
through browser metadata. The safe catalog projection covers all 106 local Compose
IDs and the supported AWS entries. Cryptography Battle remains the only executable
portal plugin; server reducers, fixtures and private seeds are excluded. Participant instructions are returned by the
authenticated backend after the event starts.

The organizer's own account, local operating-system processes and the checked-out
repository are trusted. This feature does not protect against a malicious
organizer or an attacker already running code as that operating-system user.

## Capacity

New-event limits and defaults:

- 1–40 teams and at most 512 team/problem entries per event
- Three active Docker environments per team and twelve across the host
- 4096 MiB for the sum of configured container memory caps, across active and uncertain jobs
- New Compose plans preserve authored resource limits; missing limits become 512 MiB, one CPU and 256 PIDs per service
- At most 40 active gateway slots with the default range; stopped jobs keep runtime ports but release gateways
- A Battle's saved match state must stay under 2 MiB

Tune admission with `LOCAL_ARGS="--max-active-per-team 3 --max-active-environments 12 --container-memory-mib 4096"`.
These are conservative admission controls, not measured capacity or a guarantee
that a Docker VM has enough memory. Reserve capacity for Docker, images and the
host itself. Some multi-service problems consume more than one environment's worth
of RAM. Start with representative exercises and measure your machine.

A synthetic plan using 20 real catalog definitions and five teams allocated 100
dormant jobs in 105 distinct runtime ports, without launching 100 containers.
Synthetic lifecycle tests cover admission, state-preserving stop/resume and
failure recovery. This is not a 100-container performance benchmark. Storage usage
still grows with created images, stopped containers and volumes; only an explicit
owned-environment teardown removes that state. No automatic data eviction runs.

Existing eager events retain their prior 40-job contract.

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

The host keeps each Battle's match state in memory (about 50–95 KB with 40
teams, growing during the match) and writes it to SQLite when a team acts, when
a score changes, when the organizer ends, locks or tears down the event, and
otherwise at most once every 5 seconds, however many tabs are open. Measured
in one run of the state simulation below (40 teams, one match read per team
every 5 seconds, every Order leaked, 30 simulated minutes): 801 match state
writes totalling 55 MB, about 27 writes and 1.8 MB per minute. SQLite writes
whole pages and later copies its write-ahead log into the database file, so the
actual disk writes are higher. Ctrl+C writes the state held in memory before
the host exits. If the host process is killed instead, up to 5 seconds of match
progress that changed no score is lost and the match continues from the last
write, which can change the Orders issued afterwards. Closing the terminal
window counts as a kill.

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
organizer signs in with the key, verifies key rotation and sign-in revocation, then creates a two-team
event, deploys and starts it; two independent participant browsers sign in with
their team keys, open their own exercise, submit its flag and see the ranking;
the organizer then ends the event and tears the environments down:

```sh
bun run test:host:e2e                          # test-only exercise adapter
HOST_E2E_ENGINE=docker bun run test:host:e2e   # the real sqli-demo in Docker
```

The same command also runs a cloud rehearsal with a test-only AWS adapter. It
creates a two-team event through the real HTTP API, then checks each participant
portal in Chromium, submits the team's flag, checks the score, and tears down.
This checks the host application without creating resources in AWS.

The course rehearsal uses the real local HTTP/SQLite host, built participant UI
and built-in Docker metadata. Saved checkpoints are seeded to check course order,
assigned-problem visibility, gate state, team isolation and restart persistence;
this rehearsal does not execute Docker verifiers.

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
participant payments, cost splitting,
automatic deploy/teardown schedules, arbitrary problem packs, Docker problems in
the hosted container, and platforms without a persistent volume are not implemented
yet.

## Participant access

In the Teams tab, copy the participant portal URL and each team's login key, then
distribute them privately to that team. Participants sign in with the key and
choose their team name. Shared self-registration links and receipt-based key
retrieval are retired; previously issued team keys still work. Existing teams,
scores and historical registration records are retained.
