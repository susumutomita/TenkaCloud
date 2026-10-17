import { expect, test } from "bun:test";
import { allocateNetworkSubnets } from "../docker-networks";
import { LinuxNetworkGuard } from "../linux-network-guard";
import {
  egressComposeSource,
  localNetworkPlan,
  requiredNetworkValue,
  segmentGateway,
} from "../local-network";

// Pure command/ownership test adapter. It is not evidence of real packet enforcement.
function fixture(override?: ReturnType<typeof localNetworkPlan>) {
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
      ...(settings.networkExists
        ? plan.segments.map((segment) => `${plan.project}_${segment.name}`)
        : []),
      ...(settings.dockerSubnets.length ? ["foreign"] : []),
    ].join("\n");
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
test("both families install atomically before an absent bridge and verify exact owned rules", () => {
  const f = fixture();
  f.guard.install(f.plan);
  expect(f.calls.filter((call) => call.command.endsWith("-restore"))).toHaveLength(2);
  expect(
    f.calls
      .filter((call) => call.command.endsWith("-restore"))
      .every((call) => call.args.includes("--noflush")),
  ).toBe(true);
  f.guard.verify(f.plan);
  f.guard.install(f.plan);
  expect(f.calls.filter((call) => call.command.endsWith("-restore"))).toHaveLength(2);
});
test("unsupported Docker and bridge filter modes fail without mutation or privilege escalation", () => {
  for (const version of ["27.5.0", "29.0.0", "garbage"]) {
    const f = fixture();
    f.settings.version = version;
    expect(() => f.guard.install(f.plan)).toThrow("28.4.x");
    expect(f.calls.some((call) => call.command.endsWith("-restore"))).toBe(false);
  }
  const f = fixture();
  f.settings.bridgeFilter = "0";
  expect(() => f.guard.install(f.plan)).toThrow("already be enabled");
  expect(f.calls.some((call) => /sudo|sysctl|modprobe/u.test(call.command))).toBe(false);
});
test("partial family failure never reports successful admission and keeps the installed guard", () => {
  const f = fixture();
  f.settings.failIPv6Restore = true;
  expect(() => f.guard.install(f.plan)).toThrow("IPv6 restore");
  expect(f.tables.get("iptables")?.get(f.plan.inputChain)?.at(-1)).toBe(
    `-A ${f.plan.inputChain} -j DROP`,
  );
  expect(() => f.guard.verify(f.plan)).toThrow();
});
test("extra rules, misplaced hooks and missing deny cannot be adopted", () => {
  const f = fixture();
  f.guard.install(f.plan);
  requiredNetworkValue(requiredNetworkValue(f.tables.get("iptables")).get("INPUT")).unshift(
    "-A INPUT -j ACCEPT",
  );
  expect(() => f.guard.verify(f.plan)).toThrow("precedes");
  requiredNetworkValue(requiredNetworkValue(f.tables.get("iptables")).get("INPUT")).shift();
  requiredNetworkValue(
    requiredNetworkValue(f.tables.get("ip6tables")).get(f.plan.forwardChain),
  ).push(`-A ${f.plan.forwardChain} -j ACCEPT`);
  expect(() => f.guard.verify(f.plan)).toThrow("changed");
});
test("cleanup refuses residual bridges, then removes only owned guards and is repeatable", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.settings.networkExists = true;
  expect(() => f.guard.remove(f.plan)).toThrow("still exists");
  expect(f.tables.get("iptables")?.has(f.plan.inputChain)).toBe(true);
  f.settings.networkExists = false;
  f.guard.remove(f.plan);
  f.guard.remove(f.plan);
  expect(f.tables.get("iptables")?.has(f.plan.inputChain)).toBe(false);
  expect(f.tables.get("iptables")?.get("FORWARD")).toEqual(["-A FORWARD -j DOCKER-USER"]);
});
test("reply allowance binds ingress and conntrack reply source; no broad forwarding REPLY exists", () => {
  const f = fixture();
  f.guard.install(f.plan);
  const input = requiredNetworkValue(
    requiredNetworkValue(f.tables.get("iptables")).get(f.plan.inputChain),
  );
  expect(
    input.some(
      (line) =>
        line.includes(
          `-i ${requiredNetworkValue(f.plan.segments[0]).bridge} -s ${requiredNetworkValue(f.plan.segments[0]).ipv4}`,
        ) && line.includes(`--ctreplsrc ${requiredNetworkValue(f.plan.segments[0]).ipv4}`),
    ),
  ).toBe(true);
  expect(
    requiredNetworkValue(requiredNetworkValue(f.tables.get("iptables")).get(f.plan.forwardChain))
      .filter((line) => line.includes("REPLY"))
      .every(
        (line) =>
          line.includes(" -i ") &&
          line.includes(" -o ") &&
          line.includes("--ctorigsrc") &&
          line.includes("--ctorigdst"),
      ),
  ).toBe(true);
});

