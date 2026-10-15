import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { LocalNetworkPlan, LocalNetworkSegment } from "../local-network";
import { segmentGateway } from "../local-network";
import type { VpnPeer, VpnPeerPlan } from "./peer-plan";

export interface VpnRuntimeAdmission {
  readonly jobId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly plan: LocalNetworkPlan;
  readonly unitGeneration: string;
  readonly verifiedAt: number;
  readonly gatewayPort?: number;
}
export interface VpnAdmissionLease {
  readonly name: string;
  readonly owners: readonly string[];
  readonly addresses: readonly string[];
  readonly ipv6: boolean;
  readonly expiresAt: number;
}
export interface VpnForwardPolicy {
  readonly owner: string;
  readonly ipv4: readonly (readonly string[])[];
  readonly ipv6: readonly (readonly string[])[];
  readonly leases: readonly VpnAdmissionLease[];
}
type Rule = readonly string[];
const PROOF_MILLISECONDS = 60_000;
const RULE_LIMIT = 2048;
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function subnet(segment: LocalNetworkSegment, ipv6: boolean): string {
  return ipv6 ? segment.ipv6 : segment.ipv4;
}
function peerAddress(peer: VpnPeer, ipv6: boolean): string {
  return ipv6 ? peer.ipv6 : peer.ipv4;
}
function inSubnet(address: string, cidr: string): boolean {
  const [base, prefix] = cidr.split("/");
  if (!base || prefix === undefined) throw new Error("Invalid owned VPN destination subnet.");
  const block = new BlockList();
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  block.addSubnet(base, Number(prefix), family);
  return block.check(address, family);
}
function activeAdmissions(
  runtimes: readonly VpnRuntimeAdmission[],
  now: number,
): VpnRuntimeAdmission[] {
  if (runtimes.length > 40 || !Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid bounded VPN admission snapshot.");
  const projects = new Set<string>();
  for (const runtime of runtimes) {
    if (
      runtime.plan.project !== `tch-${runtime.jobId.toLowerCase()}` ||
      runtime.plan.eventId !== runtime.eventId ||
      runtime.unitGeneration !== runtime.plan.generation ||
      !/^tc-isolation-v1:[a-f0-9]{64}$/u.test(runtime.plan.owner) ||
      !Number.isSafeInteger(runtime.verifiedAt) ||
      runtime.verifiedAt > now ||
      projects.has(runtime.plan.project)
    )
      throw new Error("VPN runtime ownership or generation changed.");
    projects.add(runtime.plan.project);
  }
  return runtimes.filter((runtime) => now - runtime.verifiedAt < PROOF_MILLISECONDS);
}
function assertDisjointPeers(config: VpnPeerPlan, runtimes: readonly VpnRuntimeAdmission[]): void {
  const addresses = [
    config.serverIpv4,
    config.serverIpv6,
    ...config.peers.flatMap((peer) => [peer.ipv4, peer.ipv6]),
  ];
  for (const runtime of runtimes)
    for (const segment of runtime.plan.segments)
      for (const address of addresses)
        if (inSubnet(address, subnet(segment, isIP(address) === 6)))
          throw new Error("VPN overlay overlaps an owned workload network.");
}
interface RuleTarget {
  readonly bridge: string;
  readonly destination: string;
  readonly port?: number;
}
function flowRules(
  config: VpnPeerPlan,
  peer: VpnPeer,
  lease: VpnAdmissionLease,
  target: RuleTarget,
): Rule[] {
  const address = peerAddress(peer, lease.ipv6);
  const tcp = target.port === undefined ? [] : ["-p", "tcp"];
  const originalPort = target.port === undefined ? [] : ["--ctorigdstport", String(target.port)];
  const common = [
    "-m",
    "conntrack",
    "--ctorigsrc",
    address,
    "--ctorigdst",
    target.destination,
    ...originalPort,
  ];
  return [
    [
      "-i",
      config.interface,
      "-o",
      target.bridge,
      "-s",
      address,
      "-d",
      target.destination,
      ...tcp,
      ...(target.port === undefined ? [] : ["--dport", String(target.port)]),
      ...common,
      "--ctdir",
      "ORIGINAL",
      "-m",
      "set",
      "--match-set",
      lease.name,
      "src",
      "-j",
      "ACCEPT",
    ],
    [
      "-i",
      target.bridge,
      "-o",
      config.interface,
      "-s",
      target.destination,
      "-d",
      address,
      ...tcp,
      ...(target.port === undefined ? [] : ["--sport", String(target.port)]),
      ...common,
      "--ctdir",
      "REPLY",
      "--ctstate",
      "ESTABLISHED",
      "-m",
      "set",
      "--match-set",
      lease.name,
      "dst",
      "-j",
      "ACCEPT",
    ],
  ];
}
class PolicyCompiler {
  readonly leases = new Map<string, VpnAdmissionLease>();
  constructor(
    private readonly config: VpnPeerPlan,
    private readonly active: readonly VpnRuntimeAdmission[],
    private readonly now: number,
  ) {}
  private leaseFor(
    source: VpnRuntimeAdmission,
    target: VpnRuntimeAdmission,
    peers: readonly VpnPeer[],
    ipv6: boolean,
  ): VpnAdmissionLease | undefined {
    const expiresAt = Math.min(source.verifiedAt, target.verifiedAt) + PROOF_MILLISECONDS;
    if (Math.floor((expiresAt - this.now) / 1000) < 1) return undefined;
    const owners = [...new Set([source.plan.owner, target.plan.owner])].sort((left, right) =>
      left.localeCompare(right),
    );
    const identity = hash(
      [this.config.generation, source.plan.owner, target.plan.owner].join("/"),
    ).slice(0, 16);
    const name = `TCV_${identity}_${ipv6 ? 6 : 4}`;
    const lease = {
      name,
      owners: Object.freeze(owners),
      addresses: Object.freeze(
        peers
          .map((peer) => peerAddress(peer, ipv6))
          .sort((left, right) => left.localeCompare(right)),
      ),
      ipv6,
      expiresAt,
    };
    const existing = this.leases.get(name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(lease))
      throw new Error("Conflicting VPN admission lease identity.");
    this.leases.set(name, lease);
    return lease;
  }
  private publicRules(
    runtime: VpnRuntimeAdmission,
    peers: readonly VpnPeer[],
    ipv6: boolean,
  ): Rule[] {
    const rules: Rule[] = [];
    for (const route of runtime.plan.publicRoutes) {
      const publisher = this.publisher(runtime, route, ipv6);
      if (!publisher) continue;
      const lease = this.leaseFor(runtime, publisher, peers, ipv6);
      if (lease)
        for (const peer of peers)
          rules.push(
            ...flowRules(this.config, peer, lease, {
              bridge: route.to.bridge,
              destination: route.address,
              port: route.port,
            }),
          );
    }
    return rules;
  }
  private publisher(
    runtime: VpnRuntimeAdmission,
    route: LocalNetworkPlan["publicRoutes"][number],
    ipv6: boolean,
  ): VpnRuntimeAdmission | undefined {
    if (
      route.fromProject !== runtime.plan.project ||
      route.fromOwner !== runtime.plan.owner ||
      isIP(route.address) !== (ipv6 ? 6 : 4)
    )
      return undefined;
    const publisher = this.active.find(
      (candidate) =>
        candidate.plan.project === route.publisherProject &&
        candidate.plan.owner === route.publisherOwner &&
        candidate.eventId === runtime.eventId,
    );
    if (!publisher) return undefined;
    if (
      !publisher.plan.segments.some(
        (segment) =>
          segment.name === route.to.name &&
          segment.bridge === route.to.bridge &&
          subnet(segment, ipv6) === subnet(route.to, ipv6),
      )
    )
      throw new Error("VPN public service no longer has an admitted publisher.");
    if (
      !Number.isInteger(route.port) ||
      route.port < 1 ||
      route.port > 65535 ||
      !inSubnet(route.address, subnet(route.to, ipv6)) ||
      route.address === segmentGateway(route.to, ipv6)
    )
      throw new Error("Invalid owned VPN public endpoint.");
    return publisher;
  }
  private runtimeRules(runtime: VpnRuntimeAdmission, ipv6: boolean): Rule[] {
    const peers = this.config.peers.filter(
      (peer) => peer.eventId === runtime.eventId && peer.teamId === runtime.teamId,
    );
    if (!peers.length) return [];
    const lease = this.leaseFor(runtime, runtime, peers, ipv6);
    if (!lease) return [];
    const privateRules = runtime.plan.segments.flatMap((segment) =>
      peers.flatMap((peer) =>
        flowRules(this.config, peer, lease, {
          bridge: segment.bridge,
          destination: subnet(segment, ipv6),
        }),
      ),
    );
    return [...privateRules, ...this.publicRules(runtime, peers, ipv6)];
  }
  family(ipv6: boolean): Rule[] {
    const rules: Rule[] = [["-m", "conntrack", "--ctstate", "INVALID", "-j", "DROP"]];
    for (const runtime of this.active)
      for (const segment of runtime.plan.segments)
        rules.push(["-m", "conntrack", "--ctorigdst", segmentGateway(segment, ipv6), "-j", "DROP"]);
    for (const runtime of this.active) {
      rules.push(...this.runtimeRules(runtime, ipv6));
      if (rules.length > RULE_LIMIT)
        throw new Error("VPN rule budget exceeded before native mutation.");
    }
    return [...rules, ["-j", "DROP"]];
  }
}
/** Pure compiler only: callers must supply fresh, native-verified controller ledger admissions. */
export function vpnForwardPolicy(
  config: VpnPeerPlan,
  runtimes: readonly VpnRuntimeAdmission[],
  now: number,
): VpnForwardPolicy {
  const active = activeAdmissions(runtimes, now);
  assertDisjointPeers(config, runtimes);
  const compiler = new PolicyCompiler(config, active, now);
  const ipv4 = compiler.family(false);
  const ipv6 = compiler.family(true);
  return Object.freeze({
    owner: `tc-vpn-v1:${config.generation}`,
    ipv4: Object.freeze(ipv4.map((rule) => Object.freeze(rule))),
    ipv6: Object.freeze(ipv6.map((rule) => Object.freeze(rule))),
    leases: Object.freeze([...compiler.leases.values()].map((lease) => Object.freeze(lease))),
  });
}

/** Compute immediately before each kernel insertion; reusing a plan must never extend a proof. */
export function vpnLeaseTimeout(lease: VpnAdmissionLease, now: number): number | undefined {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(lease.expiresAt))
    throw new Error("Invalid VPN lease time.");
  if (now < lease.expiresAt - PROOF_MILLISECONDS) return undefined;
  const seconds = Math.floor((lease.expiresAt - now) / 1000);
  return seconds >= 1 && seconds <= PROOF_MILLISECONDS / 1000 ? seconds : undefined;
}
