import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { parse, stringify } from "yaml";

export type NetworkSubnets = Readonly<Record<string, string>>;
interface Range {
  start: number;
  end: number;
  prefix: number;
}

function range(cidr: string): Range {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/u.exec(cidr);
  if (!match) throw new Error("Expected an IPv4 CIDR.");
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((value) => value > 255) || prefix > 32) throw new Error("Invalid IPv4 CIDR.");
  const address = octets.reduce((value, part) => value * 256 + part, 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(address / size) * size;
  return { start, end: start + size - 1, prefix };
}
function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}
function address(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC1918 classification constants; no network connection
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(range);
function privateRange(value: Range): boolean {
  return PRIVATE_RANGES.some((allowed) => allowed.start <= value.start && allowed.end >= value.end);
}

/** An explicit organizer choice, never a guessed LAN/VPN range or daemon-wide change. */
export function parseDockerNetworkPool(cidr: string): string {
  const value = range(cidr);
  if (
    !privateRange(value) ||
    value.prefix < 16 ||
    value.prefix > 24 ||
    cidr !== `${address(value.start)}/${value.prefix}`
  )
    throw new Error(
      "--docker-network-pool must be an aligned private IPv4 /16 through /24 network, separate from LAN/VPN routes.",
    );
  return cidr;
}

interface NetworkDocument {
  services: Record<string, { networks?: string[] | Record<string, unknown> }>;
  networks?: Record<string, Record<string, unknown> | null>;
}
function networkDocument(text: string): { document: NetworkDocument; names: string[] } {
  const document = parse(text, { merge: true }) as NetworkDocument;
  if (!document?.services || typeof document.services !== "object")
    throw new Error("Compose services are required for network accounting.");
  const counts = new Map<string, number>();
  for (const service of Object.values(document.services)) {
    let names = ["default"];
    if (Array.isArray(service.networks)) names = service.networks;
    else if (service.networks !== undefined) names = Object.keys(service.networks);
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count > 13))
    throw new Error(
      "A compact Docker network supports at most 13 services; this problem needs a reviewed larger allocation.",
    );
  return { document, names: [...counts.keys()].sort((a, b) => a.localeCompare(b)) };
}

/** Allocates independent /28 networks; retained/stopped projects keep their addresses. */
export function allocateNetworkSubnets(
  text: string,
  pool: string,
  occupied: readonly string[],
): NetworkSubnets {
  const source = range(parseDockerNetworkPool(pool));
  const blocked = occupied.map(range);
  const result: Record<string, string> = {};
  let cursor = source.start;
  for (const name of networkDocument(text).names) {
    while (
      cursor + 15 <= source.end &&
      blocked.some((value) => overlaps(value, { start: cursor, end: cursor + 15, prefix: 28 }))
    )
      cursor += 16;
    if (cursor + 15 > source.end)
      throw new Error(
        "The configured Docker network pool has no free compact subnets. Retained work was not removed; use a non-overlapping larger pool for new environments or explicitly retire completed ones.",
      );
    result[name] = `${address(cursor)}/28`;
    cursor += 16;
  }
  return result;
}

/** Applied only after authored Compose policy validation; authors cannot select host networks. */
export function applyNetworkSubnets(text: string, subnets: NetworkSubnets): string {
  const { document, names } = networkDocument(text);
  if (
    JSON.stringify(Object.keys(subnets).sort((a, b) => a.localeCompare(b))) !==
    JSON.stringify(names)
  )
    throw new Error("Retained Docker network allocation does not match the pinned problem.");
  const ranges: Range[] = [];
  for (const name of names) {
    const cidr = subnets[name];
    if (typeof cidr !== "string") throw new Error("Invalid retained Docker subnet.");
    const value = range(cidr);
    if (
      !privateRange(value) ||
      value.prefix !== 28 ||
      cidr !== `${address(value.start)}/28` ||
      ranges.some((other) => overlaps(value, other))
    )
      throw new Error("Invalid or overlapping retained Docker subnets.");
    ranges.push(value);
    document.networks ??= {};
    const authored = document.networks[name];
    if (authored && ("name" in authored || "external" in authored || "ipam" in authored))
      throw new Error("Compact networks must remain project-owned and host-allocated.");
    document.networks[name] = {
      ...authored,
      ipam: { config: [{ subnet: cidr }] },
    };
  }
  return stringify(document);
}

export class DockerNetworkInventoryError extends Error {
  readonly daemonUnavailable: boolean;
  constructor(cause: unknown) {
    super(
      "Docker network inventory could not be read. Existing networks and team data were not changed.",
    );
    const result = (cause && typeof cause === "object" ? cause : {}) as {
      stderr?: unknown;
      message?: unknown;
    };
    const value = result.stderr ?? result.message;
    let detail = "";
    if (typeof value === "string") detail = value;
    else if (Buffer.isBuffer(value)) detail = value.toString("utf8");
    this.daemonUnavailable =
      /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|daemon is not running|error during connect/iu.test(
        detail,
      );
  }
}

function dockerNetworkCommand(args: string[]): string {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- selected local Docker CLI, fixed arguments
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new DockerNetworkInventoryError(cause);
  }
}

/** Read-only inventory. No pruning, network creation, or daemon configuration. */
export function occupiedDockerSubnets(
  run: (args: string[]) => string = dockerNetworkCommand,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): readonly string[] {
  const ids = run(["network", "ls", "--quiet"]).split(/\s+/u).filter(Boolean);
  if (ids.length > 4096 || ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id)))
    throw new Error("Docker network inventory is invalid or too large.");
  const occupied: string[] = [];
  if (ids.length) {
    const rows = run(["network", "inspect", "--format", "{{json .IPAM.Config}}", ...ids]);
    occupied.push(...dockerInventorySubnets(rows));
  }
  occupied.push(
    ...Object.values(interfaces).flatMap((entries) =>
      (entries ?? [])
        .filter((entry) => entry.family === "IPv4" && entry.cidr)
        .map((entry) => entry.cidr as string),
    ),
  );
  return occupied;
}

function dockerInventorySubnets(rows: string): string[] {
  return rows.split("\n").flatMap((line) => {
    const configs = JSON.parse(line) as { Subnet?: string }[] | null;
    return (configs ?? []).flatMap((config) =>
      config.Subnet && !config.Subnet.includes(":") ? [config.Subnet] : [],
    );
  });
}