test("a different Unix socket or unowned canonical socket refuses startup before mutation", () => {
  const f = fixture();
  f.settings.endpoint = "unix:///tmp/proxy.sock";
  expect(() => f.guard.install(f.plan)).toThrow("Remote Docker");
  expect(f.calls.some((call) => call.command.endsWith("-restore"))).toBe(false);
  const g = fixture();
  g.settings.socketOwned = false;
  expect(() => g.guard.install(g.plan)).toThrow("Remote Docker");
  expect(g.calls.some((call) => call.command.endsWith("-restore"))).toBe(false);
});

test("same-team forwarding binds original destinations so host DNAT cannot become an allowed private tuple", () => {
  const f = fixture();
  f.guard.install(f.plan);
  const rules = requiredNetworkValue(
    requiredNetworkValue(f.tables.get("iptables")).get(f.plan.forwardChain),
  );
  for (const rule of rules.filter((line) => line.endsWith("-j ACCEPT"))) {
    expect(rule).toContain(`--ctorigsrc ${requiredNetworkValue(f.plan.segments[0]).ipv4}`);
    expect(rule).toContain(`--ctorigdst ${requiredNetworkValue(f.plan.segments[0]).ipv4}`);
  }
});

test("protected bridge gateway denial precedes same-team acceptance in both families", () => {
  const f = fixture();
  f.guard.install(f.plan);
  for (const family of ["iptables", "ip6tables"]) {
    const rules = requiredNetworkValue(
      requiredNetworkValue(f.tables.get(family)).get(f.plan.forwardChain),
    );
    const gateway =
      family === "iptables"
        ? requiredNetworkValue(f.plan.segments[0]).ipv4.replace(".0/28", ".1")
        : requiredNetworkValue(f.plan.segments[0]).ipv6.replace("::/64", "::1");
    expect(rules[1]).toContain(`--ctorigdst ${gateway} -j DROP`);
  }
});

test("protected gateway source denial precedes every INPUT reply or NDP acceptance", () => {
  const f = fixture();
  f.guard.install(f.plan);
  for (const family of ["iptables", "ip6tables"]) {
    const rules = requiredNetworkValue(
      requiredNetworkValue(f.tables.get(family)).get(f.plan.inputChain),
    );
    const gateway =
      family === "iptables"
        ? requiredNetworkValue(f.plan.segments[0]).ipv4.replace(".0/28", ".1")
        : requiredNetworkValue(f.plan.segments[0]).ipv6.replace("::/64", "::1");
    expect(rules[1]).toContain(
      `-i ${requiredNetworkValue(f.plan.segments[0]).bridge} -s ${gateway} -j DROP`,
    );
  }
});

