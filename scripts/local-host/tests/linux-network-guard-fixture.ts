import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan, requiredNetworkValue, segmentGateway } from "../local-network";

/* eslint-disable sonarjs/no-hardcoded-ip -- Docker default network inspect fixture, never contacted. */
export const defaultDockerNetworks = [
  {
    Name: "bridge",
    Driver: "bridge",
    IPAM: { Config: [{ Subnet: "172.17.0.0/16", Gateway: "172.17.0.1" }] },
  },
  { Name: "host", Driver: "host", IPAM: { Config: null } },
  { Name: "none", Driver: "null", IPAM: { Config: null } },
];
/* eslint-enable sonarjs/no-hardcoded-ip */

// Pure command/ownership test adapter. It is not evidence of real packet enforcement.
export function linuxNetworkGuardFixture(override?: ReturnType<typeof localNetworkPlan>) {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic allocation; pure command oracle never connects
  const plan = override ?? localNetworkPlan("tch-guard-test", { default: "10.240.0.0/28" });
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  const tables = new Map<string, Map<string, string[]>>();
  for (const command of ["iptables", "ip6tables"])
    tables.set(
      command,
      new Map([
        ["INPUT", []],
        ["FORWARD", command === "iptables" ? ["-A FORWARD -j DOCKER-USER"] : []],
        ["DOCKER-USER", []],
      ]),
    );
  const settings = {
    platform: "linux",
    version: "28.4.0",
    rootless: false,
    bridgeFilter: "1",
    networkExists: false,
    failIPv6Restore: false,
    endpoint: "unix:///var/run/docker.sock",
    socketOwned: true,
    running: false,
    daemonUnavailable: false,
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Synthetic addresses are test data and are never contacted.
    routes: ["192.168.1.0/24"],
    interfaces: [] as string[],
    dockerSubnets: [] as string[],
    defaultNetworks: false,
    defaultConfig: undefined as unknown,
  };
  function info(): string {
    return JSON.stringify({
      OSType: "linux",
      OperatingSystem: "Linux",
      ServerVersion: settings.version,
      SecurityOptions: settings.rootless ? ["name=rootless"] : ["name=seccomp"],
    });
  }
  const containerIds = () =>
    Object.keys(plan.services).map((_, index) => (index + 1).toString(16).padStart(12, "0"));
  const runningResult = () => (settings.running ? "owned-runtime" : "");
  function ensureDockerAvailable(): void {
    if (settings.daemonUnavailable) throw new Error("Synthetic Docker outage");
  }
  function dockerResult(call: { args: readonly string[] }): string {
    if (call.args[0] === "compose") return "2.33.1";
    if (call.args[0] === "context") return settings.endpoint;
    if (call.args[0] === "info") return info();
    if (call.args[0] === "ps")
      return call.args.includes("-aq") && settings.networkExists
        ? containerIds().join("\n")
        : runningResult();
    if (call.args[0] === "inspect")
      return JSON.stringify(
        Object.entries(plan.services).map(([service, networks], index) => ({
          Id: containerIds()[index],
          Config: {
            Labels: {
              "com.docker.compose.service": service,
              "com.docker.compose.project": plan.project,
              "tenkacloud.isolation.owner": plan.owner,
              "tenkacloud.isolation.generation": plan.generation,
            },
          },
          HostConfig: {
            Privileged: false,
            Dns: plan.egressSegments
              .filter((segment) => segment.service === service)
              .map((segment) => segmentGateway(segment, false)),
          },
          State: { Running: false },
          NetworkSettings: {
            Networks: Object.fromEntries(networks.map((name) => [`${plan.project}_${name}`, {}])),
          },
        })),
      );
    return dockerNetworkResult(call);
  }
  function networkNames(): string {
    return [
      ...(settings.defaultNetworks ? defaultDockerNetworks.map((row) => row.Name) : []),
      ...(settings.networkExists
        ? plan.segments.map((segment) => `${plan.project}_${segment.name}`)
        : []),
      ...(settings.dockerSubnets.length ? ["foreign"] : []),
    ].join("\n");
  }
  function defaultConfig(config: unknown): unknown {
    return settings.defaultConfig === undefined ? config : settings.defaultConfig;
  }
  function dockerNetworkResult(call: { args: readonly string[] }): string {
    if (call.args[1] === "inspect" && call.args.length > 3)
      return JSON.stringify(
        call.args
          .slice(2)
          .flatMap((name) =>
            JSON.parse(dockerNetworkResult({ args: ["network", "inspect", name] })),
          ),
      );
    if (call.args[1] === "ls") return networkNames();
    if (call.args[1] === "inspect" && call.args[2] === "foreign")
      return JSON.stringify([
        { IPAM: { Config: settings.dockerSubnets.map((Subnet) => ({ Subnet })) } },
      ]);
    const builtin = defaultDockerNetworks.find((row) => row.Name === call.args[2]);
    if (settings.defaultNetworks && builtin)
      return JSON.stringify([{ ...builtin, IPAM: { Config: defaultConfig(builtin.IPAM.Config) } }]);
    const segment = requiredNetworkValue(
      plan.segments.find((entry) => `${plan.project}_${entry.name}` === call.args[2]) ??
        plan.segments[0],
    );
    if (call.args[1] === "inspect")
      return JSON.stringify([
        {
          Driver: "bridge",
          Internal: !plan.egressSegments.some((entry) => entry.name === segment.name),
          EnableIPv6: true,
          Options: {
            "com.docker.network.bridge.name": segment.bridge,
          },
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
          Containers: Object.fromEntries(
            Object.entries(plan.services).flatMap(([service, networks], index) =>
              networks.includes(segment.name) ? [[containerIds()[index], { Name: service }]] : [],
            ),
          ),
        },
      ]);
    throw new Error("Unexpected Docker operation.");
  }
  const guard = new LinuxNetworkGuard({
    interfaces: () => ({
      fixture: settings.interfaces.map((address) => ({
        address,
        family: address.includes(":") ? "IPv6" : "IPv4",
        netmask: "",
        internal: false,
        mac: "",
        cidr: null,
        scopeid: 0,
      })),
    }),
    socketOwned: () => settings.socketOwned,
    platform: settings.platform,
    read: (path) => {
      if (path === "/var/run/docker.pid") return "123";
      if (path === "/proc/123/comm") return "dockerd";
      return settings.bridgeFilter;
    },
    link: () => "net:[synthetic-native-host]",
    exists: () => settings.networkExists,
    run: (call) => {
      calls.push(call);
      if (call.command === "docker") {
        ensureDockerAvailable();
        return dockerResult(call);
      }
      if (call.command === "ip")
        return JSON.stringify([
          { dst: "default" },
          ...settings.routes
            .filter((dst) => dst.includes(":") === call.args.includes("-6"))
            .map((dst) => ({ dst })),
        ]);
      const restore = call.command.endsWith("-restore");
      const family = restore ? call.command.replace("-restore", "") : call.command;
      const table = tables.get(family);
      if (!table) throw new Error("Unexpected command.");
      if (restore) {
        if (settings.failIPv6Restore && family === "ip6tables")
          throw new Error("Synthetic IPv6 restore failure.");
        applyRestore(table, requiredNetworkValue(call.input));
        return "";
      }
      return applyFirewall(table, call.args.slice(2));
    },
  });
  return { guard, plan, calls, settings, tables };
}
function applyFirewall(table: Map<string, string[]>, args: readonly string[]): string {
  const [action, chain] = args;
  if (action === "-S")
    return chain
      ? [`-N ${chain}`, ...requiredNetworkValue(table.get(chain))].join("\n")
      : [...table].flatMap(([name, rules]) => [`-N ${name}`, ...rules]).join("\n");
  const expected = kernelRule(["-A", chain, ...args.slice(2)].join(" "));
  if (action === "-C") {
    if (!table.get(requiredNetworkValue(chain))?.includes(expected))
      throw new Error("Missing guard rule.");
  } else if (action === "-D")
    table.set(
      requiredNetworkValue(chain),
      requiredNetworkValue(table.get(requiredNetworkValue(chain))).filter(
        (line) => line !== expected,
      ),
    );
  else if (action === "-F") table.set(requiredNetworkValue(chain), []);
  else if (action === "-X") table.delete(requiredNetworkValue(chain));
  else throw new Error("Unexpected firewall action.");
  return "";
}
function kernelRule(line: string): string {
  const matches = [...line.matchAll(/(?:^| )-m ([^ ]+)/gu)].map((match) => match[1]);
  if (new Set(matches).size !== matches.length)
    throw new Error(`Duplicated firewall match module: ${line}`);
  return line.replace(/-p (tcp|udp) (--(?:dport|sport))/gu, "-p $1 -m $1 $2");
}
function applyRestore(table: Map<string, string[]>, input: string): void {
  for (const line of input.split("\n")) {
    if (line.startsWith(":")) table.set(requiredNetworkValue(line.slice(1).split(" ")[0]), []);
    else if (line.startsWith("-A "))
      requiredNetworkValue(table.get(requiredNetworkValue(line.split(" ")[1]))).push(
        kernelRule(line),
      );
    else if (line.startsWith("-F ")) table.set(requiredNetworkValue(line.split(" ")[1]), []);
    else if (line.startsWith("-I ")) {
      const tokens = line.split(" ");
      requiredNetworkValue(table.get(requiredNetworkValue(tokens[1]))).splice(
        Number(tokens[2]) - 1,
        0,
        ["-A", tokens[1], ...tokens.slice(3)].join(" "),
      );
    } else if (line.startsWith("-D ")) applyFirewall(table, line.split(" "));
  }
}
