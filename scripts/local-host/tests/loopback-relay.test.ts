import { expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { LoopbackRelays, relayCompose } from "../container/loopback-relay";
import { type RelayTarget, resolveRelayTarget } from "../container/relay-target";
import { allocateNetworkSubnets } from "../docker-networks";
import {
  egressComposeSource,
  isolatedCompose,
  localNetworkPlan,
  requiredNetworkValue,
  segmentGateway,
} from "../local-network";

const binding = { service: "web", hostPort: 18080, port: 8080, networks: ["default"] };
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function client(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}
test("internal transport removes only internal service ports and keeps all resource and network policy", () => {
  const result = relayCompose(`services:
  web:
    ports: ["127.0.0.1:18080:8080"]
    mem_limit: 128m
    cpus: 0.5
    pids_limit: 128
  ordinary:
    networks: [outbound]
    ports: ["127.0.0.1:19080:8080"]
networks:
  default: {internal: true}
  outbound: {}
`);
  expect(result.bindings).toEqual([binding]);
  expect(result.text).toContain("internal: true");
  expect(result.text).toContain("mem_limit: 128m");
  expect(result.text).toContain("pids_limit: 128");
  expect(result.text).toContain("cpus: 0.5");
  expect(result.text).toContain("127.0.0.1:19080:8080");
  expect(result.text).not.toContain("127.0.0.1:18080:8080");
  const ordinary = 'services: {web: {ports: ["127.0.0.1:18080:8080"]}}';
  expect(relayCompose(ordinary)).toEqual({ text: ordinary, bindings: [] });
});
test("TCP relay preserves opaque bytes, revalidates before connection and revokes active sockets", async () => {
  const peers = new Set<Socket>();
  const echo = createServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.pipe(socket);
  });
  const port = await listen(echo);
  const hostPort = await freePort();
  let inspections = 0;
  let current = true;
  const target = { host: "127.0.0.1", port, identity: "owned-generation" };
  const relay = new LoopbackRelays(
    [{ ...binding, hostPort }],
    async (_, expected) => {
      inspections++;
      if (expected) expect(expected).toEqual(target);
      return target;
    },
    () => current,
    () => {
      throw new Error("Unexpected relay failure");
    },
  );
  let socket: Socket | undefined;
  try {
    await relay.listen();
    socket = await client(hostPort);
    const payload = Buffer.from([0x16, 0x03, 0x03, 0x00, 0xff, 0x80]);
    const received = new Promise<Buffer>((resolve) => socket?.once("data", resolve));
    socket.write(payload);
    expect(await received).toEqual(payload);
    expect(inspections).toBe(2);
    current = false;
    const closed = new Promise<void>((resolve) => socket?.once("close", () => resolve()));
    await relay.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  } finally {
    socket?.destroy();
    await relay.close();
    for (const peer of peers) peer.destroy();
    await close(echo);
  }
});
test("revocation while inventory is pending never forwards bytes or resurrects a listener", async () => {
  const hostPort = await freePort();
  let unblock: ((value: RelayTarget) => void) | undefined;
  let accepted: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let calls = 0;
  const target = { host: "127.0.0.1", port: 9, identity: "old" };
  const relay = new LoopbackRelays(
    [{ ...binding, hostPort }],
    async () => {
      if (++calls === 1) return target;
      accepted?.();
      return new Promise<RelayTarget>((resolve) => {
        unblock = resolve;
      });
    },
    () => true,
    () => undefined,
  );
  await relay.listen();
  const socket = await client(hostPort);
  socket.write("secret");
  await pending;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await relay.close();
  unblock?.(target);
  await closed;
  expect(socket.destroyed).toBe(true);
  const replacement = createServer();
  await new Promise<void>((resolve) => replacement.listen(hostPort, "127.0.0.1", resolve));
  await close(replacement);
});

function inventory() {
  const id = "a".repeat(64);
  const networkId = "b".repeat(64);
  const network = {
    Name: "tch-job_default",
    Id: networkId,
    Internal: true,
    Driver: "bridge",
    Labels: { "com.docker.compose.project": "tch-job" },
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic inventory only; no connection to these addresses
    IPAM: { Config: [{ Subnet: "10.248.0.0/28", Gateway: "10.248.0.1" }] },
  };
  const container = {
    Id: id,
    State: { Running: true },
    Config: {
      Labels: {
        "com.docker.compose.project": "tch-job",
        "com.docker.compose.service": "web",
      },
    },
    HostConfig: { Privileged: false, NetworkMode: "tch-job_default", CapAdd: [] },
    NetworkSettings: {
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic inventory only; no connection to these addresses
      Networks: { "tch-job_default": { NetworkID: networkId, IPAddress: "10.248.0.2" } },
    },
  };
  const route = { dev: `br-${networkId.slice(0, 12)}` };
  const io = {
    daemon: () => "daemon-start-1",
    verify: () => undefined,
    run: (command: string, args: readonly string[]) => {
      if (command === "ip") return JSON.stringify([route]);
      if (args[0] === "ps") return id;
      if (args[0] === "network") return JSON.stringify([network]);
      return JSON.stringify([container]);
    },
  };
  return { io, container, network, route };
}
test("resolver pins concrete daemon/container/network identity and rejects recreation", () => {
  const fixture = inventory();
  const request = { project: "tch-job", binding };
  const target = resolveRelayTarget(request, undefined, fixture.io);
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic inventory only; no connection to these addresses
  expect(target.host).toBe("10.248.0.2");
  expect(resolveRelayTarget(request, target, fixture.io)).toEqual(target);
  fixture.io.daemon = () => "daemon-start-2";
  expect(() => resolveRelayTarget(request, target, fixture.io)).toThrow("generation changed");
});
for (const mutation of [
  "external",
  "route",
  "address",
  "gateway",
  "stopped",
  "network-id",
] as const) {
  test(`resolver rejects ${mutation} drift`, () => {
    const fixture = inventory();
    if (mutation === "external") fixture.network.Internal = false;
    if (mutation === "route") fixture.route.dev = "eth0";
    if (mutation === "address")
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic inventory only; no connection to these addresses
      fixture.container.NetworkSettings.Networks["tch-job_default"].IPAddress = "192.168.1.1";
    if (mutation === "gateway")
      // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic inventory only; no connection to these addresses
      fixture.container.NetworkSettings.Networks["tch-job_default"].IPAddress = "10.248.0.1";
    if (mutation === "stopped") fixture.container.State.Running = false;
    if (mutation === "network-id")
      fixture.container.NetworkSettings.Networks["tch-job_default"].NetworkID = "c".repeat(64);
    expect(() =>
      resolveRelayTarget({ project: "tch-job", binding }, undefined, fixture.io),
    ).toThrow();
  });
}