test("quarantine blocks at actual FORWARD head even when Docker admission hook is broken", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.settings.networkExists = true;
  f.tables.get("iptables")?.set("FORWARD", ["-A FORWARD ! -i unrelated0 -j ACCEPT"]);
  f.guard.quarantine(f.plan);
  f.guard.quarantine(f.plan);
  for (const family of ["iptables", "ip6tables"]) {
    const rules = requiredNetworkValue(f.tables.get(family)?.get("FORWARD"));
    expect(
      rules
        .slice(0, 2)
        .every((line) => line.includes("tc-quarantine-v1:") && line.endsWith("-j DROP")),
    ).toBe(true);
    expect(rules.filter((line) => line.includes("tc-quarantine-v1:"))).toHaveLength(2);
  }
  expect(() => f.guard.preflight()).toThrow("DOCKER-USER");
});
test("one-family quarantine failure still attempts the other family and retains safe drops", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.settings.networkExists = true;
  f.settings.failIPv6Restore = true;
  expect(() => f.guard.quarantine(f.plan)).toThrow("every family");
  expect(f.tables.get("iptables")?.get("FORWARD")?.[0]).toContain("tc-quarantine-v1:");
});
test("running workloads cannot release quarantine during recovery", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.settings.networkExists = true;
  f.guard.quarantine(f.plan);
  f.settings.running = true;
  f.guard.install(f.plan);
  expect(() => f.guard.resetStopped(f.plan)).toThrow("must be stopped");
  expect(f.tables.get("iptables")?.get("FORWARD")?.[0]).toContain("tc-quarantine-v1:");
});
test("membership cannot hide reordered protected rules", () => {
  const f = fixture();
  f.guard.install(f.plan);
  const rules = requiredNetworkValue(f.tables.get("iptables")?.get(f.plan.forwardChain));
  const protectedIndex = rules.findIndex(
    (line) => line.includes("--ctorigdst") && line.endsWith("-j DROP"),
  );
  const acceptIndex = rules.findIndex((line) => line.endsWith("-j ACCEPT"));
  expect(protectedIndex).toBeGreaterThan(0);
  expect(acceptIndex).toBeGreaterThan(protectedIndex);
  [rules[protectedIndex], rules[acceptIndex]] = [
    requiredNetworkValue(rules[acceptIndex]),
    requiredNetworkValue(rules[protectedIndex]),
  ];
  expect(() => f.guard.verify(f.plan)).toThrow();
});

test("final teardown removes and verifies every owned quarantine hook and is repeatable", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.settings.networkExists = true;
  f.guard.quarantine(f.plan);
  expect(() => f.guard.remove(f.plan)).toThrow("still exist");
  f.settings.networkExists = false;
  f.guard.remove(f.plan);
  f.guard.remove(f.plan);
  for (const family of ["iptables", "ip6tables"])
    for (const rules of requiredNetworkValue(f.tables.get(family)).values())
      expect(rules.some((line) => line.includes("tc-quarantine-v1:"))).toBe(false);
});
test("multi-attachment publishers are refused before endpoint resolution can advertise broken reply routes", () => {
  const f = fixture();
  const plan = { ...f.plan, services: { web: ["front", "back"] } };
  expect(() => f.guard.endpoints(plan, "web", 8080)).toThrow("exactly one");
  expect(f.calls).toHaveLength(0);
});

test("quarantine covers not-yet-created owned bridges during partial Compose startup", () => {
  const f = fixture();
  f.guard.quarantine(f.plan);
  expect(f.tables.get("iptables")?.get("FORWARD")?.[0]).toContain("tc-quarantine-v1:");
  f.guard.remove(f.plan);
  expect(f.tables.get("iptables")?.get("FORWARD")).toEqual(["-A FORWARD -j DOCKER-USER"]);
});

test("emergency drops remain independent of an unavailable Docker control plane", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.settings.daemonUnavailable = true;
  f.calls.length = 0;
  f.guard.quarantine(f.plan);
  expect(f.calls.some((call) => call.command === "docker")).toBe(false);
  expect(f.tables.get("iptables")?.get("FORWARD")?.[0]).toContain("tc-quarantine-v1:");
  expect(f.tables.get("ip6tables")?.get("FORWARD")?.[0]).toContain("tc-quarantine-v1:");
});
test("emergency scope rejects a forged bridge before any native mutation", () => {
  const f = fixture();
  const plan = {
    ...f.plan,
    segments: f.plan.segments.map((segment) => ({ ...segment, bridge: "docker0" })),
  };
  expect(() => f.guard.quarantine(plan)).toThrow("controller ledger scope");
  expect(f.calls).toHaveLength(0);
});

test("retained owner quarantine refuses proof and recovery admission", () => {
  const f = fixture();
  f.guard.install(f.plan);
  f.guard.quarantine(f.plan);
  f.guard.install(f.plan);
  expect(() => f.guard.verifyNetworks(f.plan)).toThrow("remains quarantined");
  for (const family of ["iptables", "ip6tables"])
    expect(f.tables.get(family)?.get("FORWARD")?.[0]).toContain("tc-quarantine-v1:");
});

