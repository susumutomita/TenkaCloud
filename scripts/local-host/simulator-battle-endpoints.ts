import type { ResolvedEndpoint } from "../lib/resolve-endpoints";
import { HostError } from "./model";
import {
  type BattleRegistrationContext,
  registerBattleEndpoint,
} from "./simulator-battle-registration";
import { battleRegistrationLocator } from "./simulator-battle-uptime-target";

/** Private native participant adapter. Only the deployment's deterministic locator
 * is accepted; no participant URL is ever sent to a network probe. */
export async function ownedBattleEndpoints(
  context: BattleRegistrationContext,
  method: string,
  slot?: string,
  value?: unknown,
  dependencies: Parameters<typeof registerBattleEndpoint>[2] = {},
): Promise<{ teamId: string; endpoints: ResolvedEndpoint[] }> {
  const { target } = context.current();
  if (slot) {
    if (slot !== "frontend" && slot !== "api")
      throw new HostError(404, "Unknown Battle slot.", "unknown_slot");
    if (method === "DELETE" && context.remove) {
      context.signal.throwIfAborted();
      const current = context.current();
      context.remove({
        target: current.target,
        expectedRevision: current.revision,
        slot,
        providerDomain: context.clock.domain,
      });
    } else {
      if (method !== "POST")
        throw new HostError(
          409,
          "Owned Battle registration removal is not supported yet.",
          "registration_removal_not_supported",
        );
      if (value !== battleRegistrationLocator(target, slot))
        throw new HostError(400, "Use this deployment's Battle registration.", "invalid_url");
      await registerBattleEndpoint(context, { slot, locator: value }, dependencies);
    }
  } else if (method !== "GET") throw new HostError(404, "Unknown Battle endpoint operation.");
  const current = context.current().target;
  const endpoints = (["frontend", "api"] as const).map((slot) => {
    const locator = battleRegistrationLocator(current, slot);
    const registered = !!context.registrations.get(current, slot);
    return {
      slot,
      label: slot,
      overridable: false,
      defaultKey: "InstanceId",
      ownedBattleRegistration: { locator, registered },
      ...(registered ? { effectiveUrl: locator } : {}),
    };
  });
  return { teamId: current.owner.teamId, endpoints };
}
