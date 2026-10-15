# Dedicated Linux VPN ingress

This opt-in adapter connects preconfigured WireGuard peers to the existing isolated
competition runtime. It does not create keys, interfaces, host routes, forwarding
settings, kernel modules, DNS records or router port forwarding. Normal local
hosting remains available without VPN configuration. Sealed policy preparation installs
only exact peer `/32` and `/128` reply routes inside verified workload network
namespaces, via their owned bridge gateway. It rejects ambiguous multi-network
attachments; it never adds a host/default route or SNAT.

## Authorization

An administrator-owned public registration file maps every peer public key to one
event, team, IPv4 `/32` and IPv6 `/128`. Extra peers, broader cryptokey routes,
duplicate addresses, private-key fields and a changed server public key are rejected.
The file must be a root-owned regular file, without group/other writes. The server
interface must have exactly the registered server `/32` and `/128` addresses.

The dedicated participant listener and job gateways bind to the registered server
IPv4 address. Administration stays on loopback. Participant API credentials,
WebSocket tickets and gateway sessions are checked against the real socket peer;
forwarded headers cannot establish identity. WebSocket admission is checked again
by the existing 500 ms authorization loop. Workload forwarding supports both IP
families; the web listeners currently use the server IPv4 address.

VPN INPUT/FORWARD traffic starts closed. Admission permits registered participant
portal traffic, that team's current job gateway and its private workload networks.
Another team is reachable only at a currently published same-event TCP service's
exact address and port. Original conntrack destinations, interface directions,
peer identities and publisher/requester proof lifetimes are bound to the grant.
Home LAN, arbitrary host ports, administration, Internet forwarding and peer
private networks have no admission rule. Non-WireGuard packets claiming a peer
source address are dropped before host admission.

A successful packet suspension retains the existing, unexpired peer identity proof; each terminal still validates its own runtime. Periodic preparation therefore does not revoke healthy terminals. Failure of the current preparation, commit or seal invalidates peer identity admission.

Kernel sets contain expiring grants. Their absolute deadline is bounded by the
oldest relevant workload and interface proof, with time reserved for the native
command deadline. A delayed application cannot renew an old proof. A crash can
leave an existing grant until its finite expiry, at most sixty seconds from the
last proof. Emergency seal drops close admission immediately during a controller
lifecycle operation; if a seal command fails, existing bridge quarantine, owned
workload shutdown and durable failure retention still proceed.

Heavy native preparation runs in the existing bounded network worker pool. A
controller has one active preparation and one latest desired snapshot. Workers
cannot remove the seal. Main opens ingress only after current-epoch preparation;
superseded snapshots cannot reopen it.

## Operator-installed boot ordering

The supplied files in `docker/host/vpn/` are reviewable installation inputs, not an
automatic installer. They have not been installed by the implementation task.
The dedicated VM must already provide native rootful Docker 28.4.x, Bun 1.3.11,
WireGuard tools, iptables/ip6tables, ipset and preloaded required kernel features.
No module is loaded automatically. The existing Docker guard checks daemon and
network-namespace ownership. IPv4 and IPv6 firewall backends must match.

For the supplied `tcwg0` profile, the WireGuard service requires the boot seal unit
before activation. The controller service follows and binds to WireGuard, with a
post-stop seal and retained private SQLite state. Its public environment file
contains `TENKACLOUD_VPN_DOCKER_POOL`, an unused private pool. The public peer JSON
uses `version`, `interface`, `serverPublicKey`, `serverIpv4`, `serverIpv6`,
`participantPort` (5175 for this service profile), and `peers` containing
`publicKey`, `eventId`, `teamId`, `ipv4`, `ipv6`. No private keys belong in either
file. Application interfaces must be built before using the `--no-build` service.

At runtime `--vpn-peers /etc/tenkacloud/vpn/tcwg0.json` requires
`--competition-network` and an explicit Docker pool. It cannot be combined with
LAN or public-origin exposure. Boot dependency/order and active seal service are
read and checked automatically. A failed preflight reports its cause; there is no
checkbox or unrestricted fallback.

## Evidence and remaining validation

Pure policy, native-command model, HTTP/WebSocket and lifecycle regressions are
separate evidence classes. A command model is not an encrypted-packet or boot
acceptance test. This implementation has not changed real VPN/firewall/systemd
settings, generated keys, or established a real peer connection.

Before real acceptance, use a dedicated disposable VM with its own kernel. The
current cloud workspace lacks WireGuard and several required set-match modules;
loading them into the shared execution host is outside the task's authorization.
The acceptance scope must name the VM, root/network permissions, temporary
interfaces and routes, ephemeral test keys, service files, reboot operations and
cleanup. Test own-team traffic, exact public DMZ and withdrawal, peer-private and
organizer host/LAN/admin denial, stale proofs, controller crash, WireGuard restart
and cold boot. Keep the sixty-second crash expiry distinct from the boot seal.

## Current-main integration checkpoint

The local integration branch starts at main `3e091e19` and reuses the retained
network and VPN implementation. It preserves the downloaded catalog's lazy load,
saved definitions and digest checks, as well as the merged hint and problem-picker
changes. It excludes the held cgroup initializer and adds the separately approved
manual-only native VM acceptance workflow.

A command-model regression reproduced two unsafe assumptions: an ACCEPT rule with
a quarantine-looking comment could precede the emergency seal, and preparation
could treat that comment as evidence of a closed prefix. Closure classification
now requires the exact owned interface/bridge DROP rule shape. No kernel rules
were changed to reproduce or fix this. The independent source review also caught
the retained fix for unrelated expired runtimes blocking hints/submissions; that
backend fix and its regressions are included without importing the old UI.

These checks do not prove encrypted peer traffic, household LAN denial, cold boot
or six-team competition acceptance. The workspace's visible cgroup reports a
domain, but that is not evidence of a separately delegated inner-Docker domain.
WireGuard, the hash-ip/set match modules, `wg` and `ipset` are not available here.
Nothing in this checkpoint loads modules or repairs the shared hierarchy.

The user approved one standard GitHub-hosted Ubuntu 24.04 disposable VM for a
manual-only acceptance run, limited to sixty minutes and US$0 additional compute.
The workflow uses temporary WireGuard keys, six owned peers, routing and exact
owned firewall rules to check team isolation and simulated household LAN denial.
It uses no production credentials, externally exposed ports, personal computer
or household router. Cleanup removes owned resources and temporary keys before
the job's VM is discarded. Cold boot and actual household LAN/Internet acceptance
remain outside this run and must not be inferred from its result.

The current shared workspace successfully started a minimal capped Docker
container; the historical nested-Docker cgroup failure is not a current blocker.
Real VPN setup remains restricted to the approved disposable VM. The manual
workflow and its setup/harness are preparation until an actual run succeeds.