test("undeclared prototype service cannot resolve native endpoints", () => {
  const f = fixture();
  expect(() => f.guard.endpoints(f.plan, "constructor", 8080)).toThrow("exactly one");
  expect(f.calls).toHaveLength(0);
});

test("prototype-only service label refuses shutdown before any stop command", () => {
  const f = fixture();
  const calls: string[][] = [];
  const guard = new LinuxNetworkGuard({
    platform: "linux",
    read: () => {
      throw new Error("Unexpected read");
    },
    exists: () => false,
    link: () => {
      throw new Error("Unexpected link");
    },
    run: ({ command, args }) => {
      calls.push([...args]);
      if (command !== "docker") throw new Error("Unexpected native command");
      if (args[0] === "ps") return "abcdef123456";
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Config: {
              Labels: {
                "com.docker.compose.project": f.plan.project,
                "tenkacloud.isolation.owner": f.plan.owner,
                "tenkacloud.isolation.generation": f.plan.generation,
                "com.docker.compose.service": "constructor",
              },
            },
          },
        ]);
      throw new Error("Unexpected shutdown");
    },
  });
  expect(() => guard.stopOwnedSync(f.plan)).toThrow("identity");
  expect(calls.some((args) => args[0] === "stop")).toBe(false);
});

/* eslint-disable sonarjs/no-hardcoded-ip -- In-memory packet rule and live-inventory oracles; no connections. */
function egressPlan() {
  const base = localNetworkPlan(
    "tch-egress-guard",
    { outbound: "10.240.0.0/28" },
    {
      definition: "pinned-egress-fixture",
      composeText: "services: {}",
    },
  );
  const segment = {
    ...requiredNetworkValue(base.segments[0]),
    bridge: requiredNetworkValue(base.segments[0]).bridge.replace("tci", "tce"),
    service: "app",
  };
  return {
    ...base,
    services: { app: [segment.name] },
    segments: [segment],
    egressSegments: [segment],
    egressRoutes: [
      { requestId: "upstream", service: "app", segment, address: "8.8.8.8", port: 443 },
      { requestId: "ipv6", service: "app", segment, address: "2606:4700:4700::1111", port: 443 },
    ],
  };
}

test("egress grants install exact ORIGINAL and REPLY tuples with final DROP and no generic established accept", () => {
  const plan = egressPlan();
  const f = fixture(plan);
  f.settings.routes = [];
  f.guard.install(plan);
  for (const [family, address, prefix] of [
    ["iptables", "8.8.8.8", 32],
    ["ip6tables", "2606:4700:4700::1111", 128],
  ] as const) {
    const rules = requiredNetworkValue(f.tables.get(family)?.get(plan.forwardChain));
    const accept = rules.filter((rule) => rule.endsWith("-j ACCEPT") && rule.includes("-p tcp"));
    expect(accept).toHaveLength(2);
    expect(accept[0]).toContain(`-i ${plan.segments[0]?.bridge}`);
    expect(accept[0]).toContain(`-d ${address}/${prefix}`);
    expect(accept[0]).toContain("--ctdir ORIGINAL");
    expect(accept[1]).toContain("--ctdir REPLY");
    for (const rule of accept)
      expect(rule).toContain(`--ctorigdst ${address}/${prefix} --ctorigdstport 443`);
    expect(rules.at(-1)).toBe(`-A ${plan.forwardChain} -j DROP`);
    expect(
      rules.some((rule) => rule.includes("ESTABLISHED") && !rule.includes("--ctorigdstport")),
    ).toBe(false);
    expect(
      f.tables
        .get(family)
        ?.get(plan.inputChain)
        ?.some((rule) => rule.includes("ESTABLISHED")),
    ).toBe(false);
  }
  f.guard.quarantine(plan);
});

