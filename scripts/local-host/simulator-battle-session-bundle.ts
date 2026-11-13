import { type BattleDeploymentOwner, sealBattleBinding } from "./simulator-battle-binding";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";

interface OwnedBattleSession {
  readonly settings: SimulatorSettings;
  readonly clock: OwnedSimulatorClock;
  readonly signal: AbortSignal;
}
/** Private composition dependency only. Not a VM/scoring qualification or public setting. */
export interface OwnedBattleSessionBundle {
  assertActive(): void;
  cleanup(owner: BattleDeploymentOwner): Promise<{ sealed: true; joined: true }>;
  run<T>(work: (session: OwnedBattleSession) => T | Promise<T>): Promise<T>;
}
/** Only supply the clock delivered by the explicitly owned Simulator session.
 * No endpoint/configuration string can substitute for the private clock bootstrap.
 */
export function ownedBattleSessionBundle(
  settings: SimulatorSettings | undefined,
  signal: AbortSignal,
  clock?: OwnedSimulatorClock,
): OwnedBattleSessionBundle | undefined {
  if (!clock) return undefined;
  if (!settings) throw new Error("Owned Battle clock requires Simulator settings.");
  signal.throwIfAborted();
  const session = Object.freeze({ settings: Object.freeze({ ...settings }), clock, signal });
  // Capabilities are closure-held; JSON, object spread and inspection reveal no token/key/path.
  return Object.freeze({
    assertActive: () => signal.throwIfAborted(),
    async cleanup(owner: BattleDeploymentOwner) {
      signal.throwIfAborted();
      const result = await sealBattleBinding(session.settings, session.clock, owner);
      signal.throwIfAborted();
      return result;
    },
    async run<T>(work: (current: OwnedBattleSession) => T | Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const result = await work(session);
      signal.throwIfAborted();
      return result;
    },
  });
}

/** Keep the private dependency out of public option projections and announcement logs. */
export function withOwnedBattleSession<T extends object>(
  settings: T,
  bundle: OwnedBattleSessionBundle | undefined,
): T & { readonly ownedBattleSession?: OwnedBattleSessionBundle } {
  const composed = { ...settings };
  if (bundle)
    Object.defineProperty(composed, "ownedBattleSession", { value: bundle, enumerable: false });
  return composed;
}
