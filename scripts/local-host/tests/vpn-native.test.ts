/* eslint-disable sonarjs/no-hardcoded-ip -- No network operations: fake command port captures policy writes. */
import { expect, test } from "bun:test";
import { NativeVpnBackend, type VpnCommand, type VpnIngressIO } from "../vpn/native-backend";
import { vpnPeerPlan } from "../vpn/peer-plan";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const plan = vpnPeerPlan({
  version: 1,
  interface: "tcwg0",
  serverPublicKey: key(1),
  serverIpv4: "10.251.0.1",
  serverIpv6: "fd55::1",
  participantPort: 5175,
  peers: [
    { publicKey: key(2), eventId: "event", teamId: "alpha", ipv4: "10.251.0.2", ipv6: "fd55::2" },
  ],
});
type Table = Map<string, string[]>;
class FakeKernel {
  readonly calls: VpnCommand[] = [];
  readonly tables = new Map<string, Table>();
  readonly sets = new Map<string, string>();
  failure = "";
  constructor() {
    for (const command of ["iptables", "ip6tables"])
      this.tables.set(
        command,
        new Map(["INPUT", "FORWARD", "DOCKER-USER"].map((chain) => [chain, []])),
      );
    this.tables.get("iptables")?.set("FORWARD", ["-A FORWARD -j DOCKER-USER"]);
  }
  private table(command: string): Table {
    const table = this.tables.get(command);
    if (!table) throw new Error(`Unexpected command ${command}`);
    return table;
  }
  private inventory(command: string, args: readonly string[]): string | undefined {
    if (command === "ip")
      return args.includes("address")
        ? JSON.stringify([
            {
              addr_info: [
                { local: plan.serverIpv4, prefixlen: 32 },
                { local: plan.serverIpv6, prefixlen: 128 },
              ],
            },
          ])
        : JSON.stringify([{ ifname: plan.interface, linkinfo: { info_kind: "wireguard" } }]);
    if (command === "wg")
      return args.includes("public-key")
        ? plan.serverPublicKey
        : `${key(2)}\t10.251.0.2/32 fd55::2/128`;
    if (command === "systemctl")
      return args.includes("is-active") ? "active" : "tenkacloud-vpn-seal@tcwg0.service";
    return undefined;
  }
  private ipset(args: readonly string[]): string {
    const name = args[1] ?? "";
    if (args[0] === "create") {
      if (this.sets.has(name)) throw new Error("Existing set");
      this.sets.set(name, args[4] ?? "");
    }
    if (args[0] === "list" && name === "-name") return [...this.sets.keys()].join("\n");
    if (args[0] === "list")
      return `Type: hash:ip\nHeader: family ${this.sets.get(name)} timeout 1 maxelem 100`;
    if (args[0] === "destroy") this.sets.delete(name);
    return "";
  }
  private restore(command: string, input: string): string {
    const table = this.table(command.replace("-restore", ""));
    for (const line of input.split("\n")) {
      const parts = line.split(" ");
      const chain = parts[1] ?? "";
      if (parts[0] === "-F") table.set(chain, []);
      if (parts[0] === "-A") table.get(chain)?.push(line);
      if (parts[0] === "-I")
        table
          .get(chain)
          ?.splice(Number(parts[2]) - 1, 0, `-A ${chain} ${parts.slice(3).join(" ")}`);
    }
    return "";
  }
  private mutation(table: Table, verb: string, chain: string, args: string[]): void {
    if (verb === "-N") {
      table.set(chain, []);
      return;
    }
    const rules = table.get(chain);
    if (!rules) throw new Error("Unknown fake chain");
    if (verb === "-I") {
      const position = Number(args.shift());
      rules.splice(position - 1, 0, `-A ${chain} ${args.join(" ")}`);
      return;
    }
    if (verb !== "-D" || /^\d+$/u.test(args[0] ?? ""))
      throw new Error("Only exact owned rule deletion is allowed");
    const position = rules.indexOf(`-A ${chain} ${args.join(" ")}`);
    if (position < 0) throw new Error("Absent fake rule");
    rules.splice(position, 1);
  }
  run(call: VpnCommand): string {
    this.calls.push(call);
    if (call.command === this.failure) throw new Error("Injected native failure");
    const args = [...call.args];
    if (args[0] === "--version") return "iptables v1.8.11 (nf_tables)";
    const inventory = this.inventory(call.command, args);
    if (inventory !== undefined) return inventory;
    if (call.command === "ipset") return this.ipset(args);
    if (call.command.endsWith("-restore")) return this.restore(call.command, call.input ?? "");
    const table = this.table(call.command);
    args.splice(0, 2);
    const verb = args.shift() ?? "";
    const chain = args.shift();
    if (verb === "-S")
      return chain
        ? [`-N ${chain}`, ...(table.get(chain) ?? [])].join("\n")
        : [...table].flatMap(([name, rules]) => [`-N ${name}`, ...rules]).join("\n");
    if (!chain) throw new Error("Missing fake chain");
    this.mutation(table, verb, chain, args);
    return "";
  }
  sealed(): boolean {
    for (const table of this.tables.values())
      for (const chain of ["INPUT", "FORWARD"]) {
        if (
          !table
            .get(chain)
            ?.some(
              (rule) =>
                rule.includes("tc-vpn-seal-v1:") && !rule.includes(" -s ") && rule.endsWith("DROP"),
            )
        )
          return false;
      }
    return true;
  }
}
function fixture() {
  const kernel = new FakeKernel();
  const io: VpnIngressIO = {
    platform: "linux",
    root: true,
    now: () => 1000,
    hasModule: () => true,
    routeReplies: () => undefined,
    run: (call) => kernel.run(call),
  };
  return {
    ingress: new NativeVpnBackend(plan, io),
    io,
    calls: kernel.calls,
    tables: kernel.tables,
    sealed: () => kernel.sealed(),
    fail: (command: string) => {
      kernel.failure = command;
    },
  };
}
test("native ingress has no side effects on construction and boot seal is idempotent", () => {
  const f = fixture();
  expect(f.calls).toHaveLength(0);
  f.ingress.seal();
  f.ingress.seal();
  expect(f.sealed()).toBe(true);
  for (const table of f.tables.values())
    expect(table.get("FORWARD")?.filter((line) => line.includes("tc-vpn-seal-v1:"))).toHaveLength(
      2,
    );
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" })).toThrow();
});
test("empty runtime recovery admits only registered portal traffic with finite kernel leases", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  expect(f.sealed()).toBe(false);
  expect(() =>
    f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" }),
  ).not.toThrow();
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "beta" })).toThrow();
  const adds = f.calls.filter((call) => call.command === "ipset" && call.args[0] === "add");
  expect(adds).toHaveLength(2);
  for (const add of adds) expect(add.args.slice(-3)).toEqual(["timeout", "55", "-exist"]);
  const restores = f.calls.filter((call) => call.command.endsWith("-restore"));
  expect(
    restores.filter(
      (call) => call.input?.includes("--dport 5175") && call.input.includes("--match-set"),
    ),
  ).toHaveLength(2);
  expect(
    restores.filter((call) => call.input?.includes("_F ") && call.input.includes("ACCEPT")),
  ).toHaveLength(0);
});
test("partial IPv6 install failure retains dual-stack seal and rejects application identity", () => {
  const f = fixture();
  f.ingress.seal();
  f.fail("ip6tables-restore");
  expect(() => f.ingress.commit(f.ingress.prepare([]))).toThrow();
  expect(f.sealed()).toBe(true);
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" })).toThrow();
});
test("restarted controller stays closed until owned types are verified and old grants are discarded", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  const restarted = new NativeVpnBackend(plan, f.io);
  restarted.seal();
  expect(f.sealed()).toBe(true);
  restarted.commit(restarted.prepare([]));
  expect(f.sealed()).toBe(false);
  expect(
    f.calls.filter((call) => call.command === "ipset" && call.args[0] === "flush"),
  ).toHaveLength(2);
});