test("egress DNS has no TCP or UDP port-53 accept and gateway traffic drops in INPUT and FORWARD", () => {
  const plan = egressPlan();
  const f = fixture(plan);
  f.settings.routes = [];
  f.guard.install(plan);
  for (const [family, gateway, parent] of [
    ["iptables", "10.240.0.1", "DOCKER-USER"],
    ["ip6tables", "fd33:8861:a32a:a1d1::1", "FORWARD"],
  ]) {
    const table = requiredNetworkValue(f.tables.get(requiredNetworkValue(family)));
    const input = requiredNetworkValue(table.get(plan.inputChain));
    const forward = requiredNetworkValue(table.get(plan.forwardChain));
    expect(table.get("INPUT")).toContain(`-A INPUT -i tce8861a32aa1d1 -j ${plan.inputChain}`);
    expect(table.get(requiredNetworkValue(parent))).toContain(
      `-A ${parent} -i tce8861a32aa1d1 -j ${plan.forwardChain}`,
    );
    expect(forward).toContain(
      `-A ${plan.forwardChain} -m conntrack --ctorigdst ${gateway} -j DROP`,
    );
    expect(input.at(-1)).toBe(`-A ${plan.inputChain} -j DROP`);
    for (const rules of [input, forward]) {
      expect(
        rules.filter(
          (rule) =>
            rule.endsWith("-j ACCEPT") &&
            /(?:--dport|--sport|--ctorigdstport) 53(?: |$)/u.test(rule),
        ),
      ).toEqual([]);
    }
  }
  f.guard.quarantine(plan);
});

for (const [kind, address, protectedRange] of [
  ["host interface IPv4", "8.8.8.8", "8.8.8.8"],
  ["LAN IPv4", "8.8.8.8", "8.8.8.0/24"],
  ["VPN IPv4", "8.8.8.8", "8.8.0.0/16"],
  ["local table IPv4", "8.8.8.8", "8.8.8.8/32"],
  ["host interface IPv6", "2606:4700:4700::1111", "2606:4700:4700::1111"],
  ["LAN IPv6", "2606:4700:4700::1111", "2606:4700:4700::/64"],
  ["VPN IPv6", "2606:4700:4700::1111", "2606:4700::/32"],
  ["local table IPv6", "2606:4700:4700::1111", "2606:4700:4700::1111/128"],
  ["Docker IPv4", "8.8.8.8", "8.8.8.0/24"],
  ["Docker IPv6", "2606:4700:4700::1111", "2606:4700:4700::/64"],
] as const)
  test(`live inventory rejects ${kind} at approval, install and audit`, () => {
    const plan = egressPlan();
    const f = fixture(plan);
    f.settings.routes = [];
    f.guard.install(plan);
    if (kind.startsWith("host")) f.settings.interfaces = [protectedRange];
    else if (kind.startsWith("Docker")) f.settings.dockerSubnets = [protectedRange];
    else f.settings.routes = [protectedRange];
    expect(() => f.guard.assertInternetTargets([address])).toThrow(
      `Internet destination ${address} overlaps a protected host, LAN/VPN or Docker address.`,
    );
    expect(() => f.guard.install(plan)).toThrow(
      `Internet destination ${address} overlaps a protected host, LAN/VPN or Docker address.`,
    );
    expect(() => f.guard.verify(plan)).toThrow(
      `Internet destination ${address} overlaps a protected host, LAN/VPN or Docker address.`,
    );
  });

test("revocation removes established-flow accepts; owned egress network blocks guard removal until down", () => {
  const plan = egressPlan();
  const f = fixture(plan);
  f.settings.routes = [];
  f.guard.install(plan);
  f.settings.networkExists = true;
  const revoked = { ...plan, egressRoutes: [] };
  f.guard.update(revoked, plan);
  for (const family of ["iptables", "ip6tables"])
    expect(
      f.tables
        .get(family)
        ?.get(plan.forwardChain)
        ?.some((rule) => rule.includes("--ctorigdstport")),
    ).toBe(false);
  expect(() => f.guard.remove(revoked)).toThrow("still exist");
  f.settings.networkExists = false;
  f.guard.remove(revoked);
  expect(f.tables.get("iptables")?.has(plan.forwardChain)).toBe(false);
});

