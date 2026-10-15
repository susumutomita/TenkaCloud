# Console-only competition appliance

This optional native Linux mode reuses participant authentication, the Terminal Broker and the competition network guard. Participants enter through an operator-managed HTTPS console. Terminal opens only the pinned `participant` build target of their own team's attack container. Published HTTP applications use a separate origin for each publisher job and service.

```sh
bun run scripts/local-host/main.ts --competition-network \
  --docker-network-pool 10.240.0.0/16 \
  --console-origin https://play.example.test \
  --web-origin-template 'https://{target}.labs.example.test' \
  --web-services web --behind-proxy
```

Choose an unused network pool after inspecting the VM's routes. The console and Web namespace must be separate. This mode cannot be combined with the existing two-origin public mode, LAN mode or VPN peer routing mode.

Configure the trusted TLS reverse proxy separately: the console origin reaches only `127.0.0.1:5175`, with WebSocket forwarding for Terminal; the wildcard challenge namespace reaches only `127.0.0.1:5176`. Preserve the original Host and Origin. These listeners and administration on `127.0.0.1:5174` bind loopback. Do not expose administration, Docker, SSH, verifier ports or gateway ports. Configure Tailscale solely as ingress to these HTTPS origins; do not advertise container, LAN or home-network subnet routes or an exit node. This implementation does not install, authenticate or change Tailscale or VM networking.

Explicitly acquire the reference catalog in `packs/console-team-lab` using the normal catalog source configuration with a reviewed full commit and `subdir: "packs/console-team-lab"`. It is not included in default sources. Each team receives sibling attack, Web, private SQLite and verifier containers. The attack image uses Debian Bookworm with common security tools; it is not a Kali Linux image. It fixes its base digest and signed package snapshot; record the resulting OCI digest and tool version manifest before deployment. The tools include curl, nmap, netcat, Python and sqlmap; nmap uses TCP connect scans without extra capabilities. Workloads are read-only, bounded and unprivileged, with no Docker socket or host network.

Only declared, currently published services marked `applicationProtocol: "http"` and enabled by `--web-services` receive browser access. The authenticated console sends team/problem/service IDs, never URLs. Handoff tickets are single-use, host-bound and expire after 30 seconds. The challenge uses a Secure, HttpOnly, host-only Cookie for 15-minute access. Every request rechecks event access, team keys, current publication and both runtime generations. Logout revokes that team's tickets and sessions when its request reaches the host; an offline logout cannot confirm remote revocation.

The Web Broker pins a verified literal container IP and port, bypasses environment HTTP proxies, limits request/response sizes and deadlines, strips console credentials, rejects external redirects and requires same-origin mutations. It supports HTTP applications, without WebSocket or CONNECT forwarding. Browser CSP limits subresources and forms to the application origin. Terminal WebSockets retain their existing separate broker.

The network guard permits a team's own runtime and explicitly published same-event services; other-team private services, management, host/LAN and Internet destinations remain denied by default. Internet allowlists are not implemented. Publication grants access to the application: a vulnerable published application can expose its own data, so do not claim that network isolation prevents application-level disclosure or an application proxying its own private services.

Host tests exercise HTTP, SQLite, identity changes, publication revocation and catalog acquisition. They do not establish native packet filtering or actual Kali/ARM64 compatibility. A native rootful Docker 28.4.x runner is required by the current guard. Before appliance use, build the image on the intended architecture and verify two real teams' terminal access, shared Web, private DB denial, management/LAN/Mac/Internet denial and cleanup. Kali, ARM64, TLS/DNS, Tailscale ingress and native packet acceptance remain unverified unless separately recorded from that machine.
