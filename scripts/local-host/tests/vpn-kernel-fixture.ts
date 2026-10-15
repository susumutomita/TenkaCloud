/* eslint-disable sonarjs/no-hardcoded-ip -- No network operations: fake command port captures policy writes. */
import type { LocalNetworkPlan } from "../local-network";
import { NativeVpnBackend, type VpnCommand, type VpnIngressIO } from "../vpn/native-backend";
import { type VpnPeerPlan, vpnPeerPlan } from "../vpn/peer-plan";

export const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
export const registration = {
  version: 1,
  interface: "tcwg0",
  serverPublicKey: key(1),
  serverIpv4: "10.251.0.1",
  serverIpv6: "fd55::1",
  participantPort: 5175,
  peers: [
    { publicKey: key(2), eventId: "event", teamId: "alpha", ipv4: "10.251.0.2", ipv6: "fd55::2" },
  ],
};
export const plan = vpnPeerPlan(registration);

type Table = Map<string, string[]>;
interface FakeLink {
  readonly ifname: string;
  readonly kind?: string;
  readonly addresses: string[];
}
interface FakeRoute {
  readonly dst: string;
  readonly dev?: string;
  readonly type?: string;
  readonly gateway?: string;
}
export class FakeKernel {
  readonly calls: VpnCommand[] = [];
  readonly tables = new Map<string, Table>();
  readonly sets = new Map<string, string>();
  readonly links: FakeLink[];
  readonly routes: { 4: FakeRoute[]; 6: FakeRoute[] };
  failure: (call: VpnCommand) => boolean = () => false;
  constructor(private readonly config: VpnPeerPlan) {
    for (const command of ["iptables", "ip6tables"])
      this.tables.set(
        command,
        new Map(["INPUT", "FORWARD", "DOCKER-USER"].map((chain) => [chain, []])),
      );
    this.tables.get("iptables")?.set("FORWARD", ["-A FORWARD -j DOCKER-USER"]);
    const wg = config.interface;
    this.links = [
      { ifname: "lo", addresses: ["127.0.0.1/8", "::1/128"] },
      { ifname: "eth0", addresses: ["192.168.1.10/24", "fe80::10/64"] },
      {
        ifname: wg,
        kind: "wireguard",
        addresses: [`${config.serverIpv4}/32`, `${config.serverIpv6}/128`],
      },
    ];
    this.routes = {
      4: [
        { dst: "default", gateway: "192.168.1.1", dev: "eth0" },
        { dst: "192.168.1.0/24", dev: "eth0" },
        ...config.peers.map((peer) => ({ dst: peer.ipv4, dev: wg })),
        { type: "local", dst: "127.0.0.0/8", dev: "lo" },
        { type: "local", dst: "192.168.1.10", dev: "eth0" },
        { type: "broadcast", dst: "192.168.1.255", dev: "eth0" },
        { type: "local", dst: config.serverIpv4, dev: wg },
      ],
      6: [
        { dst: "default", gateway: "fe80::1", dev: "eth0" },
        { dst: "fe80::/64", dev: "eth0" },
        ...config.peers.map((peer) => ({ dst: peer.ipv6, dev: wg })),
        { type: "local", dst: "::1", dev: "lo" },
        { type: "local", dst: config.serverIpv6, dev: wg },
        { type: "multicast", dst: "ff00::/8", dev: "eth0" },
      ],
    };
  }
  private table(command: string): Table {
    const table = this.tables.get(command);
    if (!table) throw new Error(`Unexpected command ${command}`);
    return table;
  }
  private ip(args: readonly string[]): string {
    if (args.includes("route")) return JSON.stringify(this.routes[args.includes("-6") ? 6 : 4]);
    const device = args.includes("dev") ? args[args.indexOf("dev") + 1] : undefined;
    const links = this.links.filter((link) => device === undefined || link.ifname === device);
    if (!links.length) throw new Error("Fake device does not exist");
    if (args.includes("link"))
      return JSON.stringify(
        links.map((link) => ({ ifname: link.ifname, linkinfo: { info_kind: link.kind } })),
      );
    return JSON.stringify(
      links.map((link) => ({
        ifname: link.ifname,
        addr_info: link.addresses.map((cidr) => {
          const [local = "", prefix] = cidr.split("/");
          return {
            family: local.includes(":") ? "inet6" : "inet",
            local,
            prefixlen: Number(prefix),
          };
        }),
      })),
    );
  }
  private inventory(command: string, args: readonly string[]): string | undefined {
    if (command === "ip") return this.ip(args);
    if (command === "wg")
      return args.includes("public-key")
        ? this.config.serverPublicKey
        : this.config.peers
            .map((peer) => `${peer.publicKey}\t${peer.ipv4}/32 ${peer.ipv6}/128`)
            .join("\n");
    if (command === "systemctl")
      return args.includes("is-active")
        ? "active"
        : `tenkacloud-vpn-seal@${this.config.interface}.service`;
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
  /** iptables-restore commits the whole table or nothing; `:CHAIN` creates or flushes under --noflush. */
  private restore(command: string, input: string): string {
    const family = command.replace("-restore", "");
    const staged: Table = new Map(
      [...this.table(family)].map(([chain, rules]) => [chain, [...rules]]),
    );
    for (const line of input.split("\n")) {
      const parts = line.split(" ");
      const verb = parts[0] ?? "";
      if (verb.startsWith(":")) {
        staged.set(verb.slice(1), []);
        continue;
      }
      if (!["-F", "-A", "-I"].includes(verb)) continue;
      const chain = parts[1] ?? "";
      const rules = staged.get(chain);
      if (!rules) throw new Error("Fake restore references a missing chain");
      if (verb === "-F") rules.length = 0;
      if (verb === "-A") rules.push(line);
      if (verb === "-I")
        rules.splice(Number(parts[2]) - 1, 0, `-A ${chain} ${parts.slice(3).join(" ")}`);
    }
    this.tables.set(family, staged);
    return "";
  }
  private mutation(table: Table, verb: string, chain: string, args: string[]): void {
    if (verb === "-N") {
      if (table.has(chain)) throw new Error("Fake chain already exists");
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
    if (this.failure(call)) throw new Error("Injected native failure");
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
    if (verb === "-S") {
      if (!chain) return [...table].flatMap(([name, rules]) => [`-N ${name}`, ...rules]).join("\n");
      const rules = table.get(chain);
      if (!rules) throw new Error("Fake chain does not exist");
      return [`-N ${chain}`, ...rules].join("\n");
    }
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
export function fixture(config: VpnPeerPlan = plan) {
  const kernel = new FakeKernel(config);
  const replies: { plan: LocalNetworkPlan; addresses: readonly string[] }[] = [];
  const io: VpnIngressIO = {
    platform: "linux",
    root: true,
    now: () => 1000,
    hasModule: () => true,
    routeReplies: (network, addresses) => {
      replies.push({ plan: network, addresses });
    },
    run: (call) => kernel.run(call),
  };
  return {
    kernel,
    ingress: new NativeVpnBackend(config, io),
    backend: (next: VpnPeerPlan = config) => new NativeVpnBackend(next, io),
    io,
    replies,
    calls: kernel.calls,
    tables: kernel.tables,
    sealed: () => kernel.sealed(),
    fail: (failure: string | ((call: VpnCommand) => boolean)) => {
      kernel.failure = typeof failure === "string" ? (call) => call.command === failure : failure;
    },
  };
}