test("stopped retained egress rules are repaired to DROP after grant revocation", () => {
  const plan = egressPlan();
  const f = fixture(plan);
  f.settings.routes = [];
  f.guard.install(plan);
  f.settings.networkExists = true;
  const revoked = { ...plan, egressRoutes: [] };
  f.guard.install(revoked);
  f.guard.verify(revoked);
  expect(
    f.tables
      .get("iptables")
      ?.get(plan.forwardChain)
      ?.some((rule) => rule.includes("--ctorigdstport")),
  ).toBe(false);
});
/* eslint-enable sonarjs/no-hardcoded-ip */

/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic namespace routes, no Docker or network access. */
test("guard verifies non-internal egress ownership, exact service attachments and both default gateways", () => {
  const source = "services:\n  app:\n    image: synthetic\n  db:\n    image: synthetic\n";
  const request = {
    id: "upstream",
    service: "app",
    destination: "8.8.8.8",
    port: 443,
    purpose: "Synthetic",
  };
  const authored = egressComposeSource(source, ["app"]);
  const subnets = allocateNetworkSubnets(authored, "10.240.0.0/24", []);
  const plan = localNetworkPlan("tch-egress-inventory", subnets, {
    composeText: authored,
    definition: "pinned",
    egress: [request],
  });
  const f = fixture(plan);
  f.settings.routes = [];
  f.guard.install(plan);
  f.settings.networkExists = true;
  const segment = requiredNetworkValue(plan.egressSegments[0]);
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const containers = Object.entries(plan.services).map(([service, networks], index) => ({
    Id: requiredNetworkValue(ids[index]),
    Config: {
      Labels: {
        "com.docker.compose.project": plan.project,
        "com.docker.compose.service": service,
        "tenkacloud.isolation.owner": plan.owner,
        "tenkacloud.isolation.generation": plan.generation,
      },
    },
    HostConfig: {
      Privileged: false,
      ...(service === "app" ? { Dns: ["10.240.0.17"] } : {}),
    },
    State: { Running: true },
    NetworkSettings: {
      SandboxKey: `/var/run/docker/netns/${ids[index]}`,
      Networks: Object.fromEntries(networks.map((name) => [`${plan.project}_${name}`, {}])),
    },
  }));
  const io = Reflect.get(f.guard, "io") as ConstructorParameters<typeof LinuxNetworkGuard>[0];
  if (!io) throw new Error("Missing fixture IO");
  let wrongGateway = false;
  let endpoints = [requiredNetworkValue(ids[0])];
  function namespaceDefaults(args: readonly string[]): string {
    return JSON.stringify(
      args[0]?.includes(requiredNetworkValue(ids[0]))
        ? [
            {
              dst: "default",
              gateway: wrongGateway ? "10.241.0.1" : segmentGateway(segment, args.includes("-6")),
            },
          ]
        : [],
    );
  }
  const guard = new LinuxNetworkGuard({
    ...io,
    run: (call) => {
      if (call.command === "docker" && call.args[0] === "ps") return ids.join("\n");
      if (call.command === "docker" && call.args[0] === "inspect")
        return JSON.stringify(containers);
      if (call.command === "nsenter") return namespaceDefaults(call.args);
      const result = io.run(call);
      if (call.command === "docker" && call.args[0] === "network" && call.args[1] === "inspect") {
        const rows = JSON.parse(result);
        for (const row of rows)
          row.Containers = Object.fromEntries(endpoints.map((id) => [id, {}]));
        return JSON.stringify(rows);
      }
      return result;
    },
  });
  guard.verifyNetworks(plan);
  for (const changed of [[], ids, [requiredNetworkValue(ids[1])]]) {
    endpoints = changed;
    expect(() => guard.verifyNetworks(plan)).toThrow(
      "Internet network must contain exactly its owned service container.",
    );
  }
  endpoints = [requiredNetworkValue(ids[0])];
  const app = requiredNetworkValue(containers[0]);
  for (const dns of [undefined, [], ["8.8.8.8"], ["10.240.0.17", "8.8.8.8"]]) {
    app.HostConfig.Dns = dns;
    expect(() => guard.verifyNetworks(plan)).toThrow(
      "Competition egress DNS must be exactly its segment gateway.",
    );
  }
  app.HostConfig.Dns = ["10.240.0.17"];
  guard.verifyNetworks(plan);
  wrongGateway = true;
  expect(() => guard.verifyNetworks(plan)).toThrow("default gateway");
  wrongGateway = false;
  const db = requiredNetworkValue(containers[1]);
  db.NetworkSettings.Networks[`${plan.project}_${segment.name}`] = {};
  expect(() => guard.verifyNetworks(plan)).toThrow("attachments changed");
  const forged = {
    ...plan,
    services: { ...plan.services, db: [...requiredNetworkValue(plan.services.db), segment.name] },
  };
  expect(() => guard.verifyNetworks(forged)).toThrow(
    "Internet network attachment belongs to another service.",
  );
});
/* eslint-enable sonarjs/no-hardcoded-ip */

