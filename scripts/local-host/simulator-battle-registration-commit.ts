import { z } from "zod";
import { HostError } from "./model";
import { SimulatorBattleProbeStore } from "./simulator-battle-probe-store";
import { SimulatorBattleRegistrationStore } from "./simulator-battle-registration-store";
import {
  type BattleUptimeTarget,
  battleRegistrationLocator,
} from "./simulator-battle-uptime-target";
import type { HostStore } from "./store";

export interface BattleRegistrationCommitIntent {
  readonly target: BattleUptimeTarget;
  readonly expectedRevision: number;
  readonly slot: "frontend" | "api";
  readonly providerDomain: string;
  readonly registeredAt: string;
}
export type BattleRegistrationCommit = (intent: BattleRegistrationCommitIntent) => {
  revision: number;
};
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);

/** Trusted signed-resolve orchestration only. Build the writer on this exact DB
 * so a foreign store cannot silently escape the transaction. No runtime qualification. */
export function createBattleRegistrationCommit(
  host: HostStore,
  providerDomain: string,
  requireIdleProbes = false,
): BattleRegistrationCommit {
  const registrations = new SimulatorBattleRegistrationStore(host, {
    kind: "owned-battle-registration-scope",
    providerDomain,
  });
  return (intent) =>
    host.transaction(() => {
      const expected = revisionSchema.parse(intent.expectedRevision);
      if (intent.providerDomain !== providerDomain)
        throw new Error("Foreign registration provider domain.");
      const { target, slot, registeredAt } = intent;
      const { eventId, teamId } = target.owner;
      if (requireIdleProbes) assertIdleParticipantProbes(host, eventId, teamId);
      const state = host.uptimeState(eventId, teamId, target.problemId);
      if (state.revision !== expected) throw new Error("Battle registration revision changed.");
      const input = {
        generation: target.generation,
        providerDomain,
        slot,
        locator: battleRegistrationLocator(target, slot),
        registeredAt,
      };
      registrations.put(target, input);
      const next = { ...state, revision: expected + 1 };
      host.putUptimeState(eventId, teamId, target.problemId, next);
      const saved = registrations.get(target, slot);
      if (
        !saved ||
        saved.generation !== input.generation ||
        saved.providerDomain !== providerDomain ||
        saved.locator !== input.locator ||
        saved.registeredAt !== registeredAt ||
        JSON.stringify(host.uptimeState(eventId, teamId, target.problemId)) !== JSON.stringify(next)
      )
        throw new Error("Battle registration atomic commit verification failed.");
      return { revision: next.revision };
    });
}

function assertIdleParticipantProbes(host: HostStore, eventId: string, teamId: string): void {
  const probes = new SimulatorBattleProbeStore(host, { kind: "owned-battle-probe-journal" });
  if (probes.active(eventId, teamId, "frontend") || probes.active(eventId, teamId, "api"))
    throw new HostError(
      409,
      "Battle probe is unresolved; registration must wait.",
      "battle_probe_pending",
    );
}

/** Removal is idle-only: never orphan an uncertain provider request by revising authorization.
 * Native HTTP/UI are intentionally not wired until their admission contract is reviewed. */
export function createBattleRegistrationRemoval(host: HostStore, providerDomain: string) {
  const registrations = new SimulatorBattleRegistrationStore(host, {
    kind: "owned-battle-registration-scope",
    providerDomain,
  });
  return (intent: Omit<BattleRegistrationCommitIntent, "registeredAt">) =>
    host.transaction(() => {
      const expected = revisionSchema.parse(intent.expectedRevision);
      if (intent.providerDomain !== providerDomain)
        throw new Error("Foreign registration provider domain.");
      const { target, slot } = intent;
      const { eventId, teamId } = target.owner;
      assertIdleParticipantProbes(host, eventId, teamId);
      const state = host.uptimeState(eventId, teamId, target.problemId);
      if (state.revision !== expected) throw new Error("Battle registration revision changed.");
      registrations.remove(target, slot);
      const next = { ...state, revision: expected + 1 };
      host.putUptimeState(eventId, teamId, target.problemId, next);
      if (
        registrations.get(target, slot) ||
        JSON.stringify(host.uptimeState(eventId, teamId, target.problemId)) !== JSON.stringify(next)
      )
        throw new Error("Battle registration removal atomic verification failed.");
      return { revision: next.revision };
    });
}
