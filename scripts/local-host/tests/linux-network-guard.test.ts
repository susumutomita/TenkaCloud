import { expect, test } from "bun:test";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan, requiredNetworkValue } from "../local-network";

// Pure command/ownership test adapter. It is not evidence of real packet enforcement.
function fixture() {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic allocation; pure command oracle never connects
  const plan = localNetworkPlan("tch-guard-test", { default: "10.240.0.0/28" });
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
  };
  function info(): string {
    return JSON.stringify({
      OSType: "linux",
      OperatingSystem: "Linux",
      ServerVersion: settings.version,
      SecurityOptions: settings.rootless ? ["name=rootless"] : ["name=seccomp"],
    });
  }
  const runningResult = () => (settings.running ? "owned-runtime" : "");
  function ensureDockerAvailable(): void {
    if (settings.daemonUnavailable) throw new Error("Synthetic Docker outage");
  }
  function dockerResult(call: { args: readonly string[] }): string {
    if (call.args[0] === "context") return settings.endpoint;
    if (call.args[0] === "info") return info();
    if (call.args[0] === "ps") return runningResult();
    if (call.args[1] === "ls") return settings.networkExists ? `${plan.project}_default` : "";
    if (call.args[1] === "inspect")
      return JSON.stringify([
        {
          Driver: "bridge",
          Internal: true,
          EnableIPv6: true,
          Options: {
            "com.docker.network.bridge.name": requiredNetworkValue(plan.segments[0]).bridge,
          },
          Labels: {
            "com.docker.compose.project": plan.project,
            "tenkacloud.isolation.owner": plan.owner,
          },
          IPAM: {
            Config: [
              { Subnet: requiredNetworkValue(plan.segments[0]).ipv4 },
              { Subnet: requiredNetworkValue(plan.segments[0]).ipv6 },
            ],
          },
          Containers: {},
        },
      ]);
    throw new Error("Unexpected Docker operation.");
  }
  const guard = new LinuxNetworkGuard({
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
        // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic route inventory, no connection
        return JSON.stringify([{ dst: "default" }, { dst: "192.168.1.0/24" }]);
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
  const expected = ["-A", chain, ...args.slice(2)].join(" ");
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
function applyRestore(table: Map<string, string[]>, input: string): void {
  for (const line of input.split("\n")) {
    if (line.startsWith(":")) table.set(requiredNetworkValue(line.slice(1).split(" ")[0]), []);
    else if (line.startsWith("-A "))
      requiredNetworkValue(table.get(requiredNetworkValue(line.split(" ")[1]))).push(line);
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
