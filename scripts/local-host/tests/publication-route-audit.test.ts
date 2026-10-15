/* eslint-disable sonarjs/no-hardcoded-ip -- No network operations: a fake command port answers every Docker, firewall and namespace read. */
import { expect, test } from "bun:test";
import { LinuxNetworkGuard } from "../linux-network-guard";
import {
  type LocalNetworkPlan,
  type LocalPublicRoute,
  localNetworkPlan,
  requiredNetworkValue,
} from "../local-network";

interface Runtime {
  readonly plan: LocalNetworkPlan;
  readonly service: string;
  readonly id: string;
  readonly addresses?: { readonly IPAddress: string; readonly GlobalIPv6Address: string };
}

// The planned IPv6 subnets are deliberately non-canonical; the kernel prints RFC 5952 text.
function runtime(project: string, ipv4: string, ipv6: string, service: string) {
  const base = localNetworkPlan(project, { net: ipv4 });
  const segment = { ...requiredNetworkValue(base.segments[0]), ipv6 };
  return { ...base, segments: [segment], services: { [service]: ["net"] } };
}

function fixture() {
  const consumerBase = runtime("tch-route-consumer", "10.242.0.0/28", "fd33:a:0:0::/64", "console");
  const publisherBase = runtime("tch-route-publisher", "10.243.0.0/28", "fd33:b:0:0::/64", "web");
  const published = { IPAddress: "10.243.0.2", GlobalIPv6Address: "fd33:b::2" };
  const routes: LocalPublicRoute[] = [published.IPAddress, published.GlobalIPv6Address].map(
    (address) => ({
      service: "web",
      from: requiredNetworkValue(consumerBase.segments[0]),
      to: requiredNetworkValue(publisherBase.segments[0]),
      address,
      port: 8080,
      publisherProject: publisherBase.project,
      publisherOwner: publisherBase.owner,
      fromProject: consumerBase.project,
      fromOwner: consumerBase.owner,
    }),
  );
  const consumer: Runtime = {
    plan: { ...consumerBase, publicRoutes: routes },
    service: "console",
    id: "aaaaaaaaaaaa",
  };
  const publisher: Runtime = {
    plan: { ...publisherBase, publicRoutes: routes },
    service: "web",
    id: "bbbbbbbbbbbb",
    addresses: published,
  };
  const runtimes = [consumer, publisher];
  const networkName = (entry: Runtime) => `${entry.plan.project}_net`;
  const state = { running: false, stopped: new Set<string>() };
  const namespaces = new Map<string, Record<"4" | "6", object[]>>();
  const tables = new Map<string, Map<string, string[]>>(
    ["iptables", "ip6tables"].map((family) => [
      family,
      new Map([
        ["INPUT", []],
        ["FORWARD", family === "iptables" ? ["-A FORWARD -j DOCKER-USER"] : []],
        ["DOCKER-USER", []],
      ]),
    ]),
  );
  function networkRow(entry: Runtime) {
    const segment = requiredNetworkValue(entry.plan.segments[0]);
    return {
      Name: networkName(entry),
      Driver: "bridge",
      Internal: true,
      EnableIPv6: true,
      Options: { "com.docker.network.bridge.name": segment.bridge },
      Labels: {
        "com.docker.compose.project": entry.plan.project,
        "tenkacloud.isolation.owner": entry.plan.owner,
      },
      IPAM: { Config: [{ Subnet: segment.ipv4 }, { Subnet: segment.ipv6 }] },
      Containers: state.running && !state.stopped.has(entry.id) ? { [entry.id]: {} } : {},
    };
  }
  function container(entry: Runtime) {
    const running = !state.stopped.has(entry.id);
    return {
      Id: entry.id,
      Config: {
        Labels: {
          "com.docker.compose.project": entry.plan.project,
          "com.docker.compose.service": entry.service,
          "tenkacloud.isolation.owner": entry.plan.owner,
          "tenkacloud.isolation.generation": entry.plan.generation,
        },
      },
      HostConfig: { Privileged: false, NetworkMode: networkName(entry), CapAdd: [] },
      State: { Running: running },
      NetworkSettings: {
        SandboxKey: running ? `/var/run/docker/netns/${entry.id}` : "",
        Networks: { [networkName(entry)]: entry.addresses ?? {} },
      },
    };
  }
  const daemon: Record<string, (args: readonly string[]) => string> = {
    context: () => "unix:///var/run/docker.sock",
    info: () =>
      JSON.stringify({
        OSType: "linux",
        OperatingSystem: "Linux",
        ServerVersion: "28.4.0",
        SecurityOptions: ["name=seccomp"],
      }),
    network: (args) => {
      if (args[1] === "ls") return runtimes.map(networkName).join("\n");
      if (args[1] !== "inspect") throw new Error(`Unexpected network operation ${args.join(" ")}`);
      return JSON.stringify(
        runtimes.filter((entry) => args.includes(networkName(entry))).map(networkRow),
      );
    },
    ps: (args) => {
      const owner = runtimes.find((entry) =>
        args.includes(`label=com.docker.compose.project=${entry.plan.project}`),
      );
      const listed = owner && state.running && (args[1] === "-aq" || !state.stopped.has(owner.id));
      return listed ? owner.id : "";
    },
    inspect: (args) =>
      JSON.stringify(
        runtimes.filter((entry) => args.includes(entry.id)).map((entry) => container(entry)),
      ),
  };
  function docker(args: readonly string[]): string {
    const operation = daemon[args[0] ?? ""];
    if (!operation) throw new Error(`Unexpected Docker operation ${args.join(" ")}`);
    return operation(args);
  }
  function namespace(args: readonly string[]): string {
    const sandbox = requiredNetworkValue(args[0]).replace("--net=", "");
    const family = args.includes("-6") ? "6" : "4";
    if (args.slice(1).join(" ") !== `ip${family === "6" ? " -6" : ""} -j route show`)
      throw new Error(`Unexpected namespace operation ${args.join(" ")}`);
    return JSON.stringify(namespaces.get(sandbox)?.[family] ?? []);
  }
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: (path) => {
      if (path === "/var/run/docker.pid") return "123";
      if (path === "/proc/123/comm") return "dockerd";
      return "1";
    },
    exists: () => true,
    link: () => "net:[synthetic-native-host]",
    run: ({ command, args, input }) => {
      if (command === "docker") return docker(args);
      if (command === "nsenter") return namespace(args);
      const table = requiredNetworkValue(tables.get(command.replace("-restore", "")));
      return input === undefined
        ? queryFirewall(table, args.slice(2))
        : restoreFirewall(table, input);
    },
  });
  for (const entry of runtimes) guard.install(entry.plan);
  state.running = true;
  return { guard, consumer, publisher, namespaces, state };
}

