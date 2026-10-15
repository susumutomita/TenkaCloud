import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { parse, stringify } from "yaml";
import { applyNetworkSubnets, type NetworkSubnets } from "./docker-networks";

/** Trusted controller contract; neither packet source addresses nor browser selectors own a segment. */
export interface LocalNetworkSegment {
  readonly name: string;
  readonly bridge: string;
  readonly ipv4: string;
  readonly ipv6: string;
}
export interface LocalNetworkPlan {
  readonly version: 1;
  readonly project: string;
  readonly owner: string;
  readonly generation: string;
  readonly inputChain: string;
  readonly forwardChain: string;
  readonly segments: readonly LocalNetworkSegment[];
  readonly services: Readonly<Record<string, readonly string[]>>;
  readonly eventId: string;
  readonly publicRoutes: readonly LocalPublicRoute[];
}
export interface LocalPublicEndpoint {
  readonly service: string;
  readonly segment: LocalNetworkSegment;
  readonly addresses: readonly string[];
  readonly port: number;
}
export interface LocalPublicRoute {
  readonly service: string;
  readonly from: LocalNetworkSegment;
  readonly to: LocalNetworkSegment;
  readonly address: string;
  readonly port: number;
  readonly publisherProject: string;
  readonly publisherOwner: string;
  readonly fromProject: string;
  readonly fromOwner: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Addresses are still allocated by the existing durable /28 allocator. */
export function localNetworkPlan(
  project: string,
  subnets: NetworkSubnets,
  source?: { readonly composeText: string; readonly definition: string; readonly eventId?: string },
): LocalNetworkPlan {
  if (!/^tch-[a-z0-9_-]{1,128}$/u.test(project)) throw new Error("Invalid local network owner.");
  const names = Object.keys(subnets).sort((a, b) => String(a).localeCompare(String(b)));
  if (!names.length || names.length > 32) throw new Error("Invalid local network segment count.");
  // Reuse the canonical allocation validator, including private ranges and overlaps.
  applyNetworkSubnets(stringify({ services: { validation: { networks: names } } }), subnets);
  const generation = hash(source?.definition ?? project);
  const identity = hash(`${project}/${generation}`);
  const segments = names.map((name) => {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) throw new Error("Invalid local segment name.");
    const digest = hash(`${project}/${name}`);
    const words = [0, 4, 8].map((offset) =>
      Number.parseInt(digest.slice(offset, offset + 4), 16).toString(16),
    );
    return Object.freeze({
      name,
      bridge: `tci${digest.slice(0, 12)}`,
      ipv4: requiredNetworkValue(subnets[name]),
      ipv6: `fd33:${words.join(":")}::/64`,
    });
  });
  const services = ownedServices(source?.composeText, names);
  return Object.freeze({
    version: 1,
    project,
    generation,
    owner: `tc-isolation-v1:${identity}`,
    inputChain: `TCI_${identity.slice(0, 16)}_I`,
    forwardChain: `TCI_${identity.slice(0, 16)}_F`,
    segments: Object.freeze(segments),
    services: Object.freeze(services),
    eventId: source?.eventId ?? project,
    publicRoutes: Object.freeze([]),
  });
}
/** Only controller-resolved endpoints of another owned runtime in the same event are eligible. */
export function sharedNetworkPlan(
  plan: LocalNetworkPlan,
  publishers: readonly {
    readonly plan: LocalNetworkPlan;
    readonly endpoints: readonly LocalPublicEndpoint[];
  }[],
  participants: readonly LocalNetworkPlan[] = [plan],
): LocalNetworkPlan {
  const publicRoutes = publishers
    .filter((publisher) => publisher.plan.eventId === plan.eventId)
    .flatMap((publisher) =>
      publisher.endpoints.flatMap((endpoint) =>
        endpointRoutes(plan, publisher.plan, endpoint, participants),
      ),
    );
  if (publicRoutes.length > 256) throw new Error("DMZ publication rule budget exceeded.");
  return Object.freeze({ ...plan, publicRoutes: Object.freeze(publicRoutes) });
}
/** Durable rows are private controller output, but are still revalidated before executing tools. */
export function retainedPublicPlan(plan: LocalNetworkPlan, value: unknown): LocalNetworkPlan {
  if (value === undefined) return plan;
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid retained DMZ rule budget.");
  const routes = value.map((raw: unknown) => retainedRoute(plan, raw));
  return Object.freeze({ ...plan, publicRoutes: Object.freeze(routes) });
}

