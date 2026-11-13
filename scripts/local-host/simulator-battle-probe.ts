import { randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { z } from "zod";
import type { directWebTransport } from "./direct-web-transport";
import {
  type BattleDeploymentOwner,
  battleReceiptSchema,
  resolveBattleBinding,
  validateBattleReceipt,
} from "./simulator-battle-binding";
import { requestBattleCapability } from "./simulator-battle-capability";
import { requestBattleDeadline } from "./simulator-battle-deadline";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";

const millis = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((s) => /[1-9a-f]/u.test(s));
const keySchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/u)
  .refine((s) => /[1-9a-f]/u.test(s));
const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const port = z.number().int().min(1).max(65535);
const path = z.enum(["/", "/healthz"]);
const wire = z.strictObject({ owner: hex, deployment: hex, lease: hex, backendIncarnation: hex });
const service = z.strictObject({ name, port, path });
const mac = z
  .string()
  .regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u)
  .refine((s) => s !== "00:00:00:00:00:00");
const route = z.strictObject({
  localIP: z.string().refine(isIPv4),
  peerIP: z.string().refine(isIPv4),
  localMAC: mac,
  peerMAC: mac,
  localPort: z.number().int().min(40000).max(41023),
  peerPort: port,
  anyPeerPort: z.literal(false),
});
const observation = z.strictObject({
  route,
  path,
  status: z.number().int().min(100).max(599),
  startedAtMs: millis,
  receivedAtMs: millis,
});
const result = z.union([
  z.strictObject({ error: z.enum(["deadline_exceeded", "canceled", "probe_failed"]) }),
  z.strictObject({ observation }),
]);
const snapshotSchema = z.strictObject({
  version: z.literal(2),
  clockDomain: name,
  binding: wire,
  service,
  key: keySchema,
  startedAtMs: millis,
  deadlineMs: millis,
  resultReady: z.boolean(),
  settled: z.boolean(),
  route: route.optional(),
  result: result.optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Receipt = Awaited<ReturnType<typeof resolveBattleBinding>>["receipt"];
type Slot = "frontend" | "api";
interface Expected {
  readonly receipt: Receipt;
  readonly slot: Slot;
  readonly key: string;
  readonly deadline: Awaited<ReturnType<typeof requestBattleDeadline>>;
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function assertRoute(s: Snapshot, expected: Expected) {
  if (!s.route) return;
  const t = expected.receipt.slots[expected.slot].binding.target;
  if (
    s.route.localIP !== t.localIP ||
    s.route.peerIP !== t.peerIP ||
    s.route.localMAC !== t.localMAC ||
    s.route.peerMAC !== t.peerMAC ||
    s.route.peerPort !== t.peerPort ||
    s.deadlineMs <= s.startedAtMs
  )
    throw new Error("Foreign Battle probe route.");
}
function assertResult(s: Snapshot) {
  if ((s.settled && !s.resultReady) || s.resultReady !== (s.result !== undefined))
    throw new Error("Inconsistent Battle probe result state.");
  if (!s.result || !("observation" in s.result)) return;
  const o = s.result.observation;
  if (
    !s.route ||
    !same(o.route, s.route) ||
    o.path !== s.service.path ||
    o.startedAtMs < s.startedAtMs ||
    o.receivedAtMs < o.startedAtMs ||
    o.receivedAtMs >= s.deadlineMs
  )
    throw new Error("Invalid Battle probe observation.");
}
function validateSnapshot(value: unknown, expected: Expected, prior?: Snapshot) {
  // null is unknown, not settlement or permission to resubmit.
  const s = snapshotSchema.parse(value);
  const mapping = expected.receipt.slots[expected.slot];
  if (
    s.clockDomain !== expected.deadline.domain ||
    s.key !== expected.key ||
    !same(s.binding, mapping.wireBinding) ||
    !same(s.service, mapping.service) ||
    s.deadlineMs > expected.deadline.ticksMs ||
    s.deadlineMs - s.startedAtMs > 8000
  )
    throw new Error("Unbound Battle probe snapshot.");
  assertRoute(s, expected);
  assertResult(s);
  if (prior) assertProgress(s, prior);
  return s;
}
function assertProgress(s: Snapshot, prior: Snapshot) {
  if (
    s.startedAtMs !== prior.startedAtMs ||
    s.deadlineMs !== prior.deadlineMs ||
    ((prior.route !== undefined || prior.settled) && !same(prior.route, s.route)) ||
    (prior.resultReady && !same(prior.result, s.result)) ||
    (prior.settled && !s.settled)
  )
    throw new Error("Battle probe retained state changed or regressed.");
}

const descriptorSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("battle-probe-correlation-only"),
  owner: battleReceiptSchema.shape.binding.shape.owner,
  generation: z.string().min(1),
  slot: z.enum(["frontend", "api"]),
  receipt: battleReceiptSchema,
  key: keySchema,
  deadline: z.strictObject({ domain: z.string().regex(/^mono-[a-f0-9]{32}$/u), ticksMs: millis }),
});
export type BattleProbeDescriptor = Readonly<z.infer<typeof descriptorSchema>>;
interface Dependencies {
  transport?: typeof directWebTransport;
  now?: () => number;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
export function parseBattleProbeDescriptor(value: unknown): BattleProbeDescriptor {
  const d = descriptorSchema.parse(value);
  if (
    d.receipt.clockDomain !== d.deadline.domain ||
    !same(d.owner, d.receipt.binding.owner) ||
    d.generation !== `${d.owner.jobId}:${d.owner.deployedAt}:${d.owner.unitHash}`
  )
    throw new Error("Foreign Battle probe descriptor.");
  validateBattleReceipt(
    d.receipt,
    d.owner,
    d.deadline.domain,
    new URL(d.receipt.binding.endpoints.frontend).origin,
  );
  service.parse(d.receipt.slots[d.slot].service);
  return freezeDeep(d);
}

function parseDescriptor(value: unknown, clock: OwnedSimulatorClock) {
  const descriptor = parseBattleProbeDescriptor(value);
  if (descriptor.deadline.domain !== clock.domain) throw new Error("Foreign Battle probe domain.");
  return descriptor;
}

/** Clock-independent journal validation, never authentication. */
export function validateBattleProbeSnapshot(value: unknown, descriptor: unknown, prior?: unknown) {
  const expected = parseBattleProbeDescriptor(descriptor);
  const previous = prior === undefined ? undefined : validateSnapshot(prior, expected);
  return freezeDeep(validateSnapshot(value, expected, previous));
}

/** Trusted orchestration only. Persist before dispatch; not a VM/scoring credential. */
export async function prepareBattleProbeDescriptor(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  owner: BattleDeploymentOwner,
  slot: Slot,
  budgetMs: number,
  dependencies: Dependencies = {},
): Promise<BattleProbeDescriptor> {
  if (slot !== "frontend" && slot !== "api") throw new Error("Invalid Battle slot.");
  const { receipt } = await resolveBattleBinding(settings, clock, owner, dependencies);
  const deadline = await requestBattleDeadline(settings, clock, budgetMs, dependencies);
  return parseDescriptor(
    {
      version: 1,
      kind: "battle-probe-correlation-only",
      owner,
      generation: `${owner.jobId}:${owner.deployedAt}:${owner.unitHash}`,
      slot,
      receipt,
      key: randomBytes(16).toString("hex"),
      deadline,
    },
    clock,
  );
}

function createProbeOperation(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  descriptor: BattleProbeDescriptor,
  dependencies: Dependencies,
  recovered = false,
  savedSnapshot?: unknown,
) {
  const expected = parseDescriptor(descriptor, clock);
  const { receipt, deadline, key, slot } = expected;
  const mapping = receipt.slots[slot];
  let attempted = recovered;
  let inFlight = false;
  let prior = savedSnapshot === undefined ? undefined : validateSnapshot(savedSnapshot, expected);
  async function command(kind: "start" | "read") {
    if (clock.domain !== deadline.domain) throw new Error("Foreign Battle probe domain.");
    if (inFlight) throw new Error("Battle probe request already in flight.");
    if (kind === "start" ? attempted : !attempted)
      throw new Error("Battle probe start may be attempted exactly once before reads.");
    attempted = true;
    inFlight = true;
    try {
      const value = await requestBattleCapability(
        settings,
        clock,
        `${receipt.handle}/${slot}/${kind}`,
        {
          version: 2,
          command: kind,
          binding: mapping.wireBinding,
          service: mapping.service.name,
          key,
          ...(kind === "start" ? { deadline } : {}),
        },
        dependencies,
      );
      prior = validateSnapshot(value, expected, prior);
      return {
        snapshot: structuredClone(prior),
        scoringQualified: false as const,
        battleAcceptancePassed: false as const,
      };
    } finally {
      inFlight = false;
    }
  }
  return Object.freeze({
    key,
    deadline,
    start: () => command("start"),
    read: () => command("read"),
  });
}

/** Reauthenticate even a trusted journal descriptor. Never starts, retries, or rebases a deadline. */
export async function resumeBattleProbeReadOnly(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  descriptor: unknown,
  savedSnapshot?: unknown,
  dependencies: Dependencies = {},
) {
  const expected = parseDescriptor(descriptor, clock);
  const prior = savedSnapshot === undefined ? undefined : validateSnapshot(savedSnapshot, expected);
  await authenticateBattleProbeDescriptor(settings, clock, expected, dependencies);
  const operation = createProbeOperation(settings, clock, expected, dependencies, true, prior);
  return Object.freeze({ key: operation.key, deadline: operation.deadline, read: operation.read });
}

/** Compatibility wrapper: one start attempt, then same-key reads, without automatic retries. */
export async function prepareBattleProbe(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  owner: BattleDeploymentOwner,
  slot: Slot,
  budgetMs: number,
  dependencies: Dependencies = {},
) {
  const descriptor = await prepareBattleProbeDescriptor(
    settings,
    clock,
    owner,
    slot,
    budgetMs,
    dependencies,
  );
  return createProbeOperation(settings, clock, descriptor, dependencies);
}

/** Trusted journal only: caller must durably claim start before invocation.
 * This stateless dispatch function does not itself enforce durable one-shot ownership.
 */
export async function dispatchClaimedBattleProbeStart(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  descriptor: unknown,
  dependencies: Dependencies = {},
) {
  const expected = parseDescriptor(descriptor, clock);
  return createProbeOperation(settings, clock, expected, dependencies).start();
}

/** Authentication only: no clock refresh, operation dispatch or descriptor rebinding. */
export async function authenticateBattleProbeDescriptor(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  descriptor: unknown,
  dependencies: Dependencies = {},
): Promise<BattleProbeDescriptor> {
  const expected = parseDescriptor(descriptor, clock);
  const { receipt } = await resolveBattleBinding(settings, clock, expected.owner, dependencies);
  if (!same(receipt, expected.receipt)) throw new Error("Battle probe receipt changed.");
  return parseDescriptor(expected, clock);
}