test("foreign rules ahead of stopped hooks refuse both internal and egress plans without restores", () => {
  for (const plan of [undefined, egressPlan()]) {
    const f = fixture(plan);
    f.guard.install(f.plan);
    f.settings.networkExists = Boolean(plan);
    requiredNetworkValue(f.tables.get("iptables")?.get("DOCKER-USER")).unshift(
      "-A DOCKER-USER -i eth9 -j ACCEPT",
    );
    f.calls.length = 0;
    expect(() => f.guard.install(f.plan)).toThrow(
      "Competition guard no longer precedes other host rules.",
    );
    expect(f.calls.filter((call) => call.command.endsWith("-restore"))).toHaveLength(0);
  }
});

/* eslint-disable sonarjs/no-hardcoded-ip -- Synthetic inventory; no external connections. */
test("egress refuses unavailable host interface inventory", () => {
  const f = fixture(egressPlan());
  const io = Reflect.get(f.guard, "io");
  Reflect.set(io, "interfaces", undefined);
  expect(() => f.guard.assertInternetTargets(["8.8.8.8"])).toThrow(
    "Host interface inventory is unavailable for Internet access.",
  );
});

for (const ipv6 of [false, true])
  test(`egress refuses policy default routes in ${ipv6 ? "IPv6" : "IPv4"} while allocation keeps its existing route semantics`, () => {
    const f = fixture(egressPlan());
    const io = Reflect.get(f.guard, "io");
    const run = io.run;
    io.run = (call: { command: string; args: readonly string[] }) =>
      call.command === "ip" && call.args.includes("-6") === ipv6
        ? JSON.stringify([{ dst: "default", dev: "wg0", table: 51820 }])
        : run(call);
    expect(f.guard.occupiedRoutes()).toEqual(ipv6 ? ["192.168.1.0/24"] : []);
    expect(() => f.guard.assertInternetTargets(["8.8.8.8"])).toThrow(
      "Internet access refuses a default route outside the main routing table.",
    );
  });

for (const disappeared of [false, true])
  test(`egress bulk subnet inventory ${disappeared ? "retries a disappeared network" : "propagates inspect failures for existing networks"}`, () => {
    const f = fixture(egressPlan());
    const io = Reflect.get(f.guard, "io");
    const run = io.run;
    let listings = 0;
    const inspections: string[][] = [];
    io.run = (call: { command: string; args: readonly string[] }) => {
      if (call.command !== "docker" || call.args[0] !== "network") return run(call);
      if (call.args[1] === "ls") return ++listings === 1 || !disappeared ? "one\ntwo" : "two";
      if (call.args[1] === "inspect") {
        inspections.push([...call.args.slice(2)]);
        if (inspections.length === 1) throw new Error("Synthetic subnet inspection failure.");
        return JSON.stringify([{ IPAM: { Config: [{ Subnet: "10.250.0.0/24" }] } }]);
      }
      return run(call);
    };
    if (disappeared) {
      f.guard.assertInternetTargets(["8.8.8.8"]);
      expect(inspections).toEqual([["one", "two"], ["two"]]);
    } else {
      expect(() => f.guard.assertInternetTargets(["8.8.8.8"])).toThrow(
        "Synthetic subnet inspection failure.",
      );
      expect(inspections).toEqual([["one", "two"]]);
    }
    expect(listings).toBe(2);
  });

/* eslint-enable sonarjs/no-hardcoded-ip */
