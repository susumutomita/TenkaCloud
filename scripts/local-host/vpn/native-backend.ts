import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { LinuxNetworkGuard } from "../linux-network-guard";
import type { LocalNetworkPlan } from "../local-network";
import { HostError } from "../model";
import { withNetworkHookLock } from "../network-hook-lock";
import { vpnSealHook, workloadQuarantineHook } from "./firewall-scope";
import type { VpnForwardPolicy, VpnRuntimeAdmission } from "./forward-policy";
import { vpnForwardPolicy, vpnLeaseTimeout } from "./forward-policy";
import { assertVpnTeamPeer, type VpnPeerProof, vpnPeerProof } from "./peer-admission";
import {
  assertVpnHostDisjoint,
  type VpnHostNetwork,
  type VpnPeerInventory,
  type VpnPeerPlan,
} from "./peer-plan";

export interface VpnCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}
export interface VpnIngressIO {
  readonly run: (command: VpnCommand) => string;
  readonly platform: string;
  readonly root: boolean;
  readonly hasModule: (name: string) => boolean;
  readonly now: () => number;
  readonly routeReplies: (plan: LocalNetworkPlan, addresses: readonly string[]) => void;
}
const COMMAND_TIMEOUT_MS = 5000;
const nativeIO: VpnIngressIO = {
  platform: process.platform,
  root: process.getuid?.() === 0,
  now: Date.now,
  hasModule: (name) => existsSync(`/sys/module/${name}`),
  routeReplies: (plan, addresses) => new LinuxNetworkGuard().routeVpnReplies(plan, addresses),
  run: ({ command, args, input }) => {
    try {
      return execFileSync(command, [...args], {
        input,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error(`VPN ${command} operation failed; ingress closure must be verified.`);
    }
  },
};
/** This port never creates a host/interface route, key, forwarding sysctl or module.
 * Sealed preparation may install exact reply routes inside verified workload namespaces.
 */
export interface VpnIngress {
  readonly plan: VpnPeerPlan;
  seal(): void;
  validate(runtimes: readonly VpnRuntimeAdmission[], now: number): void;
  reconcile(runtimes: readonly VpnRuntimeAdmission[]): Promise<void>;
  authorize(socketAddress: string, authenticated: { eventId: string; teamId: string }): void;
}
export class NativeVpnBackend {
  private proof: VpnPeerProof | undefined;
  private readonly sets = new Set<string>();
  private readonly id: string;
  private readonly owner: string;
  private readonly inputChain: string;
  private readonly forwardChain: string;
  constructor(
    readonly plan: VpnPeerPlan,
    private readonly io: VpnIngressIO = nativeIO,
  ) {
    this.id = createHash("sha256").update(plan.generation).digest("hex").slice(0, 16);
    this.owner = `tc-vpn-seal-v1:${plan.generation}`;
    this.inputChain = `TCV_${this.id}_I`;
    this.forwardChain = `TCV_${this.id}_F`;
  }
  private run(command: string, args: readonly string[], input?: string): string {
    return this.io.run({ command, args, input });
  }
  private firewall(ipv6: boolean, args: readonly string[]): string {
    return this.run(ipv6 ? "ip6tables" : "iptables", ["--wait", "2", ...args]);
  }
  private lines(ipv6: boolean, parent: string): string[] {
    return this.firewall(ipv6, ["-S", parent])
      .split("\n")
      .filter((line) => line.startsWith("-A "))
      .map((line) => line.replace(/\/(?:32|128)(?=\s|$)/gu, ""));
  }
  private sealRules(): { parent: string; rule: string[] }[] {
    const tag = ["-m", "comment", "--comment", this.owner, "-j", "DROP"];
    return [
      { parent: "INPUT", rule: ["-i", this.plan.interface, ...tag] },
      { parent: "FORWARD", rule: ["-i", this.plan.interface, ...tag] },
      { parent: "FORWARD", rule: ["-o", this.plan.interface, ...tag] },
    ];
  }
  private assertSealModules(): void {
    const version = this.run("iptables", ["--version"]);
    const version6 = this.run("ip6tables", ["--version"]);
    const nft = version.includes("nf_tables");
    if (
      nft !== version6.includes("nf_tables") ||
      (!nft && (!version.includes("legacy") || !version6.includes("legacy")))
    )
      throw new Error("VPN requires matching nft or legacy firewall backends.");
    const modules = nft
      ? ["nf_tables", "nf_conntrack"]
      : ["ip_tables", "ip6_tables", "iptable_filter", "ip6table_filter", "xt_comment"];
    for (const name of modules)
      if (!this.io.hasModule(name))
        throw new Error(
          `VPN boot seal requires preloaded ${name}; configure it before interface activation.`,
        );
  }
  private insertSeal(ipv6: boolean, parent: string, rule: readonly string[]): void {
    const entries = this.lines(ipv6, parent).map((entry) => entry.replaceAll('"', ""));
    const position = entries.indexOf(`-A ${parent} ${rule.join(" ")}`);
    const before = position < 0 ? entries : entries.slice(0, position);
    if (
      position < 0 ||
      before.some((entry) => !vpnSealHook(entry) && !workloadQuarantineHook(entry))
    )
      this.firewall(ipv6, ["-I", parent, "1", ...rule]);
  }
  /** Synchronous emergency barrier: called before any lifecycle release, and retained on shutdown. */
  seal(): void {
    this.proof = undefined;
    withNetworkHookLock(() => this.sealLocked());
  }
  private sealLocked(): void {
    if (this.io.platform !== "linux" || !this.io.root)
      throw new Error("VPN ingress requires a dedicated native Linux root controller.");
    this.assertSealModules();
    const errors: unknown[] = [];
    for (const ipv6 of [false, true]) {
      for (const { parent, rule } of this.sealRules()) {
        try {
          this.insertSeal(ipv6, parent, rule);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "VPN seal could not be confirmed in both families.");
  }
  /** Closing packet admission does not invalidate an already verified peer identity.
   * Each terminal still rechecks its own workload; a failed seal never restores the proof. */
  suspend(): void {
    const identity = this.proof;
    this.seal();
    this.proof = identity;
  }
  private assertSealed(): void {
    for (const ipv6 of [false, true])
      for (const { parent, rule } of this.sealRules()) {
        const entries = this.lines(ipv6, parent).map((line) => line.replaceAll('"', ""));
        const position = entries.indexOf(`-A ${parent} ${rule.join(" ")}`);
        if (
          position < 0 ||
          entries
            .slice(0, position)
            .some((line) => !vpnSealHook(line) && !workloadQuarantineHook(line))
        )
          throw new Error("VPN worker requires an existing leading dual-stack seal.");
      }
  }
  private inventory(): VpnPeerInventory {
    const links = JSON.parse(
      this.run("ip", ["-j", "-d", "link", "show", "dev", this.plan.interface]),
    ) as { ifname: string; linkinfo?: { info_kind?: string } }[];
    if (
      links.length !== 1 ||
      links[0]?.ifname !== this.plan.interface ||
      links[0]?.linkinfo?.info_kind !== "wireguard"
    )
      throw new Error("VPN interface identity changed.");
    const addresses = JSON.parse(
      this.run("ip", ["-j", "address", "show", "dev", this.plan.interface]),
    ) as { addr_info?: { local: string; prefixlen: number }[] }[];
    const actualAddresses = addresses
      .flatMap((entry) => entry.addr_info ?? [])
      .map((entry) => `${entry.local}/${entry.prefixlen}`)
      .sort((left, right) => left.localeCompare(right));
    const expectedAddresses = [`${this.plan.serverIpv4}/32`, `${this.plan.serverIpv6}/128`].sort(
      (left, right) => left.localeCompare(right),
    );
    if (JSON.stringify(actualAddresses) !== JSON.stringify(expectedAddresses))
      throw new Error("VPN requires exact preconfigured server /32 and /128 identities.");
    // Never use `wg show dump` or private-key: those expose private material.
    const publicKey = this.run("wg", ["show", this.plan.interface, "public-key"]);
    const peers = this.run("wg", ["show", this.plan.interface, "allowed-ips"])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const fields = line.trim().split(/\s+/u);
        if (fields.length !== 3) throw new Error("Invalid public WireGuard inventory.");
        return { publicKey: fields[0] ?? "", allowedIps: fields.slice(1) };
      });
    return { interface: this.plan.interface, kind: "wireguard", publicKey, peers };
  }
  private hostNetworks(): VpnHostNetwork[] {
    const links = JSON.parse(this.run("ip", ["-j", "address", "show"])) as {
      ifname?: string;
      addr_info?: { local?: string; prefixlen?: number }[];
    }[];
    const routes = ["-4", "-6"].flatMap(
      (family) =>
        JSON.parse(this.run("ip", ["-j", family, "route", "show", "table", "all"])) as {
          dst?: string;
          dev?: string;
        }[],
    );
    return [
      ...links.flatMap((link) =>
        (link.addr_info ?? []).map((entry) => ({
          device: link.ifname,
          network: `${entry.local}/${entry.prefixlen}`,
        })),
      ),
      ...routes.map((route) => ({ device: route.dev, network: route.dst ?? "" })),
    ];
  }
  private assertModules(): void {
    for (const name of ["wireguard", "ip_set", "ip_set_hash_ip", "xt_set", "nf_conntrack"])
      if (!this.io.hasModule(name))
        throw new Error(
          `VPN requires preconfigured ${name}; automatic module loading is forbidden.`,
        );
  }
  private antiSpoof(ipv6: boolean): void {
    const addresses = this.plan.peers.map((peer) => (ipv6 ? peer.ipv6 : peer.ipv4));
    const additions: string[] = [];
    for (const parent of ["INPUT", "FORWARD"]) {
      const existing = this.lines(ipv6, parent).map((line) => line.replaceAll('"', ""));
      for (const address of addresses) {
        // Spelled in `iptables -S` order so the existing-rule check matches the listing.
        const rule = [
          "-s",
          address,
          "!",
          "-i",
          this.plan.interface,
          "-m",
          "comment",
          "--comment",
          this.owner,
          "-j",
          "DROP",
        ];
        if (!existing.includes(`-A ${parent} ${rule.join(" ")}`))
          additions.push(`-I ${parent} 1 ${rule.join(" ")}`);
      }
    }
    if (additions.length)
      this.run(
        ipv6 ? "ip6tables-restore" : "iptables-restore",
        ["--wait", "2", "--noflush"],
        ["*filter", ...additions, "COMMIT", ""].join("\n"),
      );
  }
  /** Creation and the ownership marker share one restore transaction, and precede every lease set. */
  private claimChains(): void {
    const owner = `tc-vpn-v1:${this.plan.generation}`;
    for (const ipv6 of [false, true]) {
      const all = this.firewall(ipv6, ["-S"]).split("\n");
      const missing = [this.inputChain, this.forwardChain].filter((chain) => {
        if (!all.includes(`-N ${chain}`)) return true;
        if (!all.some((line) => line.startsWith(`-A ${chain} `) && line.includes(owner)))
          throw new Error("Refusing to adopt an unowned VPN chain.");
        return false;
      });
      if (missing.length)
        this.run(
          ipv6 ? "ip6tables-restore" : "iptables-restore",
          ["--wait", "2", "--noflush"],
          [
            "*filter",
            ...missing.flatMap((chain) => [
              `:${chain} - [0:0]`,
              `-A ${chain} -m comment --comment ${owner}`,
            ]),
            "COMMIT",
            "",
          ].join("\n"),
        );
    }
  }
  private restore(
    ipv6: boolean,
    parent: string,
    chain: string,
    rules: readonly (readonly string[])[],
    directions: readonly string[],
  ): void {
    const owner = `tc-vpn-v1:${this.plan.generation}`;
    const body = [
      "*filter",
      `-F ${chain}`,
      `-A ${chain} -m comment --comment ${owner}`,
      ...rules.map((rule) => `-A ${chain} ${rule.join(" ")}`),
      "COMMIT",
      "",
    ].join("\n");
    this.run(ipv6 ? "ip6tables-restore" : "iptables-restore", ["--wait", "2", "--noflush"], body);
    for (const direction of directions) {
      const rule = [direction, this.plan.interface, "-j", chain];
      if (this.lines(ipv6, parent).includes(`-A ${parent} ${rule.join(" ")}`))
        this.firewall(ipv6, ["-D", parent, ...rule]);
      // Seal remains first in INPUT/FORWARD until the entire policy is installed.
      const entries = this.lines(ipv6, parent);
      const firstOther = entries.findIndex(
        (line) => !workloadQuarantineHook(line) && !vpnSealHook(line),
      );
      const prefix = firstOther < 0 ? entries.length : firstOther;
      if (entries.slice(prefix).some((line) => workloadQuarantineHook(line) || vpnSealHook(line)))
        throw new Error("VPN quarantine ordering changed.");
      this.firewall(ipv6, ["-I", parent, String(prefix + 1), ...rule]);
    }
  }
  private assertPreparedHooks(): void {
    const admission = (ipv6: boolean, parent: string) =>
      this.lines(ipv6, parent).filter(
        (line) => !vpnSealHook(line) && !workloadQuarantineHook(line),
      );
    if (admission(false, "FORWARD")[0] !== "-A FORWARD -j DOCKER-USER")
      throw new Error("VPN requires Docker's first forwarding admission hook.");
    for (const ipv6 of [false, true]) {
      const input = admission(ipv6, "INPUT");
      if (input[0] !== `-A INPUT -i ${this.plan.interface} -j ${this.inputChain}`)
        throw new Error("VPN input admission hook was displaced.");
      const parent = ipv6 ? "FORWARD" : "DOCKER-USER";
      const prefix = admission(ipv6, parent).slice(0, 2);
      for (const direction of ["-i", "-o"])
        if (
          !prefix.includes(
            `-A ${parent} ${direction} ${this.plan.interface} -j ${this.forwardChain}`,
          )
        )
          throw new Error("VPN forwarding admission hook was displaced.");
    }
  }
  private chainSetNames(all: string, chain: string): string[] {
    const entries = all.split("\n").filter((line) => line.startsWith(`-A ${chain} `));
    if (!entries.length) return [];
    if (!entries.some((line) => line.includes(`tc-vpn-v1:${this.plan.generation}`)))
      throw new Error("Refusing unowned retained VPN sets.");
    return entries.flatMap((entry) =>
      [...entry.matchAll(/--match-set (TCV_[a-f0-9]{16}_P?[46]) /gu)].map(
        (match) => match[1] ?? "",
      ),
    );
  }
  private retainedSetNames(): Set<string> {
    return new Set(
      [false, true].flatMap((ipv6) => {
        const all = this.firewall(ipv6, ["-S"]);
        return [this.inputChain, this.forwardChain].flatMap((chain) =>
          this.chainSetNames(all, chain),
        );
      }),
    );
  }
  private adoptSet(name: string, ipv6: boolean): boolean {
    const names = this.run("ipset", ["list", "-name"]).split("\n");
    if (!names.includes(name)) return false;
    const owner = `tc-vpn-v1:${this.plan.generation}`;
    for (const family of [false, true])
      for (const chain of [this.inputChain, this.forwardChain]) {
        if (!this.firewall(family, ["-S", chain]).includes(owner))
          throw new Error("Cannot adopt a VPN lease without both owned firewall families.");
      }
    const header = this.run("ipset", ["list", name, "-terse"]);
    if (
      !header.split("\n").includes("Type: hash:ip") ||
      !new RegExp(`\\bfamily ${ipv6 ? "inet6" : "inet"}\\b`, "u").test(header) ||
      !/\btimeout 1\b/u.test(header) ||
      !/\bmaxelem 100\b/u.test(header)
    )
      throw new Error("Refusing changed VPN lease set parameters.");
    this.run("ipset", ["flush", name]);
    return true;
  }
  private ensureSet(name: string, ipv6: boolean): void {
    if (this.sets.has(name)) return;
    if (!this.adoptSet(name, ipv6))
      this.run("ipset", [
        "create",
        name,
        "hash:ip",
        "family",
        ipv6 ? "inet6" : "inet",
        "timeout",
        "1",
        "maxelem",
        "100",
      ]);
    this.sets.add(name);
  }
  private installSets(policy: VpnForwardPolicy): void {
    for (const name of this.sets) this.run("ipset", ["flush", name]);
    for (const lease of policy.leases) {
      this.ensureSet(lease.name, lease.ipv6);
      for (const address of lease.addresses) {
        // Reserve a full command deadline; delayed execution cannot extend the absolute proof.
        const timeout = vpnLeaseTimeout(lease, this.io.now() + COMMAND_TIMEOUT_MS);
        if (timeout !== undefined)
          this.run("ipset", ["add", lease.name, address, "timeout", String(timeout), "-exist"]);
      }
    }
  }
  private inputRules(
    runtimes: readonly VpnRuntimeAdmission[],
    policy: VpnForwardPolicy,
    ipv6: boolean,
  ): string[][] {
    const server = ipv6 ? this.plan.serverIpv6 : this.plan.serverIpv4;
    const rules = this.plan.peers.map((peer) => [
      "-s",
      ipv6 ? peer.ipv6 : peer.ipv4,
      "-d",
      server,
      "-p",
      "tcp",
      "--dport",
      String(this.plan.participantPort),
      "-m",
      "conntrack",
      "--ctorigdst",
      server,
      "--ctorigdstport",
      String(this.plan.participantPort),
      "-m",
      "set",
      "--match-set",
      `TCV_${this.id}_P${ipv6 ? 6 : 4}`,
      "src",
      "-j",
      "ACCEPT",
    ]);
    for (const runtime of runtimes) {
      if (runtime.gatewayPort === undefined) continue;
      if (
        !Number.isInteger(runtime.gatewayPort) ||
        runtime.gatewayPort < 1024 ||
        runtime.gatewayPort > 65535 ||
        runtime.gatewayPort === this.plan.participantPort
      )
        throw new Error("Invalid owned VPN gateway port.");
      const lease = policy.leases.find(
        (entry) =>
          entry.ipv6 === ipv6 &&
          entry.owners.length === 1 &&
          entry.owners[0] === runtime.plan.owner,
      );
      if (!lease) continue;
      for (const address of lease.addresses)
        rules.push([
          "-s",
          address,
          "-d",
          server,
          "-p",
          "tcp",
          "--dport",
          String(runtime.gatewayPort),
          "-m",
          "conntrack",
          "--ctorigdst",
          server,
          "--ctorigdstport",
          String(runtime.gatewayPort),
          "-m",
          "set",
          "--match-set",
          lease.name,
          "src",
          "-j",
          "ACCEPT",
        ]);
    }
    return [...rules, ["-j", "DROP"]];
  }
  /** Reconcile always seals first. Any partial failure retains the dual-stack emergency drops. */
  prepare(runtimes: readonly VpnRuntimeAdmission[]): VpnPeerProof {
    this.assertSealed();
    this.assertModules();
    const sealUnit = `tenkacloud-vpn-seal@${this.plan.interface}.service`;
    const dependencies = this.run("systemctl", [
      "show",
      `wg-quick@${this.plan.interface}.service`,
      "--property=Requires",
      "--value",
    ]).split(/\s+/u);
    const order = this.run("systemctl", [
      "show",
      `wg-quick@${this.plan.interface}.service`,
      "--property=After",
      "--value",
    ]).split(/\s+/u);
    if (
      !dependencies.includes(sealUnit) ||
      !order.includes(sealUnit) ||
      this.run("systemctl", ["is-active", sealUnit]) !== "active"
    )
      throw new Error("WireGuard must require an active boot seal before activation.");
    assertVpnHostDisjoint(this.plan, this.hostNetworks());
    const retainedSets = this.retainedSetNames();
    const proof = vpnPeerProof(this.plan, this.inventory(), this.io.now());
    const compiled = vpnForwardPolicy(this.plan, runtimes, this.io.now());
    const portalLeases = [false, true].map((ipv6) => ({
      name: `TCV_${this.id}_P${ipv6 ? 6 : 4}`,
      owners: Object.freeze([`tc-vpn-v1:${this.plan.generation}`]),
      addresses: Object.freeze(this.plan.peers.map((peer) => (ipv6 ? peer.ipv6 : peer.ipv4))),
      ipv6,
      expiresAt: proof.verifiedAt + 60_000,
    }));
    const policy = {
      ...compiled,
      leases: [
        ...compiled.leases.map((lease) => ({
          ...lease,
          expiresAt: Math.min(lease.expiresAt, proof.verifiedAt + 60_000),
        })),
        ...portalLeases,
      ],
    };
    this.claimChains();
    this.installSets(policy);
    for (const runtime of runtimes) {
      const addresses = [
        ...new Set(
          compiled.leases
            .filter((lease) => lease.owners.includes(runtime.plan.owner))
            .flatMap((lease) => lease.addresses),
        ),
      ];
      this.io.routeReplies(runtime.plan, addresses);
    }
    withNetworkHookLock(() => {
      for (const ipv6 of [false, true]) {
        this.antiSpoof(ipv6);
        this.restore(
          ipv6,
          ipv6 ? "FORWARD" : "DOCKER-USER",
          this.forwardChain,
          ipv6 ? policy.ipv6 : policy.ipv4,
          ["-i", "-o"],
        );
        this.restore(ipv6, "INPUT", this.inputChain, this.inputRules(runtimes, policy, ipv6), [
          "-i",
        ]);
      }
      this.assertPreparedHooks();
    });
    const currentNames = new Set(policy.leases.map((lease) => lease.name));
    for (const name of new Set([...this.sets, ...retainedSets]))
      if (!currentNames.has(name)) {
        this.run("ipset", ["destroy", name]);
        this.sets.delete(name);
      }
    vpnPeerProof(this.plan, this.inventory(), this.io.now());
    if (this.io.now() < proof.verifiedAt || this.io.now() - proof.verifiedAt >= 60_000)
      throw new Error("VPN installation outlived its identity proof.");
    return proof;
  }
  /** Another registration's seals on this interface; the current hooks already lead and end in DROP. */
  private removeRetiredSeals(): void {
    for (const ipv6 of [false, true])
      for (const parent of ["INPUT", "FORWARD"])
        for (const line of this.lines(ipv6, parent)) {
          const rule = line.replaceAll('"', "");
          if (
            vpnSealHook(rule) &&
            !rule.includes(`--comment ${this.owner} `) &&
            rule.split(" ").includes(this.plan.interface)
          )
            this.firewall(ipv6, ["-D", parent, ...rule.split(" ").slice(2)]);
        }
  }
  commit(proof: VpnPeerProof): void {
    withNetworkHookLock(() => this.commitLocked(proof));
  }
  private commitLocked(proof: VpnPeerProof): void {
    if (proof.generation !== this.plan.generation)
      throw new Error("VPN prepared generation changed.");
    if (this.io.now() < proof.verifiedAt || this.io.now() - proof.verifiedAt >= 60_000)
      throw new Error("VPN staged proof expired.");
    try {
      this.removeRetiredSeals();
      for (const ipv6 of [false, true])
        for (const { parent, rule } of this.sealRules())
          while (
            this.lines(ipv6, parent).some(
              (line) => line.replaceAll('"', "") === `-A ${parent} ${rule.join(" ")}`,
            )
          )
            this.firewall(ipv6, ["-D", parent, ...rule]);
    } catch (error) {
      this.seal();
      throw error;
    }
    this.proof = proof;
  }
  authorize(socketAddress: string, authenticated: { eventId: string; teamId: string }): void {
    try {
      assertVpnTeamPeer(this.plan, this.proof, socketAddress, authenticated, this.io.now());
    } catch {
      throw new HostError(
        403,
        "VPN peer is not admitted for this event/team. Ask the organizer to verify the public peer registration.",
        "vpn_peer_not_admitted",
      );
    }
  }
}
