import { z } from "zod";
import type { directWebTransport } from "./direct-web-transport";
import { battleOwnerKey, resolveBattleBinding } from "./simulator-battle-binding";
import type { BattleRegistrationCommit } from "./simulator-battle-registration-commit";
import type { SimulatorBattleRegistrationStore } from "./simulator-battle-registration-store";
import {
  type BattleUptimeTarget,
  battleRegistrationLocator,
} from "./simulator-battle-uptime-target";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";

const participantInput = z.strictObject({
  slot: z.enum(["frontend", "api"]),
  locator: z.string().min(1).max(256),
});
const gateSchema = z.strictObject({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  target: z.strictObject({
    kind: z.literal("battle-deployment-correlation-only"),
    problemId: z.literal("hello-world-battle"),
    ownerKey: z.string().regex(/^[a-f0-9]{64}$/u),
    generation: z.string().min(1),
    owner: z.strictObject({
      eventId: z.string(),
      teamId: z.string(),
      jobId: z.string(),
      unitHash: z.string(),
      deployedAt: z.number(),
      stackId: z.string(),
      instanceId: z.string(),
    }),
  }),
});
export interface BattleRegistrationGate {
  readonly target: BattleUptimeTarget;
  readonly revision: number;
}
export interface BattleRegistrationContext {
  readonly settings: SimulatorSettings;
  readonly clock: OwnedSimulatorClock;
  readonly registrations: SimulatorBattleRegistrationStore;
  readonly signal: AbortSignal;
  /** Trusted synchronous atomic registration/revision writer; never participant supplied. */
  readonly commit: BattleRegistrationCommit;
  readonly remove?: (intent: Omit<Parameters<BattleRegistrationCommit>[0], "registeredAt">) => {
    revision: number;
  };
  /** Synchronously re-read the authenticated team's current DB state. Throw if
   * authentication, event gate, progression or complete/idle job checks fail.
   * The caller owns serialization and a revision token that changes for every
   * relevant authorization/registration change; a constant token is insufficient.
   * No transaction may remain open while this function awaits provider resolve.
   */
  readonly current: () => BattleRegistrationGate;
  /** Trusted wall-clock timestamp only; never derived from participant input. */
  readonly now?: () => number;
}
function currentSnapshot(current: BattleRegistrationContext["current"]) {
  // Parsing copies nested fields, pinning the before snapshot across await.
  const snapshot = gateSchema.parse(current());
  const { owner, ownerKey, generation } = snapshot.target;
  if (
    battleOwnerKey(owner) !== ownerKey ||
    generation !== `${owner.jobId}:${owner.deployedAt}:${owner.unitHash}`
  )
    throw new Error("Invalid Battle registration target correlation.");
  return snapshot;
}

/** Signed resolve followed by a synchronous, revalidated correlation write.
 * A saved registration is not a running-VM or scoring qualification claim.
 * This helper is opt-in composition only; it does not enable a catalog or route.
 */
export async function registerBattleEndpoint(
  context: BattleRegistrationContext,
  input: unknown,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
) {
  context.signal.throwIfAborted();
  const { slot, locator } = participantInput.parse(input);
  const before = currentSnapshot(context.current);
  if (locator !== battleRegistrationLocator(before.target, slot))
    throw new Error("Battle locator does not belong to this deployment and slot.");
  // Validate current relational ownership even when no registration exists yet.
  context.registrations.get(before.target, slot);
  const domain = context.clock.domain;
  context.signal.throwIfAborted();
  await resolveBattleBinding(context.settings, context.clock, before.target.owner, dependencies);
  context.signal.throwIfAborted();
  const after = currentSnapshot(context.current);
  if (JSON.stringify(before) !== JSON.stringify(after) || context.clock.domain !== domain)
    throw new Error("Battle registration authorization changed during provider resolution.");
  const registeredAt = new Date((context.now ?? Date.now)()).toISOString();
  context.signal.throwIfAborted();
  const committed = context.commit({
    target: after.target,
    expectedRevision: after.revision,
    providerDomain: domain,
    slot,
    registeredAt,
  });
  if (
    z.strictObject({ revision: z.literal(after.revision + 1) }).parse(committed).revision >
    Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid committed registration revision.");
  return Object.freeze({
    slot,
    locator,
    registeredAt,
    status: "correlation-registration-only" as const,
    scoringQualified: false as const,
    battleAcceptancePassed: false as const,
  });
}
