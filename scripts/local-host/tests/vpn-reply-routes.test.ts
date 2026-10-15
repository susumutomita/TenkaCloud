/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic inventory only; no native networking. */
import { expect, test } from "bun:test";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan, requiredNetworkValue, segmentGateway } from "../local-network";

function fixture() {
  const plan = localNetworkPlan(
    "tch-vpnreply",
    { default: "10.240.0.0/28" },
    {
      composeText: "services:\n  web:\n    networks: [default]\n",
      definition: "reply-fixture",
      eventId: "event",
    },
  );
  const segment = requiredNetworkValue(plan.segments[0]);
  const ip6 = `${requiredNetworkValue(segment.ipv6.split("/")[0])}2`;
  const container = {
    Id: "abcdef123456",
    Config: {
      Labels: {
        "com.docker.compose.project": plan.project,
        "com.docker.compose.service": "web",
        "tenkacloud.isolation.owner": plan.owner,
        "tenkacloud.isolation.generation": plan.generation,
      },
    },
    HostConfig: { Privileged: false, CapAdd: [] },
    State: { Running: true, Pid: 42 },
    NetworkSettings: {
      SandboxKey: "/var/run/docker/netns/abcdef123456",
      Networks: {
        [`${plan.project}_default`]: { IPAddress: "10.240.0.2", GlobalIPv6Address: ip6 },
      },
    },
  };
  const mutations: string[][] = [];
  let verified = 0;
  let badReadback = false;
  function dockerInventory(args: readonly string[]): string {
    if (args[0] === "ps") return container.Id;
    if (args[0] === "inspect") return JSON.stringify([container]);
    if (args[0] === "network")
      return JSON.stringify([
        {
          IPAM: {
            Config: [
              { Subnet: segment.ipv4, Gateway: segmentGateway(segment, false) },
              { Subnet: segment.ipv6, Gateway: segmentGateway(segment, true) },
            ],
          },
        },
      ]);
    throw new Error("Unexpected Docker inventory");
  }
  function namespaceInventory(args: readonly string[]): string {
    if (args[1] === "readlink") return "net:[2]";
    const ipv6 = args.includes("-6");
    const gateway = segmentGateway(segment, ipv6);
    if (args.includes("replace")) {
      mutations.push([...args]);
      return "";
    }
    const address = args.at(-1);
    return JSON.stringify([
      {
        dev: badReadback && address !== gateway ? "eth9" : "eth0",
        ...(address === gateway ? { prefsrc: ipv6 ? ip6 : "10.240.0.2" } : { gateway }),
      },
    ]);
  }
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: () => {
      throw new Error("Unexpected read");
    },
    exists: () => true,
    link: (path) => (path === "/proc/self/ns/net" ? "net:[1]" : "net:[2]"),
    run: ({ command, args }) => {
      if (command === "docker") return dockerInventory(args);
      if (command === "ip")
        return JSON.stringify([
          {
            addr_info: [
              {
                family: "inet",
                prefixlen: 28,
                scope: "global",
                local: segmentGateway(segment, false),
              },
              {
                family: "inet6",
                prefixlen: 64,
                scope: "global",
                local: segmentGateway(segment, true),
              },
            ],
          },
        ]);
      if (command === "nsenter") return namespaceInventory(args);
      throw new Error(`Unexpected fake command ${command}`);
    },
  });
  guard.verifyNetworks = () => {
    verified++;
  };
  return {
    guard,
    plan,
    container,
    mutations,
    verified: () => verified,
    badReadback: () => {
      badReadback = true;
    },
  };
}
test("internal-only own peers receive exact dual-stack reply routes in their verified namespace", () => {
  const f = fixture();
  expect(f.plan.publicRoutes).toHaveLength(0);
  f.guard.routeVpnReplies(f.plan, ["10.251.240.2", "fd55:240::2"]);
  expect(f.verified()).toBe(1);
  expect(f.mutations).toHaveLength(2);
  for (const args of f.mutations) {
    expect(args[0]).toBe("--net=/var/run/docker/netns/abcdef123456");
    expect(args).not.toContain("default");
    expect(args).not.toContain("SNAT");
    expect(args).toContain("via");
    expect(args).toContain("eth0");
  }
  expect(f.mutations[0]).toContain("10.251.240.2/32");
  expect(f.mutations[1]).toContain("fd55:240::2/128");
});
test("changed owner, generation, project, service or namespace never mutates a route", () => {
  for (const key of [
    "tenkacloud.isolation.owner",
    "tenkacloud.isolation.generation",
    "com.docker.compose.project",
    "com.docker.compose.service",
  ] as const) {
    const f = fixture();
    f.container.Config.Labels[key] = "foreign";
    expect(() => f.guard.routeVpnReplies(f.plan, ["10.251.240.2"])).toThrow();
    expect(f.mutations).toHaveLength(0);
  }
  const f = fixture();
  f.container.NetworkSettings.SandboxKey = "/proc/self/ns/net";
  expect(() => f.guard.routeVpnReplies(f.plan, ["10.251.240.2"])).toThrow();
  expect(f.mutations).toHaveLength(0);
});
test("wrong route readback fails closed and invalid prefix input never mutates", () => {
  const f = fixture();
  f.badReadback();
  expect(() => f.guard.routeVpnReplies(f.plan, ["10.251.240.2"])).toThrow();
  const bad = fixture();
  expect(() => bad.guard.routeVpnReplies(bad.plan, ["0.0.0.0/0"])).toThrow();
  expect(bad.mutations).toHaveLength(0);
});