/** Only a host-generated, pinned composition receives these settings. */
export function isolatedCompose(text: string, plan: LocalNetworkPlan): string {
  const document = parse(
    applyNetworkSubnets(
      text,
      Object.fromEntries(plan.segments.map((segment) => [segment.name, segment.ipv4])),
    ),
    { merge: true },
  );
  for (const segment of plan.segments) {
    document.networks[segment.name] = {
      driver: "bridge",
      internal: true,
      enable_ipv6: true,
      driver_opts: { "com.docker.network.bridge.name": segment.bridge },
      labels: { "tenkacloud.isolation.owner": plan.owner },
      ipam: {
        config: [
          { subnet: segment.ipv4, gateway: segmentGateway(segment, false) },
          { subnet: segment.ipv6, gateway: segmentGateway(segment, true) },
        ],
      },
    };
  }
  for (const service of Object.values(document.services) as Record<string, unknown>[]) {
    service.restart = "no";
    service.labels = {
      "tenkacloud.isolation.owner": plan.owner,
      "tenkacloud.isolation.generation": plan.generation,
    };
  }
  return stringify(document);
}

/** Caller-supplied inventory must include LAN/VPN routes, not just interface addresses. */
/** Only the organizer can clear a colliding host route, so halts report it by name. */
export class NetworkOverlapError extends Error {
  constructor() {
    super("Competition network overlaps an existing host, LAN/VPN or runtime range.");
    this.name = "NetworkOverlapError";
  }
}

export function assertNoNetworkOverlap(plan: LocalNetworkPlan, occupied: readonly string[]): void {
  for (const candidate of plan.segments.flatMap((segment) => [segment.ipv4, segment.ipv6])) {
    const [ip = "", rawPrefix = ""] = candidate.split("/");
    const family = isIP(ip) === 4 ? "ipv4" : "ipv6";
    const candidateList = new BlockList();
    candidateList.addSubnet(ip, Number(rawPrefix), family);
    for (const existing of occupied) {
      const [address = "", prefix] = existing.split("/");
      if (isIP(address) !== isIP(ip)) continue;
      const existingList = new BlockList();
      existingList.addSubnet(
        address,
        prefix === undefined ? defaultPrefix(family) : Number(prefix),
        family,
      );
      if (candidateList.check(address, family) || existingList.check(ip, family))
        throw new NetworkOverlapError();
    }
  }
}

/** Missing trusted runtime state must fail rather than select a fallback target. */
export function requiredNetworkValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Required competition runtime state is missing.");
  return value;
}

function ownedServices(
  composeText: string | undefined,
  names: readonly string[],
): Record<string, readonly string[]> {
  const services: Record<string, readonly string[]> = {};
  if (composeText !== undefined) {
    const document = parse(composeText, { merge: true });
    for (const [name, service] of Object.entries(document.services) as [
      string,
      Record<string, unknown>,
    ][]) {
      let networks: unknown[] = ["default"];
      if (service.networks !== undefined)
        networks = Array.isArray(service.networks)
          ? service.networks
          : Object.keys(service.networks as object);
      if (
        !/^[A-Za-z0-9_.-]{1,128}$/u.test(name) ||
        !networks.length ||
        networks.some((network: unknown) => typeof network !== "string" || !names.includes(network))
      )
        throw new Error("Invalid owned service network declaration.");
      services[name] = Object.freeze(
        [...(networks as string[])].sort((a, b) => String(a).localeCompare(String(b))),
      );
    }
  }
  return services;
}

