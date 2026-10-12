# CTFd integration

CTFd displays challenges, authenticates participants and records flag attempts,
solves and scores. Its TenkaCloud challenge type starts and stops the participant's
existing on-demand Docker environment through TenkaCloud's participant API.
The plugin runs inside CTFd and uses its existing `Challenges.connection_info`
column for the TenkaCloud problem ID. It adds no server, database, table, machine
principal or stored credential.

## Install

Validated with CTFd 3.8.2. Copy the `tenkacloud` directory beside CTFd's existing
plugins and restart CTFd. CTFd already provides Flask, SQLAlchemy and requests.
Set the non-secret `TENKACLOUD_PARTICIPANT_URL` environment variable on the CTFd
process to the participant API base: the `Participant portal` origin that the host
prints at startup plus `/api`, which is `http://127.0.0.1:5175/api` with the default
`make local` ports.
The local host listener requires the `/api` suffix. Run CTFd on the same machine
and use the private loopback listener. Remote endpoints are rejected.
Only the operator controls this URL; participants cannot select an
upstream, team ID, event ID, job ID or arbitrary API route.
Set the non-secret `TENKACLOUD_EVENT_ID` to the intended event's ID. A valid key
from another event is rejected even when that event assigns the same problem.

Create a new local event with `scoringAuthority: "ctfd"` (the event creation
checkbox). This fixed choice accepts only single-verdict Docker exercises.
Do not publish the TenkaCloud participant listener through a proxy or tunnel.
Evaluation requires a private loopback bind, an actual loopback socket peer,
no advertised/proxy listener configuration and no forwarding headers.
The CTFd process must share the host loopback network namespace; bridged
CTFd containers and remote CTFd processes are not supported by this mode.
This mode does not configure public hosting for CTFd or exercise gateways.
Keeping the control API private prevents contestants calling the verifier directly
to bypass CTFd attempt limits. The host operator is trusted; do not run contestant
shells on the host. Remote CTFd requires a separately approved server identity.

Existing events and omitted settings retain native scoring and cannot use
`evaluate`; CTFd-scored events reject native submissions and hint purchases
before runtime calls or receipt reuse. Configure prerequisites in CTFd; host
progression gates cannot be configured for these events.

Use the TenkaCloud organizer console to create an event with the desired Docker
problems and teams, prepare its environments and start the event. Give each
CTFd team its corresponding existing TenkaCloud team login key. No automatic
registration or persistent identity mapping is introduced. Possession of that
key remains the existing TenkaCloud authorization boundary; CTFd login alone
does not grant TenkaCloud access.

Create a **TenkaCloud (on-demand Docker)** challenge in CTFd. Set its TenkaCloud
problem ID, participant instructions and points. For a single-flag Docker
exercise, leave CTFd flags empty to use its existing container verifier. To use
CTFd's own static or regex flag rules instead, configure flags on the challenge.
Publish it after
both systems are ready. Participants enter their team key in the challenge
dialog, start the environment, open its Web link, submit their flag in CTFd and
stop the environment. Polling exposes asynchronous completion and failure.
Each dialog reads only its own problem (`GET /portal/me/problems/{problemId}`),
so it issues an exercise link for that environment alone. Start, stop and flag
checks read `GET /portal/me/problems/{problemId}/state`, which issues no link. If the environment
runs but TenkaCloud cannot issue its link, the dialog says so and retries every
5 seconds instead of showing it as ready; flag submission still works.
Closing the dialog clears the key and stops polling. Keys are not saved in
cookies, browser storage, CTFd configuration or a credential table.

Stopping uses the existing non-destructive participant operation: containers
and their data are retained for restart. The organizer ends the TenkaCloud event
and removes its owned environments using TenkaCloud's existing teardown.
Deleting a CTFd challenge never implicitly deletes Docker or cloud resources.

## Boundaries

- CTFd owns scoring. The authenticated `/portal/me/problems/{problemId}/evaluate`
  route returns the running single-flag Docker verifier's boolean verdict and
  never writes host scores, snapshots, receipts or progress. This supports the
  existing per-team generated flag. CTFd stores attempts, solves and configured
  points. Transport failures do not become wrong submissions or consume the
  UI's maximum-attempt count. CTFd's request-rate protections still apply.
  Multiple checkpoints and shared Battles are not converted into CTFd scoring.
- Participant-driven start/stop is supported for existing on-demand Docker
  jobs. AWS provisioning and teardown are organizer operations today and are
  not exposed by this plugin. No new cloud or administrator credential is
  configured. Those additional capabilities need a separately reviewed,
  scoped contract and explicit approval before new secrets or persistent
  access are introduced.
- CTFd visibility, prerequisites, account verification, team membership,
  event time, pause and CSRF checks precede upstream access. TenkaCloud still
  checks its own key, event, team ownership, progression and resource limits.
- Upstream redirects and environment proxies are disabled. Errors do not
  forward raw upstream bodies, exception text or secrets. Responses contain
  only environment status and that problem's HTTP(S) exercise links.
- TenkaCloud limits invalid credentials by remote address. CTFd requests share
  a source address; repeated wrong keys can temporarily rate-limit that source.
  The plugin does not bypass that protection. Do not log request bodies at a proxy.

## Verification

The official challenge type contract is documented in
[CTFd's plugin guide](https://docs.ctfd.io/docs/plugins/challenge-types/).
Tests use its real Flask application and isolated data, plus the production
TenkaCloud HTTP/SQLite/Docker engine and a public fixed-flag exercise owned by
this repository. They never use customer data, existing host state or AWS.

For an isolated development copy, obtain official CTFd 3.8.2 commit
`d6fc367187fc49134cfffe89fd1523162d29836a`, place an unversioned runtime copy at
`.cache/ctfd/run`, install its requirements in `.cache/ctfd/venv` using Python
3.11, and copy this plugin to `.cache/ctfd/run/CTFd/plugins/tenkacloud`.

```sh
SECRET_KEY=ephemeral-test-key PYTHONPATH="$PWD/.cache/ctfd/run" \
  .cache/ctfd/venv/bin/python -m unittest discover -s integrations/ctfd/tests -v
bun run test:ctfd:e2e
```

The browser rehearsal needs Docker, Chrome and free ports 5197–5199 and
5200–5239. Set `HOST_E2E_CHROMIUM` to a Chromium executable if necessary.
It uses the existing compact test network pool `10.240.0.0/16`, checking occupied
subnets before allocating. `HOST_DOCKER_NETWORK_POOL` can choose another pool;
unrelated Docker networks are never pruned.
`CTFD_ROOT` and `CTFD_PYTHON` can select another isolated CTFd runtime copy.
Set `CTFD_E2E_PROBLEM_ID=sqli-demo` to exercise the pinned catalog's generated
flag, or `CTFD_E2E_THEME=core-deprecated` to check the legacy CTFd theme.
Masked screenshots and a machine-readable result are saved in
`.tenkacloud/ctfd-e2e/`. The rehearsal checks display, invalid keys, actual
Docker startup, incorrect/correct flags, CTFd's score, non-duplication in
TenkaCloud, stop, dialog key clearing, two independent environments and final
organizer teardown.