test("a failed second listener releases the first owned port", async () => {
  const occupied = createServer();
  const occupiedPort = await listen(occupied);
  const hostPort = await freePort();
  const relay = new LoopbackRelays(
    [
      { ...binding, hostPort },
      { ...binding, hostPort: occupiedPort },
    ],
    async () => ({ host: "127.0.0.1", port: 9, identity: "owned" }),
    () => true,
    () => undefined,
  );
  try {
    await expect(relay.listen()).rejects.toThrow();
    const replacement = createServer();
    await new Promise<void>((resolve) => replacement.listen(hostPort, "127.0.0.1", resolve));
    await close(replacement);
  } finally {
    await relay.close();
    await close(occupied);
  }
});
test("identity drift closes pending and established connections together", async () => {
  const peers = new Set<Socket>();
  const echo = createServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.pipe(socket);
  });
  const port = await listen(echo);
  const hostPort = await freePort();
  let drift = false;
  let failure: unknown;
  const relay = new LoopbackRelays(
    [{ ...binding, hostPort }],
    async () => {
      if (drift) throw new Error("generation changed");
      return { host: "127.0.0.1", port, identity: "owned" };
    },
    () => true,
    (error) => {
      failure = error;
    },
  );
  let first: Socket | undefined;
  let second: Socket | undefined;
  try {
    await relay.listen();
    first = await client(hostPort);
    const received = new Promise<Buffer>((resolve) => first?.once("data", resolve));
    first.write("before");
    expect(String(await received)).toBe("before");
    const closed = new Promise<void>((resolve) => first?.once("close", () => resolve()));
    drift = true;
    second = await client(hostPort);
    await closed;
    expect(String(failure)).toContain("generation changed");
  } finally {
    first?.destroy();
    second?.destroy();
    await relay.close();
    for (const peer of peers) peer.destroy();
    await close(echo);
  }
});

/* eslint-disable sonarjs/no-hardcoded-ip -- Pure transport inventory; synthetic addresses never contacted. */
test("egress-attached services keep verified internal scoring and authentication relays", () => {
  const text = 'services: {web: {image: synthetic, ports: ["127.0.0.1:18080:8080"]}}';
  const request = {
    id: "upstream",
    service: "web",
    destination: "8.8.8.8",
    port: 443,
    purpose: "Synthetic",
  };
  const authored = egressComposeSource(text, ["web"]);
  const plan = localNetworkPlan("tch-job", allocateNetworkSubnets(authored, "10.248.0.0/24", []), {
    composeText: authored,
    definition: "pinned",
    egress: [request],
  });
  const compose = relayCompose(isolatedCompose(text, plan), plan);
  expect(compose.text).not.toContain("127.0.0.1:18080:8080");
  expect(compose.bindings).toHaveLength(1);
  const binding = requiredNetworkValue(compose.bindings[0]);
  expect(binding.networks).toHaveLength(2);
  const f = inventory();
  const egress = requiredNetworkValue(plan.egressSegments[0]);
  const networkId = "c".repeat(64);
  const egressNetwork = {
    ...f.network,
    Id: networkId,
    Name: `${plan.project}_${egress.name}`,
    Internal: false,
    Options: { "com.docker.network.bridge.name": egress.bridge },
    IPAM: { Config: [{ Subnet: egress.ipv4, Gateway: segmentGateway(egress, false) }] },
  };
  const attachments: Record<string, { NetworkID: string; IPAddress: string }> =
    f.container.NetworkSettings.Networks;
  attachments[egressNetwork.Name] = {
    NetworkID: networkId,
    IPAddress: egress.ipv4.replace(".16/28", ".18"),
  };
  const originalRun = f.io.run;
  f.io.run = (command, args) => {
    if (command === "docker" && args[0] === "network")
      return JSON.stringify([f.network, egressNetwork]);
    if (command === "ip" && args.includes(attachments[egressNetwork.Name]?.IPAddress ?? ""))
      return JSON.stringify([{ dev: egress.bridge }]);
    return originalRun(command, args);
  };
  const target = resolveRelayTarget({ project: plan.project, binding, plan }, undefined, f.io);
  expect(target.host).toBe("10.248.0.2");
  expect(target.identity).toContain(networkId);
});
/* eslint-enable sonarjs/no-hardcoded-ip */
