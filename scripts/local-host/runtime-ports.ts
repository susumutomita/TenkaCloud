import { type Document, isAlias, isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import { resolveStaticDefaults } from "./container/compose-policy";
import { type ComposePortRemap, remapComposeHostPorts } from "./container/port-remap";

/** Durable declared Compose host port → assigned host port, stored with its owning job. */
export type RuntimePorts = Readonly<Record<string, number>>;

export interface RuntimePortRange {
  readonly start: number;
  readonly end: number;
}

export const DEFAULT_RUNTIME_PORTS: RuntimePortRange = { start: 20_000, end: 60_999 };

export interface RuntimePortConstraints {
  readonly range?: RuntimePortRange;
  /** Ports owned by other retained jobs, including stopped and cleanup-pending jobs. */
  readonly reservedPorts?: Iterable<number>;
  readonly gatewayPorts?: RuntimePortRange;
  readonly listenerPorts?: readonly number[];
}

export interface RuntimePortRequest {
  readonly jobId: string;
  /** Pinned Compose text that has already passed the existing Compose policy. */
  readonly composeText: string;
}

export interface RuntimePortAllocation extends RuntimePortConstraints {
  /** Probe loopback availability; this is a check, not an OS-level reservation. */
  readonly isAvailable: (port: number) => boolean | Promise<boolean>;
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function checkedRange(range: RuntimePortRange): RuntimePortRange {
  if (
    !validPort(range.start) ||
    !validPort(range.end) ||
    range.start < 1024 ||
    range.end < range.start
  )
    throw new Error("Runtime port range must be within 1024-65535 with start <= end.");
  return range;
}

interface PublishedBinding {
  readonly node: Scalar;
  readonly host: string;
  readonly source: number;
  readonly container: string;
}

function resolveAlias(node: unknown, document: Document): unknown {
  return isAlias(node) ? node.resolve(document) : node;
}

/** Resolve only service port inheritance; never treat comments/env/healthcheck strings as ports. */
function servicePortNodes(
  node: unknown,
  document: Document,
  ancestors = new Set<unknown>(),
): readonly unknown[] | undefined {
  const service = resolveAlias(node, document);
  if (!isMap(service) || ancestors.has(service))
    throw new Error("Compose services must be non-cyclic mappings.");
  const next = new Set(ancestors).add(service);
  if (service.has("ports")) {
    const ports = resolveAlias(service.get("ports", true), document);
    if (!isSeq(ports)) throw new Error("Compose ports must be a sequence of loopback bindings.");
    return ports.items;
  }
  const merge = service.get("<<", true);
  if (merge === undefined) return undefined;
  const parents = isSeq(merge) ? merge.items : [merge];
  for (const parent of parents) {
    const ports = servicePortNodes(parent, document, next);
    if (ports !== undefined) return ports;
  }
  return undefined;
}

function publishedBindings(composeText: string): PublishedBinding[] {
  const document = parseDocument(composeText);
  if (document.errors.length) throw new Error("Invalid Compose YAML for runtime ports.");
  const services = document.get("services", true);
  if (!isMap(services)) throw new Error("Compose must contain a services mapping.");
  const nodes = new Set(
    services.items
      .flatMap((service) => servicePortNodes(service.value, document) ?? [])
      .map((node) => resolveAlias(node, document)),
  );
  return [...nodes].map((item) => {
    const node = resolveAlias(item, document);
    if (
      !isScalar(node) ||
      typeof node.value !== "string" ||
      !node.range ||
      node.type === "BLOCK_LITERAL" ||
      node.type === "BLOCK_FOLDED"
    )
      throw new Error("Compose ports must be scalar loopback bindings.");
    const resolved = resolveStaticDefaults(node.value);
    const match = /^(127\.0\.0\.1|localhost):(\d+):(\d+(?:\/tcp)?)$/u.exec(resolved.value);
    const source = Number(match?.[2]);
    const container = match?.[3];
    if (
      resolved.unresolved ||
      !match ||
      !validPort(source) ||
      !validPort(Number(container?.replace("/tcp", "")))
    )
      throw new Error(
        "Compose must declare concrete loopback host/container ports within 1-65535.",
      );
    return { node, host: match[1] ?? "127.0.0.1", source, container: container ?? "" };
  });
}

/** Unique declared host ports, including literal defaults used by the real catalog. */
export function publishedComposePorts(composeText: string): number[] {
  return [...new Set(publishedBindings(composeText).map((binding) => binding.source))].sort(
    (left, right) => left - right,
  );
}

function rewriteBinding(
  composeText: string,
  binding: PublishedBinding,
  portMap: ReadonlyMap<number, number>,
): string {
  const value = `${binding.host}:${String(portMap.get(binding.source))}:${binding.container}`;
  const quoted = binding.node.type === "QUOTE_SINGLE" ? `'${value}'` : JSON.stringify(value);
  const range = binding.node.range;
  if (!range) throw new Error("Compose binding has no source range.");
  return composeText.slice(0, range[0]) + quoted + composeText.slice(range[1]);
}

function reservedPorts(constraints: RuntimePortConstraints): Set<number> {
  const reserved = new Set(constraints.reservedPorts);
  for (const port of constraints.listenerPorts ?? []) reserved.add(port);
  if ([...reserved].some((port) => !validPort(port)))
    throw new Error("Reserved runtime ports must be integers within 1-65535.");
  if (constraints.gatewayPorts) {
    const range = checkedRange(constraints.gatewayPorts);
    for (let port = range.start; port <= range.end; port++) reserved.add(port);
  }
  return reserved;
}

/** Validate persisted maps before using them for start, recover, stop or resume. */
export function validateRuntimePorts(
  composeText: string,
  value: unknown,
  constraints: RuntimePortConstraints = {},
): ReadonlyMap<number, number> {
  const range = checkedRange(constraints.range ?? DEFAULT_RUNTIME_PORTS);
  const expected = publishedComposePorts(composeText);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Runtime port map must be an object.");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((port) => !Object.hasOwn(value, String(port)))
  )
    throw new Error("Runtime port map must contain exactly the declared Compose host ports.");
  const reserved = reservedPorts(constraints);
  const targets = new Set<number>();
  const result = new Map<number, number>();
  for (const source of expected) {
    const target = (value as Record<string, unknown>)[String(source)];
    if (!validPort(target) || target < range.start || target > range.end)
      throw new Error(`Runtime port target for ${source} is outside the configured range.`);
    if (targets.has(target) || reserved.has(target))
      throw new Error(
        `Runtime port target ${target} is duplicated or belongs to another listener/job.`,
      );
    targets.add(target);
    result.set(source, target);
  }
  return result;
}

/**
 * Explicit maps preserve the exact durable plan. Absent maps retain legacy offset behavior,
 * including its original validation and its wider historical target-port range.
 * Pass the returned portMap to remapContainerProblem to move endpoints and all problem prose.
 */
export function remapRuntimeComposePorts(
  composeText: string,
  offset: number,
  runtimePorts?: RuntimePorts,
  constraints: RuntimePortConstraints = {},
): ComposePortRemap {
  if (runtimePorts === undefined) return remapComposeHostPorts(composeText, offset);
  const portMap = validateRuntimePorts(composeText, runtimePorts, constraints);
  // Pin both host and published port to literals; environment overrides must not move an
  // explicit durable plan. Rewrite only scalar source ranges, preserving other YAML bytes.
  const bindings = publishedBindings(composeText).sort(
    (left, right) => (right.node.range?.[0] ?? 0) - (left.node.range?.[0] ?? 0),
  );
  const text = bindings.reduce(
    (source, binding) => rewriteBinding(source, binding, portMap),
    composeText,
  );
  return { text, portMap };
}

function allocationRequests(requests: readonly RuntimePortRequest[]) {
  const ids = new Set<string>();
  return requests
    .map((request) => {
      if (!request.jobId || ids.has(request.jobId))
        throw new Error("Runtime allocation requires unique, nonempty job IDs.");
      ids.add(request.jobId);
      return { jobId: request.jobId, ports: publishedComposePorts(request.composeText) };
    })
    .sort((left, right) => (left.jobId < right.jobId ? -1 : Number(left.jobId > right.jobId)));
}

/**
 * Plan an entire batch without mutating requests, reservations or durable state. A failure
 * returns no partial plan. The owning caller MUST serialize snapshot → allocate → persist
 * host-wide, and persist every assignment before starting any container. Independent calls
 * with stale snapshots can choose the same ports; even a successful probe cannot prevent an
 * unrelated OS process from binding before Docker. Preserve maps across stop/resume, and
 * release reservations only after confirmed physical cleanup.
 */
export async function allocateRuntimePorts(
  requests: readonly RuntimePortRequest[],
  options: RuntimePortAllocation,
): Promise<ReadonlyMap<string, RuntimePorts>> {
  const range = checkedRange(options.range ?? DEFAULT_RUNTIME_PORTS);
  const reserved = reservedPorts(options);
  const prepared = allocationRequests(requests);
  const result = new Map<string, RuntimePorts>();
  let candidate = range.start;
  for (const request of prepared) {
    const assignments: Record<string, number> = {};
    for (const source of request.ports) {
      while (
        candidate <= range.end &&
        (reserved.has(candidate) || !(await options.isAvailable(candidate)))
      )
        candidate++;
      if (candidate > range.end)
        throw new Error("Runtime port allocation exhausted; no assignments have been committed.");
      assignments[String(source)] = candidate++;
    }
    result.set(request.jobId, assignments);
  }
  return result;
}