function restoreFirewall(table: Map<string, string[]>, input: string): string {
  for (const line of input.split("\n")) {
    const [action, chain = "", ...rest] = line.split(" ");
    if (line.startsWith(":")) table.set(line.slice(1).split(" ")[0] ?? "", []);
    else if (action === "-A") requiredNetworkValue(table.get(chain)).push(line);
    else if (action === "-I")
      requiredNetworkValue(table.get(chain)).splice(
        Number(rest[0]) - 1,
        0,
        ["-A", chain, ...rest.slice(1)].join(" "),
      );
  }
  return "";
}
function queryFirewall(table: Map<string, string[]>, args: readonly string[]): string {
  const [action, chain] = args;
  if (action === "-S")
    return [...table]
      .filter(([name]) => chain === undefined || name === chain)
      .flatMap(([name, rules]) => [`-N ${name}`, ...rules])
      .join("\n");
  if (action === "-C" && table.get(chain ?? "")?.includes(["-A", ...args.slice(1)].join(" ")))
    return "";
  throw new Error(`Unexpected firewall operation ${args.join(" ")}`);
}

function kernelRoutes(connected: readonly string[], routed: Record<string, string>) {
  return [
    ...connected.map((dst) => ({ dst, dev: "eth0", protocol: "kernel", scope: "link" })),
    ...Object.entries(routed).map(([dst, gateway]) => ({ dst, gateway, dev: "eth0" })),
  ];
}
function installPublishedRoutes(f: ReturnType<typeof fixture>): void {
  f.namespaces.set("/var/run/docker/netns/aaaaaaaaaaaa", {
    "4": kernelRoutes(["10.242.0.0/28"], { "10.243.0.2": "10.242.0.1" }),
    "6": kernelRoutes(["fd33:a::/64"], { "fd33:b::2": "fd33:a::1" }),
  });
  f.namespaces.set("/var/run/docker/netns/bbbbbbbbbbbb", {
    "4": kernelRoutes(["10.243.0.0/28"], { "10.242.0.0/28": "10.243.0.1" }),
    "6": kernelRoutes(["fd33:b::/64"], { "fd33:a::/64": "fd33:b::1" }),
  });
}

test("audits accept published routes the kernel prints canonically for both consumer and publisher", () => {
  const f = fixture();
  installPublishedRoutes(f);
  expect(() => f.guard.verifyNetworks(f.consumer.plan)).not.toThrow();
  expect(() => f.guard.verifyNetworks(f.publisher.plan)).not.toThrow();
});

test("a recreated consumer namespace without its published routes fails the audit", () => {
  const f = fixture();
  installPublishedRoutes(f);
  f.namespaces.set("/var/run/docker/netns/aaaaaaaaaaaa", {
    "4": kernelRoutes(["10.242.0.0/28"], {}),
    "6": kernelRoutes(["fd33:a::/64"], {}),
  });
  expect(() => f.guard.verifyNetworks(f.consumer.plan)).toThrow(
    "Published DMZ route is missing from an owned workload namespace.",
  );
  expect(() => f.guard.verifyNetworks(f.publisher.plan)).not.toThrow();
});

test("a recreated publisher namespace without its return route fails the audit", () => {
  const f = fixture();
  installPublishedRoutes(f);
  f.namespaces.set("/var/run/docker/netns/bbbbbbbbbbbb", {
    "4": kernelRoutes(["10.243.0.0/28"], { "10.242.0.0/28": "10.243.0.1" }),
    "6": kernelRoutes(["fd33:b::/64"], {}),
  });
  expect(() => f.guard.verifyNetworks(f.publisher.plan)).toThrow(
    "Published DMZ route is missing from an owned workload namespace.",
  );
});

test("a stopped consumer has no namespace to inspect and keeps its audit", () => {
  const f = fixture();
  f.state.stopped.add(f.consumer.id);
  expect(() => f.guard.verifyNetworks(f.consumer.plan)).not.toThrow();
});
