import { BlockList, isIP } from "node:net";

/** Catalog requests are review material, never organizer approval or a packet permission. */
export interface InternetAccessRequest {
  readonly id: string;
  readonly service: string;
  readonly destination: string;
  readonly port: number;
  readonly purpose: string;
}

// Conservative subset of the IANA special-purpose registries, not a reachability proof.
/* eslint-disable sonarjs/no-hardcoded-ip -- Policy constants reject these address ranges; no connection is made. */
const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  excluded.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  excluded.addSubnet(address, prefix, "ipv6");
const unicastV6 = new BlockList();
unicastV6.addSubnet("2000::", 3, "ipv6");
/* eslint-enable sonarjs/no-hardcoded-ip */

/** Conservative request syntax only; public host/LAN routes still need a live protection check. */
function destination(value: unknown): string {
  if (typeof value !== "string") throw new Error("Internet requests need an exact IP address.");
  const family = isIP(value);
  if (
    (family !== 4 && family !== 6) ||
    value.includes("%") ||
    (family === 6 && !unicastV6.check(value, "ipv6")) ||
    excluded.check(value, family === 6 ? "ipv6" : "ipv4")
  )
    throw new Error("Internet requests cannot name private, special, wildcard or routed ranges.");
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

/** Initial proposal: at most eight service-scoped, exact-address TCP requests, without DNS. */
export function normalizeInternetAccess(
  value: unknown,
): readonly InternetAccessRequest[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8)
    throw new Error("runtime.internetAccess must contain 1-8 requests.");
  const ids = new Set<string>();
  const tuples = new Set<string>();
  return Object.freeze(
    value.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid Internet access request.");
      const entry = raw as Record<string, unknown>;
      if (
        Object.keys(entry)
          .sort((a, b) => a.localeCompare(b))
          .join(",") !== "destination,id,port,purpose,service" ||
        typeof entry.id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry.id) ||
        ids.has(entry.id) ||
        typeof entry.service !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(entry.service) ||
        typeof entry.port !== "number" ||
        !Number.isInteger(entry.port) ||
        entry.port < 1 ||
        entry.port > 65535 ||
        typeof entry.purpose !== "string" ||
        !entry.purpose.trim() ||
        Buffer.byteLength(entry.purpose) > 512
      )
        throw new Error(
          "Internet requests need unique IDs, one service, one TCP port and a purpose.",
        );
      const address = destination(entry.destination);
      const tuple = `${entry.service}/${address}/${entry.port}`;
      if (tuples.has(tuple)) throw new Error("Duplicate Internet access destination.");
      ids.add(entry.id);
      tuples.add(tuple);
      return Object.freeze({
        id: entry.id,
        service: entry.service,
        destination: address,
        port: entry.port,
        purpose: entry.purpose.trim(),
      });
    }),
  );
}

/** Neither catalog selection nor declaration is consent; no existing backend can enforce this yet. */
export function assertInternetAccessUnavailable(value: unknown): void {
  if (normalizeInternetAccess(value))
    throw new Error(
      "Catalog Internet access is a request, not approval. Internet exceptions need the isolated native network adapter; refusing to start or adopt the environment.",
    );
}
