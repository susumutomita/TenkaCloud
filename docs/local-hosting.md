# Local competition hosting

Local hosting runs a competition on the organizer's computer. It is a different
entry point from `make local`: individual practice and its existing login flow
are unchanged. The host console uses local organizer accounts. The host key
creates the first Admin once. Participants sign in with the team keys issued
for their event.

SAML sign-in for existing organizers is optional. See [host SAML setup](host-saml.md)
for identity-provider configuration, NameID links and revocation.

## Supported problems

The application server uses Bun and a local SQLite file. There is no Cognito,
external database, or application container to provision, and AWS is needed only
for the optional [AWS problem](#aws-problems). The browser interfaces are built
using the repository's existing Vite pipelines.

| Problem | Runtime | Requirements |
| --- | --- | --- |
| SQL injection (`challenges/sqli-demo`) | One isolated Docker Compose project per team | Docker |
| Cryptography Battle (`battles/ac26-crypto-battle`) | Shared match on the host; private view per team | Bun + SQLite, no Docker or AWS |
| Hello World (`challenges/hello-world`) | One CloudFormation stack in each team's own AWS account | `--aws-region`, AWS credentials and a competitor account per team |
| Hello World Battle (`battles/hello-world-battle`) | One CloudFormation stack per team, with registered frontend/API URLs and uptime scoring | `--aws-region`, AWS credentials, a competitor account and two public endpoints per team |

All of them reuse the catalog's statements, rules and scoring. You can mix them in
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
key used for the first organizer account. The defaults are the host console at `http://127.0.0.1:5174`, the
participant portal at `http://127.0.0.1:5175` and exercise gateways on ports
`5200-5239`. Use the printed URLs exactly; arbitrary Host aliases are not
accepted. The host key is not included in public browser configuration.

The host console is the normal Application Admin Console running in local-host
mode: the same event list, event creation page, event detail tabs, schedule,
scoreboard, notifications and report, served against this computer's API. On the
first visit, enter the terminal's host key and create a local Admin username and
password. Later visits use that username and password. There is no Cognito.

Admin can manage organizer users and settings. Operator can run events and
distribute team keys. Viewer can read event data but cannot see team keys or
change events. Admin can add, disable, change, and delete organizer users from
**Users**. The host refuses any change that would remove the last active Admin
with a local password.

After signing in:

1. **Create event**: name the event, set the team count and choose the problem.
   Only problems this host can run are selectable; the others are listed as not
   supported locally. For Docker-only and Battle events there is no AWS account to choose;
   cloud problems require a verified registered account per team. The dialog after
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

Console features that still need tenant infrastructure are not offered: the
registration links, capacity monitoring, scheduled deploy and
automatic teardown. Their navigation entries and
tabs are hidden; opening such a URL shows an explanation instead of a failing
request.

### Disruptions (Red Team)

The Disruptions tab lists declarations retained with the event's problem definition.
With AWS configured, organizers can submit an immediate, scheduled or recurring
SSM disruption for all teams, selected teams or a persisted random selection.
The history shows each team's command outcome and skipped or uncertain execution.
Request IDs reject conflicting payloads; a transport retry does not create a new fire.

SQLite stores the request, every due time, the target deployment generation and
resolved inject/revert commands before sending anything. Cancellation and event end
stop new injections while retaining cleanup work. Another disruption cannot use the
same resource until the prior revert command finishes. The host never redirects
old cleanup to a replacement stack after redeployment.

Keep the host running through the revert deadline. A stopped host cannot guarantee
on-time recovery. On restart, overdue injections are skipped and pending cleanup
is polled first. An interrupted or timed-out send is discovered by its command
identity and exact targets; it is never blindly repeated. If SSM cannot establish
what executed, history keeps `inject_unknown` or `recovery_required`. Inspect the
original account, instance IDs and SSM command history before manual recovery.
Uncertain executions continue to reserve those resources.

`revert_command_completed` means SSM finished the declared revert command. It does
not prove that the frontend is healthy, especially for declarations using
`|| true`. Check frontend readiness separately; participant-supplied URLs are not
recovery evidence. The host supports SSM declarations with explicit reverts up to
one hour. Lambda/CloudFormation actions, scoring effects and declarations without
an action are reported as unsupported rather than recorded as successful fires.

Execution records are mandatory local operational state, separate from the optional
organizer audit log. The reviewed `hello-world` challenge declares no faults.
`hello-world-battle` declares the `frontend-down` SSM disruption and is selectable
with AWS configured. Its fixed EC2 host hint is checked for initial readiness and
recorded separately from the participant's endpoint observations.

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

This gate controls host APIs and newly issued access. It does not revoke AWS STS
credentials or federation sessions already issued. The participant ViewerRole is
shared across problems in a team's AWS account; its IAM policy may allow access
to another locked problem's resources. Gate enforcement is therefore not an AWS
resource-isolation boundary. Use separate accounts or narrower IAM policies if
resource isolation between problems is required.

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

An organizer login expires after eight hours or 15 minutes without a request.
Sign in again with the organizer password after expiration. Changing a user's
role, password, or status revokes that user's sessions. Bootstrap completion
persists in SQLite across restarts, including when no users remain. The host key
cannot reopen bootstrap or recover an Admin password. Expiry does not
stop the event or discard its results.

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

## AWS problems

`hello-world` deploys one CloudFormation stack into each team's own AWS account.
Start the host with a region to offer it:

```sh
make host HOST_ARGS="--aws-region ap-northeast-1"
```

- **Credentials.** The host uses the AWS SDK's default credential chain:
  environment variables, a profile, or an instance or task role. No flag takes
  keys. At startup the host calls STS `GetCallerIdentity` and prints the operator
  account ID. Without usable credentials it refuses to start.
- **ExternalId.** The host creates `competitor-external-id` in its data directory
  once, with the same file permissions as `host-key`, and prints its value. In
  public mode it prints the file path instead. Every competitor role requires this
  ExternalId, as `competitor-bootstrap.yaml` does.
- **Competitor accounts.** Open **Competitor Accounts** in the host console, register
  each account, and use the displayed operator account ID, ExternalId and exact RoleName
  with `competitor-bootstrap.yaml`. Download the template from the modal and create
  its stack manually in the competitor account; the local host has no public S3
  TemplateURL for CloudFormation Quick Create. Then select **Verify**. Verification
  assumes the registered role with the required ExternalId; only verified accounts
  appear in the cloud event team picker. The form proposes a host-scoped role name,
  while API registration without `competitorRoleName` uses the template's inherited
  `TenkaCloud-CompetitorDeploy-Role` default. An event stores the registered role,
  not an `awsRoleName` supplied in its request. The API equivalent is:

  ```sh
  TOKEN=$(curl -s -X POST http://127.0.0.1:5174/api/host/login \
    -H 'content-type: application/json' -d '{"username":"<organizer username>","password":"<password>"}' | jq -r .idToken)
  curl -s -X POST http://127.0.0.1:5174/api/admin/competitor-accounts \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"awsAccountId":"111111111111"}'
  curl -s -X POST http://127.0.0.1:5174/api/admin/competitor-accounts/111111111111/verify \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
  curl -s -X POST http://127.0.0.1:5174/api/admin/competitor-accounts \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"awsAccountId":"222222222222"}'
  curl -s -X POST http://127.0.0.1:5174/api/admin/competitor-accounts/222222222222/verify \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
  curl -s -X POST http://127.0.0.1:5174/api/events \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"name":"Cloud day","problems":[{"problemId":"ac26-crypto-battle"},{"problemId":"hello-world"}],
         "teams":[{"internalSlug":"team-a","awsAccountId":"111111111111"},
                  {"internalSlug":"team-b","awsAccountId":"222222222222"}]}'
  ```

  Register and verify every target account before creating the event. Deploy,
  start and end it in the host console as usual. An account assigned to an active
  event or an environment awaiting cleanup cannot be deleted.
  Each deployment uses a separate stack name, including when events reuse a team
  account and slug. Recovery and teardown verify ownership before using or deleting
  a stack. A missing or blank scoring output fails deployment.
- **Playing.** Participants see the stack's outputs except the flag output, submit
  the flag and reveal hints in the normal portal. The host compares the answer with
  the flag output it read when the stack was created; scoring makes no AWS call.
- **Hello World Battle.** After deployment, each team registers public frontend
  and API URLs in the participant portal. Both registrations and initial EC2
  readiness are required before the first uptime point. The host records at most
  one score observation per minute in SQLite; a restart does not backfill missed
  minutes. The Disruptions tab can fire the declared SSM fault and tracks its
  revert command separately from observed application health.
- **Regions.** Only regions of the standard AWS partition are accepted; GovCloud,
  China and ISO regions are refused at startup.
- **Restarting.** Without the flag, recovery marks the event's stacks failed with
  a message asking for `--aws-region`, and restarting with it recovers them. A stack
  that finished creating while the host was stopped has no recorded outputs, so it
  is marked failed. **Restart** on that environment in the **Teams** tab deletes and
  recreates it, as does **Retry failed** while the event is being prepared.
- **Participant AWS access.** During play, choose **Open AWS Console** in the portal,
  or open **Tools > SSO Credentials** to issue CLI credentials. Both use the
  environment's `ParticipantViewerRoleArn` from the saved stack outputs. The host
  first assumes the competitor deploy role with its host ExternalId, then the
  viewer role with the saved job ID as ExternalId. Participants receive only the
  viewer credentials, with the permissions defined by the problem template.
  The host requests one-hour credentials and returns the actual STS expiry for CLI
  credentials. Credentials stay in browser memory and disappear when cleared or
  the page reloads. Console sign-in uses the fixed AWS federation endpoint and
  the region's console home page. This flow supports commercial AWS accounts.
- **Access gates.** Before and after AWS calls, the host checks team membership,
  event start, lock, end and expiry, and whether the environment is running.
  Rotating a team key or starting an environment operation blocks a pending
  request. Ending the event blocks new credentials and console links. Sessions
  already issued remain valid until AWS expires or revokes them.

The access checks and built portal flows are covered by local HTTP, SQLite and
Chromium tests with STS and federation mocks. A real AWS rehearsal requires
separate approval and is optional for development completion.

The container image accepts the same flag. Give it credentials through the
platform's role or environment variables.

## Hosting behind a TLS proxy

The same host runs as one container image on a VM or container platform. A
TLS-terminating proxy publishes the host console and the participant portal at two
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
  loopback is unreachable, and the log would carry the host key.
- **The proxy must pass the original Host header.** Caddy does this by default.
  nginx needs `proxy_set_header Host $host`. A request with another Host is refused
  with `Untrusted Host header. Expected <host>.`
- **Rate limiting behind the proxy.** `--behind-proxy` rate-limits failed logins by
  the last `X-Forwarded-For` entry, which is the one the proxy appended. Without the
  flag, every request would appear to come from the proxy, so one client's failures
  would lock out everyone. Use the flag only when the proxy sets that header.
- **HTTPS only.** Public origins must be `https:`. `--unsafe-http` exists for local
  smoke tests only.
- **The host login key.** It is not printed, because platforms retain container
  logs. Read it with `docker exec <container> cat /data/host-key`. The database and
  the key live in the `/data` volume, so use a platform that provides a persistent
  volume.
- **Health checks.** `GET /healthz` answers on either port whatever the Host header,
  and returns only a status.
- **Supported problems.** Docker Compose problems are not offered. Their sibling
  containers publish on the host's loopback, which the container cannot reach. The
  Cryptography Battle runs in-process and is offered, and so is `hello-world` with
  `--aws-region`. To use Docker problems on a VM, run `make host` directly on that VM.

`bun run test:host:container` runs a built image, logs in, and plays a started
Cryptography Battle for two teams at the advertised origins.

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
through browser metadata. Only reviewed SQL metadata and the Battle portal are included in
hosting catalog/plugin globs, plus the public `hello-world` catalog entry; server reducers, fixtures and private seeds are excluded. Participant instructions are returned by the
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
organizer creates the first Admin with the host key, signs in again with the
Admin password, then creates a two-team
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