test("packet suspension preserves verified peer identity so periodic audit does not close healthy terminals", () => {
  const f = fixture();
  f.ingress.seal();
  f.ingress.commit(f.ingress.prepare([]));
  f.ingress.suspend();
  expect(f.sealed()).toBe(true);
  expect(() =>
    f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" }),
  ).not.toThrow();
  f.ingress.seal();
  expect(() => f.ingress.authorize("10.251.0.2", { eventId: "event", teamId: "alpha" })).toThrow();
});

test("a quarantine-looking ACCEPT comment cannot remain ahead of the emergency seal", () => {
  for (const family of ["iptables", "ip6tables"]) {
    const f = fixture();
    f.ingress.seal();
    f.tables
      .get(family)
      ?.get("INPUT")
      ?.unshift(`-A INPUT -m comment --comment tc-quarantine-v1:${"a".repeat(64)} -j ACCEPT`);
    f.ingress.seal();
    expect(f.tables.get(family)?.get("INPUT")?.[0]).toContain("-i tcwg0");
    expect(f.tables.get(family)?.get("INPUT")?.[0]).toEndWith("-j DROP");
  }
});

test("preparation rejects admission displaced by a forged closure comment before any mutation", () => {
  for (const marker of ["tc-quarantine-v1:", "tc-vpn-seal-v1:"]) {
    const f = fixture();
    f.ingress.seal();
    f.tables
      .get("iptables")
      ?.get("INPUT")
      ?.unshift(`-A INPUT -m comment --comment ${marker}${"a".repeat(64)} -j ACCEPT`);
    const before = f.calls.length;
    expect(() => f.ingress.prepare([])).toThrow("leading dual-stack seal");
    expect(f.calls.slice(before).every((call) => call.args.includes("-S"))).toBe(true);
  }
});
