import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";

export interface VpnPeer {
  readonly publicKey: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly ipv4: string;
  readonly ipv6: string;
}
export interface VpnPeerPlan {
  readonly version: 1;
  readonly interface: string;
  readonly serverPublicKey: string;
  readonly serverIpv4: string;
  readonly serverIpv6: string;
  readonly participantPort: number;
  readonly peers: readonly VpnPeer[];
  readonly generation: string;
}
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error("VPN configuration must be an object.");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (
    Object.keys(value).length !== allowed.length ||
    allowed.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(
      "VPN configuration accepts public registration fields only; never supply private keys.",
    );
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    throw new Error("Invalid VPN event/team identity.");
  return value;
}
function publicKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(value))
    throw new Error("VPN requires a canonical public key.");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length !== 32 ||
    bytes.every((byte) => byte === 0) ||
    bytes.toString("base64") !== value
  )
    throw new Error("Invalid VPN public key.");
  return value;
}
function address(value: unknown, family: 4 | 6): string {
  if (typeof value !== "string" || value.includes("%") || isIP(value) !== family)
    throw new Error("VPN peers require fixed IPv4 /32 and IPv6 /128 identities.");
  if (family === 6) {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    if (!/^f[cd]/u.test(canonical))
      throw new Error("VPN IPv6 identities require a dedicated private ULA allocation.");
    return canonical;
  }
  const privateAddresses = new BlockList();
  /* eslint-disable sonarjs/no-hardcoded-ip -- RFC1918 classification only; no connection. */
  for (const [network, prefix] of [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
  ] as const)
    privateAddresses.addSubnet(network, prefix, "ipv4");
  /* eslint-enable sonarjs/no-hardcoded-ip */
  if (!privateAddresses.check(value, "ipv4"))
    throw new Error("VPN IPv4 identities require a dedicated private allocation.");
  return value;
}
/** Parses public registration only. This never generates keys or changes an interface. */
export function vpnPeerPlan(raw: unknown): VpnPeerPlan {
  const value = record(raw);
  fields(value, [
    "version",
    "interface",
    "serverPublicKey",
    "serverIpv4",
    "serverIpv6",
    "participantPort",
    "peers",
  ]);
  // The boot-seal drop-in ships for wg-quick@tcwg0 only. A template drop-in would bind every
  // wg-quick instance on the host, and any other name would leave the controller sealed forever.
  if (value.version !== 1 || value.interface !== "tcwg0")
    throw new Error("VPN requires the tcwg0 interface that the WireGuard seal drop-in covers.");
  const port = value.participantPort;
  if (!Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("Invalid VPN participant port.");
  if (!Array.isArray(value.peers) || !value.peers.length || value.peers.length > 100)
    throw new Error("VPN requires 1 through 100 explicit peer registrations.");
  const peers = value.peers
    .map((rawPeer) => {
      const peer = record(rawPeer);
      fields(peer, ["publicKey", "eventId", "teamId", "ipv4", "ipv6"]);
      return Object.freeze({
        publicKey: publicKey(peer.publicKey),
        eventId: identity(peer.eventId),
        teamId: identity(peer.teamId),
        ipv4: address(peer.ipv4, 4),
        ipv6: address(peer.ipv6, 6),
      });
    })
    .sort((left, right) => left.publicKey.localeCompare(right.publicKey));
  const serverKey = publicKey(value.serverPublicKey);
  const server4 = address(value.serverIpv4, 4);
  const server6 = address(value.serverIpv6, 6);
  const seenKeys = new Set([serverKey]);
  const seenAddresses = new Set([server4, server6]);
  for (const peer of peers) {
    if (
      seenKeys.has(peer.publicKey) ||
      seenAddresses.has(peer.ipv4) ||
      seenAddresses.has(peer.ipv6)
    )
      throw new Error("VPN peer keys and addresses must be unique and distinct from the server.");
    seenKeys.add(peer.publicKey);
    seenAddresses.add(peer.ipv4);
    seenAddresses.add(peer.ipv6);
  }
  const definition = {
    version: 1 as const,
    interface: value.interface,
    serverPublicKey: serverKey,
    serverIpv4: server4,
    serverIpv6: server6,
    participantPort: Number(port),
    peers: Object.freeze(peers),
  };
  return Object.freeze({
    ...definition,
    generation: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
  });
}
export interface VpnHostNetwork {
  readonly device: string | undefined;
  readonly network: string;
}
function hostSubnet(network: string): BlockList | undefined {
  if (network === "default") return undefined;
  const [base = "", prefix, ...rest] = network.split("/");
  const family = isIP(base);
  const width = family === 6 ? 128 : 32;
  const bits = prefix === undefined ? width : Number(prefix);
  if (
    !family ||
    rest.length ||
    (prefix !== undefined && !/^\d{1,3}$/u.test(prefix)) ||
    bits > width
  )
    throw new Error("Invalid host network inventory; VPN admission must remain closed.");
  if (bits === 0) return undefined;
  const subnet = new BlockList();
  subnet.addSubnet(base, bits, family === 6 ? "ipv6" : "ipv4");
  return subnet;
}
/** Anti-spoof drops and cryptokey routes must never claim an address the host reaches elsewhere. */
export function assertVpnHostDisjoint(
  plan: VpnPeerPlan,
  networks: readonly VpnHostNetwork[],
): void {
  const identities = [
    plan.serverIpv4,
    plan.serverIpv6,
    ...plan.peers.flatMap((peer) => [peer.ipv4, peer.ipv6]),
  ];
  for (const { device, network } of networks) {
    const subnet = device === plan.interface ? undefined : hostSubnet(network);
    const overlap = identities.find((identity) =>
      subnet?.check(identity, isIP(identity) === 6 ? "ipv6" : "ipv4"),
    );
    if (overlap)
      throw new Error(
        `VPN identity ${overlap} overlaps host network ${network} on ${device ?? "no device"}; register a dedicated VPN allocation.`,
      );
  }
}
export interface VpnPeerInventory {
  readonly interface: string;
  readonly kind: string;
  readonly publicKey: string;
  readonly peers: readonly { readonly publicKey: string; readonly allowedIps: readonly string[] }[];
}
/** Server-side cryptokey routing must match the complete registration, with no broad prefixes. */
export function assertVpnPeerInventory(plan: VpnPeerPlan, inventory: VpnPeerInventory): void {
  if (
    inventory.interface !== plan.interface ||
    inventory.kind !== "wireguard" ||
    inventory.publicKey !== plan.serverPublicKey ||
    inventory.peers.length !== plan.peers.length
  )
    throw new Error("VPN interface identity changed; admission must remain closed.");
  const seen = new Set<string>();
  for (const actual of inventory.peers) {
    const registered = plan.peers.find((peer) => peer.publicKey === actual.publicKey);
    if (!registered || seen.has(actual.publicKey) || actual.allowedIps.length !== 2)
      throw new Error("VPN peer registration changed; admission must remain closed.");
    const actualIps = actual.allowedIps
      .map((cidr) => {
        const parts = cidr.split("/");
        if (parts.length !== 2) throw new Error("VPN peer prefix must have one exact mask.");
        const [ip, prefix] = parts;
        const family = isIP(ip ?? "");
        if ((family !== 4 && family !== 6) || prefix !== String(family === 4 ? 32 : 128))
          throw new Error("VPN peer prefixes must be exact /32 and /128 identities.");
        return `${address(ip, family)}/${prefix}`;
      })
      .sort((left, right) => left.localeCompare(right));
    const expected = [`${registered.ipv4}/32`, `${registered.ipv6}/128`].sort((left, right) =>
      left.localeCompare(right),
    );
    if (JSON.stringify(actualIps) !== JSON.stringify(expected))
      throw new Error("VPN peer cryptokey routing differs from its registered team identity.");
    seen.add(actual.publicKey);
  }
}