function endpointRoutes(
  plan: LocalNetworkPlan,
  publisher: LocalNetworkPlan,
  endpoint: LocalPublicEndpoint,
  participants: readonly LocalNetworkPlan[],
): LocalPublicRoute[] {
  if (
    !publisher.segments.some(
      (segment) =>
        segment.name === endpoint.segment.name &&
        segment.bridge === endpoint.segment.bridge &&
        segment.ipv4 === endpoint.segment.ipv4 &&
        segment.ipv6 === endpoint.segment.ipv6,
    ) ||
    !/^[A-Za-z0-9_.-]{1,128}$/u.test(endpoint.service) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    throw new Error("Invalid owned DMZ endpoint.");
  const eligible = participants.filter(
    (participant) =>
      participant.eventId === plan.eventId &&
      participant.project !== publisher.project &&
      (participant.project === plan.project || publisher.project === plan.project),
  );
  return endpoint.addresses.flatMap((address) => {
    assertEndpointAddress(endpoint, address);
    return eligible.flatMap((participant) =>
      participant.segments.map((from) =>
        Object.freeze({
          from,
          to: endpoint.segment,
          address,
          port: endpoint.port,
          service: endpoint.service,
          publisherProject: publisher.project,
          publisherOwner: publisher.owner,
          fromProject: participant.project,
          fromOwner: participant.owner,
        }),
      ),
    );
  });
}
function assertEndpointAddress(endpoint: LocalPublicEndpoint, address: string): void {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error("Invalid DMZ address family.");
  const [base = "", prefix] = (family === 4 ? endpoint.segment.ipv4 : endpoint.segment.ipv6).split(
    "/",
  );
  const block = new BlockList();
  block.addSubnet(base, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  if (!block.check(address, family === 4 ? "ipv4" : "ipv6"))
    throw new Error("DMZ address does not belong to its publisher's owned segment.");
}

function retainedRoute(plan: LocalNetworkPlan, raw: unknown): LocalPublicRoute {
  if (!raw || typeof raw !== "object") throw new Error("Invalid retained DMZ route.");
  const entry = raw as LocalPublicRoute;
  assertRetainedOwner(entry);
  const peer = localNetworkPlan(entry.publisherProject, { [entry.to.name]: entry.to.ipv4 });
  const segment = requiredNetworkValue(peer.segments[0]);
  if (segment.bridge !== entry.to.bridge || segment.ipv6 !== entry.to.ipv6)
    throw new Error("Retained DMZ bridge allocation changed.");
  const scopedPeer = { ...peer, eventId: plan.eventId, owner: entry.publisherOwner };
  const source = localNetworkPlan(entry.fromProject, { [entry.from.name]: entry.from.ipv4 });
  if (
    source.segments[0]?.bridge !== entry.from.bridge ||
    source.segments[0]?.ipv6 !== entry.from.ipv6
  )
    throw new Error("Retained DMZ source allocation changed.");
  const scopedSource = { ...source, eventId: plan.eventId, owner: entry.fromOwner };
  if (
    (entry.fromProject !== plan.project && entry.publisherProject !== plan.project) ||
    (entry.fromProject === plan.project && entry.fromOwner !== plan.owner) ||
    (entry.publisherProject === plan.project && entry.publisherOwner !== plan.owner)
  )
    throw new Error("Retained DMZ permission does not belong to this runtime.");
  const checked = sharedNetworkPlan(
    plan,
    [
      {
        plan: scopedPeer,
        endpoints: [
          { segment, addresses: [entry.address], port: entry.port, service: entry.service },
        ],
      },
    ],
    [scopedSource],
  );
  const route = checked.publicRoutes.find(
    (candidate) => candidate.from.bridge === entry.from.bridge,
  );
  if (!route) throw new Error("Invalid retained DMZ address.");
  return route;
}

function assertRetainedOwner(entry: LocalPublicRoute): void {
  if (
    !entry.from ||
    !entry.to ||
    !/^tci[a-f0-9]{12}$/u.test(entry.to.bridge) ||
    !/^tch-[a-z0-9_-]{1,128}$/u.test(entry.publisherProject) ||
    !/^tch-[a-z0-9_-]{1,128}$/u.test(entry.fromProject) ||
    !/^tc-isolation-v1:[a-f0-9]{64}$/u.test(entry.publisherOwner) ||
    !/^tc-isolation-v1:[a-f0-9]{64}$/u.test(entry.fromOwner)
  )
    throw new Error("Retained DMZ owner does not match the private controller plan.");
}

function defaultPrefix(family: "ipv4" | "ipv6"): number {
  return family === "ipv4" ? 32 : 128;
}

/** Dedicated host bridge addresses are protected even before Docker creates the bridge. */
export function segmentGateway(segment: LocalNetworkSegment, ipv6: boolean): string {
  if (ipv6) return segment.ipv6.replace("::/64", "::1");
  const parts = segment.ipv4.split("/")[0]?.split(".") ?? [];
  if (parts.length !== 4) throw new Error("Invalid protected bridge allocation.");
  parts[3] = String(Number(parts[3]) + 1);
  return parts.join(".");
}
