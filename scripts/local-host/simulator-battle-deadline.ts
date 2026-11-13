import { randomBytes } from "node:crypto";
import type { directWebTransport } from "./direct-web-transport";
import { requestBattleCapability } from "./simulator-battle-capability";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";

/** One immutable provider-clock deadline. This is not clock/scoring qualification.
 * Charge the entire sample exchange against the requested budget, including
 * fractional milliseconds rounded up. Never rebase a retained operation key.
 */
export async function requestBattleDeadline(
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  budgetMs: number,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 8000)
    throw new Error("Battle probe budget must be 1 to 8000 milliseconds.");
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started)) throw new Error("Invalid local monotonic clock.");
  const nonce = randomBytes(32).toString("hex");
  const value = await requestBattleCapability(
    settings,
    clock,
    "clock",
    { version: 2, nonce },
    { ...dependencies, now },
  );
  const sample = clock.authenticateSample(value, nonce);
  const elapsed = now() - started;
  if (!Number.isFinite(elapsed) || elapsed < 0 || Math.ceil(elapsed) >= budgetMs)
    throw new Error("Battle probe budget exhausted while sampling clock.");
  const ticksMs = sample.ticksMs + budgetMs - Math.ceil(elapsed);
  if (!Number.isSafeInteger(ticksMs) || ticksMs >= sample.validUntilMs)
    throw new Error("Battle deadline exceeds authenticated clock validity.");
  return Object.freeze({ domain: clock.domain, ticksMs });
}
