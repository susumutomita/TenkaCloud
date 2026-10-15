import { isIP } from "node:net";
import {
  assertVpnPeerInventory,
  type VpnPeer,
  type VpnPeerInventory,
  type VpnPeerPlan,
} from "./peer-plan";

const PROOF_MILLISECONDS = 60_000;
export interface VpnPeerProof {
  readonly generation: string;
  readonly verifiedAt: number;
}
/** Only the socket peer is meaningful here. Forwarded headers never establish VPN identity. */
export function vpnSocketPeer(plan: VpnPeerPlan, socketAddress: string): VpnPeer | undefined {
  // Node commonly reports IPv4 connections on a dual-stack listener in mapped notation.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(socketAddress);
  const address = mapped?.[1] ?? socketAddress;
  const family = isIP(address);
  if (!family || address.includes("%")) return undefined;
  const canonical = family === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
  return plan.peers.find((peer) => canonical === peer.ipv4 || canonical === peer.ipv6);
}
/** Proofs are obtained only after complete cryptokey inventory verification. No key material is retained. */
export function vpnPeerProof(
  plan: VpnPeerPlan,
  inventory: VpnPeerInventory,
  now: number,
): VpnPeerProof {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid VPN verification time.");
  assertVpnPeerInventory(plan, inventory);
  return Object.freeze({ generation: plan.generation, verifiedAt: now });
}
/** Recheck at request dispatch and every WebSocket authorization/heartbeat, after authentication. */
export function assertVpnTeamPeer(
  plan: VpnPeerPlan,
  proof: VpnPeerProof | undefined,
  socketAddress: string,
  authenticated: { readonly eventId: string; readonly teamId: string },
  now: number,
): void {
  if (
    !proof ||
    proof.generation !== plan.generation ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(proof.verifiedAt) ||
    proof.verifiedAt < 0 ||
    now < proof.verifiedAt ||
    now - proof.verifiedAt >= PROOF_MILLISECONDS
  )
    throw new Error("VPN identity proof unavailable or expired.");
  const peer = vpnSocketPeer(plan, socketAddress);
  if (!peer || peer.eventId !== authenticated.eventId || peer.teamId !== authenticated.teamId)
    throw new Error("VPN peer does not own the authenticated event/team.");
}