function workbenchFixture() {
  const plan = localNetworkPlan(
    "tch-vpnworkbench",
    { lab: "10.240.0.0/28", "workshop-host": "10.240.0.16/28" },
    {
      composeText: "services:\n  workbench:\n    networks: [lab, workshop-host]\n",
      definition: "workbench-fixture",
      eventId: "event",
    },
  );
  const attachments = plan.segments.map((segment, index) => ({
    segment,
    device: segment.name === "lab" ? "eth0" : "eth1",
    ipv4: `10.240.0.${String(index * 16 + 2)}`,
    ipv6: `${requiredNetworkValue(segment.ipv6.split("/")[0])}2`,
  }));
  const byName = (name: string) =>
    requiredNetworkValue(attachments.find((entry) => entry.segment.name === name));
  // Docker's object order puts the host-facing network first; the choice must still be by name.
  const networks = Object.fromEntries(
    ["workshop-host", "lab"].map((name) => [
      `${plan.project}_${name}`,
      { IPAddress: byName(name).ipv4, GlobalIPv6Address: byName(name).ipv6 },
    ]),
  );
  const container = {
    Id: "fedcba654321",
    Config: {
      Labels: {
        "com.docker.compose.project": plan.project,
        "com.docker.compose.service": "workbench",
        "tenkacloud.isolation.owner": plan.owner,
        "tenkacloud.isolation.generation": plan.generation,
      },
    },
    HostConfig: { Privileged: false, CapAdd: [] },
    State: { Running: true, Pid: 43 },
    NetworkSettings: { SandboxKey: "/var/run/docker/netns/fedcba654321", Networks: networks },
  };
  const mutations: string[][] = [];
  const installed = new Map<string, { gateway: string; dev: string }>();
  let badReadback = false;
  function namespaceInventory(args: readonly string[]): string {
    if (args[1] === "readlink") return "net:[2]";
    const ipv6 = args.includes("-6");
    if (args.includes("replace")) {
      mutations.push([...args]);
      const destination = requiredNetworkValue(args[args.indexOf("replace") + 1]);
      installed.set(requiredNetworkValue(destination.split("/")[0]), {
        gateway: requiredNetworkValue(args[args.indexOf("via") + 1]),
        dev: requiredNetworkValue(args[args.indexOf("dev") + 1]),
      });
      return "";
    }
    const address = requiredNetworkValue(args.at(-1));
    const attached = attachments.find((entry) => segmentGateway(entry.segment, ipv6) === address);
    if (attached)
      return JSON.stringify([
        { dev: attached.device, prefsrc: ipv6 ? attached.ipv6 : attached.ipv4 },
      ]);
    const route = requiredNetworkValue(installed.get(address));
    return JSON.stringify([{ ...route, dev: badReadback ? "eth9" : route.dev }]);
  }
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: () => {
      throw new Error("Unexpected read");
    },
    exists: () => true,
    link: (path) => (path === "/proc/self/ns/net" ? "net:[1]" : "net:[2]"),
    run: ({ command, args }) => {
      if (command === "docker" && args[0] === "ps") return container.Id;
      if (command === "docker" && args[0] === "inspect") return JSON.stringify([container]);
      if (command === "docker" && args[0] === "network") {
        const { segment } = byName(requiredNetworkValue(args[2]).slice(plan.project.length + 1));
        return JSON.stringify([
          {
            IPAM: {
              Config: [
                { Subnet: segment.ipv4, Gateway: segmentGateway(segment, false) },
                { Subnet: segment.ipv6, Gateway: segmentGateway(segment, true) },
              ],
            },
          },
        ]);
      }
      if (command === "ip") {
        const { segment } = requiredNetworkValue(
          attachments.find((entry) => entry.segment.bridge === args.at(-1)),
        );
        return JSON.stringify([
          {
            addr_info: [
              {
                family: "inet",
                prefixlen: 28,
                scope: "global",
                local: segmentGateway(segment, false),
              },
              {
                family: "inet6",
                prefixlen: 64,
                scope: "global",
                local: segmentGateway(segment, true),
              },
            ],
          },
        ]);
      }
      if (command === "nsenter") return namespaceInventory(args);
      throw new Error(`Unexpected fake command ${command}`);
    },
  });
  guard.verifyNetworks = () => undefined;
  return {
    guard,
    plan,
    lab: byName("lab").segment,
    mutations,
    badReadback: () => {
      badReadback = true;
    },
  };
}
test("a service on two owned networks replies to VPN peers through its first segment by name", () => {
  const f = workbenchFixture();
  f.guard.routeVpnReplies(f.plan, ["10.251.240.2", "fd55:240::2"]);
  expect(f.mutations.map((args) => args.slice(-6).join(" "))).toEqual([
    `replace 10.251.240.2/32 via ${segmentGateway(f.lab, false)} dev eth0`,
    `replace fd55:240::2/128 via ${segmentGateway(f.lab, true)} dev eth0`,
  ]);
});
test("a two-network service whose reply route reads back wrong keeps admission closed", () => {
  const f = workbenchFixture();
  f.badReadback();
  expect(() => f.guard.routeVpnReplies(f.plan, ["10.251.240.2"])).toThrow(
    "VPN reply route readback did not match its owned gateway.",
  );
});
