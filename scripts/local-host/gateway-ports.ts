import { HostError } from "./model";

/** Host-port distance between two runtime slots; slot `n` uses offset `n * SLOT_STRIDE`. */
export const SLOT_STRIDE = 1000;
/** Local hosting runs at most this many team/problem environments at once. */
export const MAX_JOBS = 40;
/** Default exercise-gateway range: one port per runtime slot. */
export const DEFAULT_GATEWAY_PORTS = "5200-5239";

/**
 * The organizer-visible TCP range the per-environment exercise gateways listen on. Slot `n`
 * (1-based) always uses `start + n - 1`, so a port printed at startup, shown in the host console
 * and opened in a firewall stays the same across restarts of the host process.
 */
export interface GatewayPortRange {
  readonly start: number;
  readonly end: number;
}

export function parseGatewayPorts(raw: string): GatewayPortRange {
  const match = /^(\d{4,5})-(\d{4,5})$/u.exec(raw);
  const start = Number(match?.[1]);
  const end = Number(match?.[2]);
  if (!match || start < 1024 || end > 65535 || end < start)
    throw new Error("--gateway-ports must be a range such as 5200-5239 within 1024-65535.");
  return { start, end };
}

export function formatGatewayPorts(range: GatewayPortRange): string {
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

/** How many runtime slots the range can serve. */
export function gatewaySlots(range: GatewayPortRange): number {
  return Math.min(MAX_JOBS, range.end - range.start + 1);
}

export function gatewayPortsOverlap(range: GatewayPortRange, port: number): boolean {
  return port >= range.start && port <= range.end;
}

/** The fixed gateway port of the environment deployed at runtime offset `offset`. */
export function gatewayPort(range: GatewayPortRange, offset: number): number {
  const slot = offset / SLOT_STRIDE;
  if (!Number.isInteger(slot) || slot < 1 || slot > gatewaySlots(range))
    throw new HostError(
      409,
      `Runtime slot ${String(slot)} has no exercise gateway port in ${formatGatewayPorts(range)}. Restart the host with a wider --gateway-ports range.`,
    );
  return range.start + slot - 1;
}
