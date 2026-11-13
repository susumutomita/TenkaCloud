import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BattleDeploymentOwner } from "../simulator-battle-binding";
import { inspectBattleCapability } from "../simulator-battle-capability";
import { prepareBattleProbe } from "../simulator-battle-probe";
import type { OwnedSimulatorClock } from "../simulator-clock-bootstrap";
import type { SimulatorSettings } from "../simulator-hosting";
import type { OwnedSimulatorLaunchOptions } from "../simulator-owned-launch";
import { withSimulatorSession } from "../simulator-session";

interface Options {
  readonly binary: string;
  readonly battle: OwnedSimulatorLaunchOptions;
  readonly signal: AbortSignal;
}
export interface ManagedBattleFixture {
  readonly settings: SimulatorSettings;
  readonly clock: OwnedSimulatorClock;
  readonly signal: AbortSignal;
  readonly stateDirectory: string;
  readonly status: "runtime-session-only-unqualified";
  readonly battleAcceptancePassed: false;
  prepareProbe(
    owner: BattleDeploymentOwner,
    slot: "frontend" | "api",
    budgetMs: number,
  ): Promise<Awaited<ReturnType<typeof prepareBattleProbe>>>;
}
interface Dependencies {
  readonly createDirectory?: () => string;
  readonly session?: typeof withSimulatorSession;
  readonly inspect?: typeof inspectBattleCapability;
  readonly prepare?: typeof prepareBattleProbe;
}
/** No Host facade or catalog acquisition. Session owns child cleanup; retain state for diagnosis. */
export async function withManagedBattleFixture(
  options: Options,
  run: (fixture: ManagedBattleFixture) => Promise<void>,
  dependencies: Dependencies = {},
) {
  options.signal.throwIfAborted();
  if (!options.binary.trim() || !options.battle.runtimeConfigPath.trim())
    throw new Error("Battle fixture requires explicit binary and pinned runtime configuration.");
  const stateDirectory = (dependencies.createDirectory ?? freshDirectory)();
  let entered = false;
  await (dependencies.session ?? withSimulatorSession)(
    {
      dataDirectory: stateDirectory,
      managedSimulator: { binary: options.binary, battle: options.battle },
    },
    options.signal,
    async (settings, signal, clock) => {
      if (!settings || !clock) throw new Error("Owned Battle session evidence missing.");
      signal.throwIfAborted();
      const availability = await (dependencies.inspect ?? inspectBattleCapability)(settings, clock);
      if (
        availability?.configured !== true ||
        availability.kind !== "authenticated-battle-availability"
      )
        throw new Error("Authenticated Battle availability missing.");
      signal.throwIfAborted();
      entered = true;
      await runBoundFixture(run, settings, clock, signal, stateDirectory, dependencies);
    },
  );
  if (!entered) throw new Error("Battle fixture did not enter an owned runtime session.");
  return {
    stateDirectory,
    status: "runtime-session-only-unqualified" as const,
    battleAcceptancePassed: false as const,
    physicalCleanupVerified: false as const,
  };
}
async function runBoundFixture(
  run: (fixture: ManagedBattleFixture) => Promise<void>,
  settings: SimulatorSettings,
  clock: OwnedSimulatorClock,
  signal: AbortSignal,
  stateDirectory: string,
  dependencies: Dependencies,
) {
  let active = true;
  const assertActive = () => {
    signal.throwIfAborted();
    if (!active) throw new Error("Battle fixture callback has ended.");
  };
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    assertActive();
    const value = await action();
    assertActive();
    return value;
  }
  try {
    await run({
      settings,
      clock,
      signal,
      stateDirectory,
      status: "runtime-session-only-unqualified",
      battleAcceptancePassed: false,
      prepareProbe: async (owner, slot, budgetMs) => {
        const operation = await guarded(() =>
          (dependencies.prepare ?? prepareBattleProbe)(settings, clock, owner, slot, budgetMs),
        );
        return Object.freeze({
          key: operation.key,
          deadline: operation.deadline,
          start: () => guarded(() => operation.start()),
          read: () => guarded(() => operation.read()),
        });
      },
    });
    assertActive();
  } finally {
    active = false;
  }
}
function freshDirectory() {
  return realpathSync(mkdtempSync(join(tmpdir(), "tenka-battle-runtime-")));
}
