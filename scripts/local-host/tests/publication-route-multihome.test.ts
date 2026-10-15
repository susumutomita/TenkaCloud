/* eslint-disable sonarjs/no-hardcoded-ip -- synthetic owned subnets; the command oracle never connects */
import { expect, test } from "bun:test";
import { isIP } from "node:net";
import { stringify } from "yaml";
import { LinuxNetworkGuard } from "../linux-network-guard";
import {
  type LocalNetworkPlan,
  localNetworkPlan,
  requiredNetworkValue,
  segmentGateway,
  sharedNetworkPlan,
} from "../local-network";

function compose(services: Record<string, string[]>, networks: string[]): string {
  return stringify({
    services: Object.fromEntries(
      Object.entries(services).map(([name, nets]) => [name, { image: "alpine", networks: nets }]),
    ),
    networks: Object.fromEntries(networks.map((name) => [name, {}])),
  });
}

const HOST_FILES: Readonly<Record<string, string>> = {
  "/var/run/docker.pid": "123",
  "/proc/123/comm": "dockerd",
};

function restoreFirewall(table: Map<string, string[]>, input: string): string {
  for (const line of input.split("\n")) {
    const [action, chain = "", ...rest] = line.split(" ");
    if (line.startsWith(":")) table.set(line.slice(1).split(" ")[0] ?? "", []);
    else if (action === "-F") table.set(chain, []);
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
  const [action, chain] = args.slice(2);
  if (action === "-S")
    return [...table]
      .filter(([name]) => chain === undefined || name === chain)
      .flatMap(([name, rules]) => [`-N ${name}`, ...rules])
      .join("\n");
  if (action === "-C" && table.get(chain ?? "")?.includes(["-A", ...args.slice(3)].join(" ")))
    return "";
  throw new Error(`Unexpected firewall ${args.join(" ")}`);
}

function scenario(consumerNetworks: string[]) {
  const subnets = Object.fromEntries(
    consumerNetworks.map((name, index) => [name, `10.242.0.${index * 16}/28`]),
  );
  const consumerBase = localNetworkPlan("tch-multi-consumer", subnets, {
    composeText: compose({ workbench: consumerNetworks }, consumerNetworks),
    definition: "consumer",
    eventId: "ev",
  });
  const publisherBase = localNetworkPlan(
    "tch-multi-publisher",
    { dmz: "10.243.0.0/28" },
    { composeText: compose({ web: ["dmz"] }, ["dmz"]), definition: "publisher", eventId: "ev" },
  );
  const dmz = requiredNetworkValue(publisherBase.segments[0]);
  const endpoint = {
    service: "web",
    segment: dmz,
    addresses: ["10.243.0.2", dmz.ipv6.replace("::/64", "::2")],
    port: 8080,
  };
  const publishers = [{ plan: publisherBase, endpoints: [endpoint] }];
  const participants = [consumerBase, publisherBase];
  const consumer = sharedNetworkPlan(consumerBase, publishers, participants);
  const publisher = sharedNetworkPlan(publisherBase, publishers, participants);
  const runtimes = [
    { plan: consumer, service: "workbench", id: "aaaaaaaaaaaa" },
    { plan: publisher, service: "web", id: "bbbbbbbbbbbb" },
  ];
  const running = { value: false };
  const namespaces = new Map<string, Map<string, string>>();
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
  const segmentOf = (bridge: string) =>
    runtimes.flatMap((r) => r.plan.segments).find((segment) => segment.bridge === bridge);
  const networkRow = (plan: LocalNetworkPlan, name: string) => {
    const segment = requiredNetworkValue(plan.segments.find((s) => s.name === name));
    const owner = runtimes.find((r) => r.plan === plan);
    return {
      Name: `${plan.project}_${name}`,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: true,
      Options: { "com.docker.network.bridge.name": segment.bridge },
      Labels: {
        "com.docker.compose.project": plan.project,
        "tenkacloud.isolation.owner": plan.owner,
      },
      IPAM: {
        Config: [
          { Subnet: segment.ipv4, Gateway: segmentGateway(segment, false) },
          { Subnet: segment.ipv6, Gateway: segmentGateway(segment, true) },
        ],
      },
      Containers: running.value && owner ? { [owner.id]: {} } : {},
    };
  };
  const container = (r: (typeof runtimes)[number]) => ({
    Id: r.id,
    Config: {
      Labels: {
        "com.docker.compose.project": r.plan.project,
        "com.docker.compose.service": r.service,
        "tenkacloud.isolation.owner": r.plan.owner,
        "tenkacloud.isolation.generation": r.plan.generation,
      },
    },
    HostConfig: { Privileged: false, NetworkMode: "bridge", CapAdd: [] },
    State: { Running: true },
    NetworkSettings: {
      SandboxKey: `/var/run/docker/netns/${r.id}`,
      Networks: Object.fromEntries(
        r.plan.segments.map((s) => [
          `${r.plan.project}_${s.name}`,
          r.id === "bbbbbbbbbbbb"
            ? { IPAddress: "10.243.0.2", GlobalIPv6Address: endpoint.addresses[1] }
            : {},
        ]),
      ),
    },
  });
  const allNetworks = runtimes.flatMap((r) =>
    r.plan.segments.map((s) => ({ plan: r.plan, name: s.name })),
  );
  const dockerNetwork = (args: readonly string[]): string =>
    args[1] === "ls"
      ? allNetworks.map(({ plan, name }) => `${plan.project}_${name}`).join("\n")
      : JSON.stringify(
          allNetworks
            .filter(({ plan, name }) => args.includes(`${plan.project}_${name}`))
            .map(({ plan, name }) => networkRow(plan, name)),
        );
  const dockerPs = (args: readonly string[]): string => {
    const owner = runtimes.find((r) =>
      args.includes(`label=com.docker.compose.project=${r.plan.project}`),
    );
    if (args.some((arg) => arg.startsWith("label=com.docker.compose.service="))) return "";
    return owner && running.value ? owner.id : "";
  };
  const docker = (args: readonly string[]): string => {
    switch (args[0]) {
      case "context":
        return "unix:///var/run/docker.sock";
      case "info":
        return JSON.stringify({
          OSType: "linux",
          OperatingSystem: "Linux",
          ServerVersion: "28.4.0",
          SecurityOptions: [],
        });
      case "network":
        return dockerNetwork(args);
      case "ps":
        return dockerPs(args);
      case "inspect":
        return JSON.stringify(runtimes.filter((r) => args.includes(r.id)).map(container));
      default:
        throw new Error(`Unexpected docker ${args.join(" ")}`);
    }
  };
  // Kernel model: a table route is keyed by destination; `replace` overwrites the gateway.
  const kernelDst = (dst: string) => {
    const [address = "", prefix] = dst.split("/");
    const canonical =
      isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
    return prefix === "32" || prefix === "128" ? canonical : `${canonical}/${prefix}`;
  };
  const nsenter = (args: readonly string[]): string => {
    const sandbox = requiredNetworkValue(args[0]).replace("--net=", "");
    const rest = args.slice(1);
    const ipv6 = rest.includes("-6");
    const table = namespaces.get(sandbox) ?? new Map<string, string>();
    namespaces.set(sandbox, table);
    const words = rest.filter((w) => w !== "-6");
    if (words.join(" ") === "ip -j route show")
      return JSON.stringify(
        [...table]
          .filter(([dst]) => (isIP(dst.split("/")[0] ?? "") === 6) === ipv6)
          .map(([dst, gateway]) => ({ dst, gateway, dev: "eth0" })),
      );
    if (words[1] === "route" && words[2] === "replace" && words[4] === "via") {
      table.set(kernelDst(requiredNetworkValue(words[3])), requiredNetworkValue(words[5]));
      return "";
    }
    throw new Error(`Unexpected nsenter ${args.join(" ")}`);
  };
  const ip = (args: readonly string[]): string => {
    if (args.join(" ").startsWith("-j address show dev ")) {
      const segment = requiredNetworkValue(segmentOf(requiredNetworkValue(args.at(-1))));
      return JSON.stringify([
        {
          addr_info: [
            {
              family: "inet",
              scope: "global",
              prefixlen: 28,
              local: segmentGateway(segment, false),
            },
            {
              family: "inet6",
              scope: "global",
              prefixlen: 64,
              local: segmentGateway(segment, true),
            },
          ],
        },
      ]);
    }
    throw new Error(`Unexpected ip ${args.join(" ")}`);
  };
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: (path) => HOST_FILES[path] ?? "1",
    exists: () => true,
    link: () => "net:[synthetic]",
    run: ({ command, args, input }) => {
      if (command === "docker") return docker(args);
      if (command === "nsenter") return nsenter(args);
      if (command === "ip") return ip(args);
      const table = requiredNetworkValue(tables.get(command.replace("-restore", "")));
      return input === undefined ? queryFirewall(table, args) : restoreFirewall(table, input);
    },
  });
  for (const r of runtimes) guard.install({ ...r.plan, publicRoutes: [] });
  running.value = true;
  return { guard, consumer, publisher, namespaces };
}

for (const networks of [["lab"], ["lab", "workshop-host"]])
  test(`a consumer attached to ${networks.join(" and ")} keeps one route per published address and passes the audit`, () => {
    const s = scenario(networks);
    s.guard.update(s.consumer, { ...s.consumer, publicRoutes: [] });
    s.guard.routePublications(s.consumer);
    expect(s.namespaces.get("/var/run/docker/netns/aaaaaaaaaaaa")?.size).toBe(2);
    expect(() => s.guard.verifyNetworks(s.consumer)).not.toThrow();
  });
