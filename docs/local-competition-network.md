# Local competition network (experimental)

Issue [#3383](https://github.com/susumutomita/TenkaCloud/issues/3383#issuecomment-6156901569)
adds an opt-in native Linux adapter behind the existing `CompetitionEngine` /
`RuntimeEngine` lifecycle. The existing local mode remains available. An environment
planned with isolation retains that requirement in its private SQLite event and jobs,
including dormant jobs without a `Job.unit`,
even when a later controller omits the option. An existing unguarded environment
cannot be adopted as isolated.

## Entry and prerequisites

The entry remains `make local`. On an organizer-controlled dedicated Linux VM,
the explicit options are:

```sh
make local LOCAL_ARGS="--competition-network --docker-network-pool <unused-private-/16-to-/24>"
```

The controller must already have access to rootful native Docker Engine **28.4.x**,
the root-owned canonical `/var/run/docker.sock`, the daemon's network namespace,
`iptables`, `ip6tables`, their restore commands, `ip` with JSON output, and `nsenter`.
Both bridge netfilter families must already be enabled, and the Docker
`DOCKER-USER` hook must lead IPv4 forwarding. The controller needs firewall and
network-namespace privileges. It does not run sudo, enable sysctls, load modules,
configure Docker, install tools, or change host authentication. Unsupported or
unverifiable configurations refuse workload admission. There is no unrestricted
fallback. Desktop Docker, rootless Docker, remote daemons, other UNIX sockets and
public-origin hosting are unsupported for this adapter.

Choose an unused pool that does not overlap host, LAN or VPN routes. The existing
allocator reserves compact IPv4 segments; the controller also checks its generated
IPv6 ranges against the actual route inventory. It installs owned rules before
creating workload bridges. Generated networks are internal, dual stack and retain
separate declared service attachments. Autonomous container restart is disabled;
recovery verifies the persisted plan and actual ownership before granting access.

The adapter changes only its own `TCI_*` chains, their admission hooks,
owner-marked emergency DROP rules at INPUT and FORWARD head, owned
bridges, and bounded routes inside owned workload namespaces. Teardown removes its
own resources after Compose cleanup. Cleanup errors retain ownership and address
reservations; they do not report success or silently drop the ledger.

## Team private network and competition DMZ

Web, DB and terminal services can communicate within the same runtime's declared
private segments. A runtime cannot initiate host or other-team private traffic.
IPv4 and IPv6 forwarding use trusted ingress/egress bridges and original
conntrack destinations, including explicit host gateway denial before accepts. INPUT also rejects
bridge-gateway source addresses before permitting replies or neighbor discovery,
so it does not rely on guest source addresses as a host identity.
Docker internal networks alone do not provide host isolation, and UFW alone is
not the Docker admission control used here.

A catalog can declare up to eight dedicated TCP publications. Each public
service must attach to exactly one private network; multi-network publications
are refused before advertisement because a single reverse route cannot serve
every source address:

```json
{
  "runtime": {
    "publicServices": [
      { "id": "web-demo", "service": "publicweb", "port": 8080, "purpose": "Team demo Web" }
    ]
  }
}
```

This is a host-side metadata contract. The pinned catalog schema does not yet
admit `publicServices`; existing packaged challenges do not gain publication
automatically. Synthetic metadata tests exercise the contract. An independent
catalog schema and dedicated-service update is still required. Catalog
distribution remains separate work. The dedicated service must exist in the pinned Compose
edition and must be separate from the terminal and verifier services. Participants
publish or withdraw a declared ID from their authenticated problem panel. They
cannot submit an address, port, route, team, job, shell command or runtime target.
The protected endpoint is `/api/portal/me/problems/{problemId}/network`: GET
returns declared IDs and shared tuples; POST accepts exactly `serviceId` and
`published`. It rejects query selectors and rechecks event/team/progression state.
The controller resolves current owned container endpoints and grants only their
exact TCP tuple to other isolated runtimes in the same event. Private DBs and
admin terminals remain inaccessible through direct cross-team connections. A
published application can serve its own team data; packet rules do not provide
application-level secrecy or content filtering. Publication is competition-internal; it
creates no host listener or Internet publication. Addresses shown in the panel
are used from the team terminal, not as browser links on the participant's laptop.

Publication plans use the existing private SQLite ledger and event authorization.
Updates serialize across runtimes. A partial update failure revokes runtime
access, quarantines every affected runtime at the actual INPUT/FORWARD head in
both families independently of Docker admission hooks, attempts to stop every
affected workload, and restores private-only rules
only after confirming workloads stopped. Failures are surfaced and ownership is
retained. Rule verification checks order as well as membership. Guard-induced
stops persist STOPPED or FAILED in the existing job ledger. Initial startup
failures also quarantine before teardown. Ordinary admission preserves quarantine;
final cleanup removes and verifies its owner-marked DROP rules only after owned
containers and bridges are absent. Cold recovery rejects a retained IP that no longer belongs to the
recorded service identity. Stopping or retiring a runtime withdraws its DMZ rules.
Changing the persisted unit invalidates existing terminal generations; reconnect
with a fresh ticket after publication changes.

Internet egress remains denied. Catalog-declared external exceptions and organizer
confirmation are **not implemented** in this PR. No declaration opens arbitrary
Internet access. Protected host/LAN/management destinations remain outside the
allowed competition tuples. Building organizer-selected catalog images is a
trusted preparation operation on the Docker daemon and is not a sandbox for
untrusted Dockerfiles; this adapter's packet guarantees apply to admitted running
workloads. Do not use it to build competitor-supplied images.

## Terminal and connection scope

The existing terminal keeps a server-fixed service and `/bin/sh`, 30-second
single-use tickets, event/team/job/generation revalidation and revocation. The
network API is runtime independent. Terminal sessions remain pipe based;
PTY, resize, xterm, remote handoff and simulator integration are follow-up work.

Default `make local` listeners remain loopback. The existing explicit LAN option
accepts private RFC 1918 addresses and requires the existing unsafe-LAN acknowledgement;
Tailscale `100.64.0.0/10` is rejected. Public origins continue to disable Compose.
This PR does not add a remote-access authentication bypass or deploy a tunnel.
A future encrypted connection adapter must preserve these authorization contracts.

Container root is included in the workload network boundary: changing guest
routes does not change host-owned firewall rules. VM administrator compromise,
container escape and Docker/kernel vulnerabilities are a separate boundary.
This experimental adapter does not guarantee safe general public hosting or
prevent container escape. Use an organizer-owned disposable VM for rehearsal.

## Verification evidence and remaining limits

Development and physical testing used only the authorized cloud environment.
The disposable privileged lab had `network:none`, no host bind mounts and no
outer exposed ports. Rules, bridges, fixture listeners and namespace routes were
created inside that lab; no shared host firewall, sysctl, module or cgroup was
changed.

- Before: actual `internal:true` fixtures reached a synthetic host TCP listener
  over IPv4 and IPv6.
- After: six current native guard fixture networks retained own-team DB communication, denied
  other-team private services and host TCP, allowed exact declared Web tuples,
  and denied the same tuples after withdrawal in both families.
- Gateway DNAT canaries remained denied in both families, while ordinary Web
  positive controls succeeded. The final kernel run also kept legitimate
  host-origin replies working in both families and verified the host listener
  positive control. Recorded results and tested source hashes are in
  [the kernel canary artifact](assets/local-network-kernel-canary.json).
- Emergency quarantine denied live own-DB traffic in both families even with
  a preceding IPv4 FORWARD ACCEPT. A broken Docker hook and recovery while
  workloads were running were refused; recovery after stopping restored own-DB
  communication. Ordinary installation retained live quarantine, and final teardown
  verified that no owned quarantine rule remained. The final run passed 53 packet canaries and cleaned its fixtures.
- Root-route canaries used controller-injected guest routes; the private peer
  service stayed unreachable. These are kernel component tests, not the bounded
  production adapter or authenticated six-terminal rehearsal.
- Pure tests cover owned plans, both-family atomic rules, extra/missing rules,
  misplaced hooks, partial-family failure, repeated cleanup, route overlap,
  generation binding, six independent identities and authenticated fixed-target
  publication requests, dormant requirement persistence, quarantine ordering and
  durable stopped/failed state. Portal tests cover publication requests, stale
  authentication results, refresh and errors. Existing terminal and scoring regression
  tests also run.
- The bounded production rehearsal source is
  [network-docker-smoke.ts](../scripts/local-host/tests/network-docker-smoke.ts).
  Its explicit entry is `bun run test:host:network` inside the approved lab.
  It keeps memory, CPU and PID limits and exercises six Compose runtimes,
  authenticated shell sessions, verifier submissions and controller recovery.
  In this cloud lab it failed during Compose creation because nested cgroup v2
  is in threaded mode: `cannot enter cgroupv2 ... with domain controllers`.
  Those end-to-end checks are **unmet**, not passed. Resource limits were not
  removed, and shared cgroups were not reconfigured to force a pass.
- DNS packet/proxy canaries, raw source/MAC spoofing, fragmentation, external
  exceptions, real LAN/Internet, browser rendering and VM/container escape have
  not been fully validated by this rehearsal. A failed lookup with no external
  route does not prove that Docker's embedded DNS proxy cannot forward queries.

The mandatory `ci` validates source and regressions; it does not perform privileged
VM firewall tests. The optional physical rehearsal must run only inside an
explicitly approved disposable lab with the prerequisites above. Experimental
scope and environmental limits must remain visible in the Draft PR.

Full native rule/endpoint audits run in a bounded worker pool, at most two at a
time, on a ten-second background cadence. Terminal reauthorization keeps its
existing 500 ms cadence and uses the exact admitted unit plus a recent proof;
a proof older than sixty seconds revokes admission immediately. Audit failure
revokes admission before asynchronous quarantine and label-validated shutdown.
Emergency quarantine uses an independent worker and the validated private
controller ledger, without requiring a responding Docker daemon. Same-job
recovery waits for pending revocation and reloads the retained unit.

Additional regression fixtures cover six authenticated HTTP/SQLite/WebSocket
sessions with fake shell transports during a delayed audit, peer-only
revocation, expired proofs, corrupted/missing Compose files, publication budget
preflight, and concurrent recovery versus revocation. These do not establish
six bounded production Docker sessions. The current isolated lab also rejects
a minimal memory/CPU/pids-limited container with cgroup invalid state. A provider
would need to supply an independently delegated cgroup v2 domain supporting
cpu, memory and pids; changing the shared hierarchy is outside this task's
approval. No resource limit was removed.

Revoked workloads whose quarantine or shutdown remains unconfirmed stay in a
retry set, including after in-memory admission is removed. Background sweeps
retry them; lifecycle operations follow replacement cleanup barriers and refuse
unconfirmed admission. SQLite failure cannot interrupt quarantine or shutdown.
Owner quarantine refuses proof and adoption; only verified stopped reset can
release it. Domain callers preserve the engine-confirmed STOPPED unit and reason.

The cgroup failure above is specific to this workspace's nested Docker, not a
cloud-wide limit. The existing GitHub Actions Local hosting rehearsal now adds a
normal Ubuntu VM test in an owned, disposable network:none Docker namespace,
with no host mounts or published ports. All twelve guest containers keep and
inspect 128 MiB memory, 0.5 CPU and 128 pids limits. The fixture tests six real
authenticated terminals and verifier scores, controller recovery, dual-stack
DMZ publication/withdrawal, private peer DB denial and owner cleanup. No host
sysctl/firewall/cgroup setting is changed. This CI extension is pending execution;
the blocked workspace attempt is not counted as a successful six-team test.
