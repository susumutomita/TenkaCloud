import { createHash } from "node:crypto";
import { z } from "zod";
import type { directWebTransport } from "./direct-web-transport";
import { requestBattleCapability } from "./simulator-battle-capability";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";

const text = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (s) => s.trim() === s && Buffer.byteLength(s) <= 1024 && !/[\p{Cc}\p{Cs}\uFFFD]/u.test(s),
  );
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const ownerSchema = z.strictObject({
  eventId: text,
  teamId: text,
  jobId: text,
  unitHash: hex,
  deployedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  stackId: text,
  instanceId: text,
});
export type BattleDeploymentOwner = z.infer<typeof ownerSchema>;
const lease = z.strictObject({ id: text, incarnation: text });
const target = z.strictObject({
  localIP: text,
  peerIP: text,
  localMAC: text,
  peerMAC: text,
  peerPort: z.number().int().min(1).max(65535),
  path: z.enum(["/", "/healthz"]),
});
const nonzero = hex.refine((s) => /[1-9a-f]/u.test(s));
const wire = z.strictObject({
  owner: nonzero,
  deployment: nonzero,
  lease: nonzero,
  backendIncarnation: nonzero,
});
const mapping = z.strictObject({
  wireBinding: wire,
  service: z.strictObject({
    name: text,
    port: z.number().int().min(1).max(65535),
    path: z.enum(["/", "/healthz"]),
  }),
  binding: z.strictObject({
    owner: ownerSchema,
    lease,
    slot: z.enum(["frontend", "api"]),
    backendIncarnation: nonzero,
    target,
  }),
});
export const battleReceiptSchema = z.strictObject({
  version: z.literal(1),
  handle: z.string().regex(/^[a-f0-9]{64}$/u),
  clockDomain: text,
  binding: z.strictObject({
    owner: ownerSchema,
    lease,
    endpoints: z.strictObject({ frontend: text, api: text }),
  }),
  slots: z.strictObject({ frontend: mapping, api: mapping }),
});
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** Key is correlation only. Only the authenticated provider may associate actual VM authority. */
export function battleOwnerKey(owner: BattleDeploymentOwner) {
  const o = ownerSchema.parse(owner);
  const hash = createHash("sha256");
  for (const value of [
    o.eventId,
    o.teamId,
    o.jobId,
    o.unitHash,
    String(o.deployedAt),
    o.stackId,
    o.instanceId,
  ])
    hash.update(`${Buffer.byteLength(value)}:${value}`);
  return hash.digest("hex");
}
/** Resolves real provider receipt, but deliberately grants no probe/scoring authority. */
export async function resolveBattleBinding(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  owner: BattleDeploymentOwner,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
) {
  const expected = ownerSchema.parse(owner);
  const receipt = battleReceiptSchema.parse(
    await requestBattleCapability(
      settings,
      clock,
      "resolve",
      { version: 1, owner: expected, key: battleOwnerKey(expected) },
      dependencies,
    ),
  );
  validateBattleReceipt(receipt, expected, clock.domain, settings.endpoint);
  return { receipt, scoringQualified: false as const, battleAcceptancePassed: false as const };
}

/** Structural binding validation only; does not authenticate a saved receipt. */
export function validateBattleReceipt(
  value: unknown,
  owner: BattleDeploymentOwner,
  domain: string,
  endpoint: string,
) {
  const receipt = battleReceiptSchema.parse(value);
  const expected = ownerSchema.parse(owner);
  if (receipt.clockDomain !== domain || !same(receipt.binding.owner, expected))
    throw new Error("Foreign Battle receipt.");
  for (const slot of ["frontend", "api"] as const) {
    const m = receipt.slots[slot];
    const path = slot === "frontend" ? "/" : "/healthz";
    if (
      !same(m.binding.owner, expected) ||
      !same(m.binding.lease, receipt.binding.lease) ||
      m.binding.slot !== slot ||
      m.binding.backendIncarnation !== m.wireBinding.backendIncarnation ||
      m.binding.lease.incarnation !== m.wireBinding.lease ||
      m.service.port !== m.binding.target.peerPort ||
      m.service.path !== path ||
      m.binding.target.path !== path ||
      receipt.binding.endpoints[slot] !==
        `${new URL(endpoint).origin}/_simulator/v1/battle-capabilities/${receipt.handle}/${slot}`
    )
      throw new Error("Inconsistent Battle receipt binding.");
  }
  if (!same(receipt.slots.frontend.wireBinding, receipt.slots.api.wireBinding))
    throw new Error("Split Battle backend binding.");
  return receipt;
}

/** Seal and join this exact retained owner through the authenticated provider.
 * No resolve-before-seal: a sealed binding cannot resolve on retry. A rejected,
 * lost or partial response leaves cleanup unconfirmed; never release ownership.
 */
export async function sealBattleBinding(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  owner: BattleDeploymentOwner,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
) {
  const expected = ownerSchema.parse(owner);
  return z
    .strictObject({ sealed: z.literal(true), joined: z.literal(true) })
    .parse(
      await requestBattleCapability(
        settings,
        clock,
        "seal",
        { version: 1, owner: expected, key: battleOwnerKey(expected) },
        dependencies,
      ),
    );
}
