import { join } from "node:path";
import { startManagedSimulator } from "./managed-simulator";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import { assertSimulatorProxyDisabled, type SimulatorSettings } from "./simulator-hosting";
import type { OwnedSimulatorLaunchOptions } from "./simulator-owned-launch";
import { ensureOfficialSimulatorBinary } from "./simulator-release-lock";

interface Options {
  readonly dataDirectory: string;
  readonly simulator?: SimulatorSettings;
  readonly managedSimulator?: {
    readonly binary?: string;
    readonly update?: boolean;
    readonly battle?: OwnedSimulatorLaunchOptions;
  };
}
interface Dependencies {
  readonly start?: typeof startManagedSimulator;
  readonly install?: typeof ensureOfficialSimulatorBinary;
}

/** Keep the native process alive until host operations drain, then stop only our child. */
export async function withSimulatorSession(
  options: Options,
  signal: AbortSignal,
  run: (
    settings: SimulatorSettings | undefined,
    signal: AbortSignal,
    clock?: OwnedSimulatorClock,
    lifetime?: AbortSignal,
  ) => Promise<void>,
  dependencies: Dependencies = {},
): Promise<void> {
  if (signal.aborted) return;
  if (!options.managedSimulator) return run(options.simulator, signal);
  validateBattleSelection(options.managedSimulator);
  assertSimulatorProxyDisabled();
  const binary =
    options.managedSimulator.binary ??
    (await (dependencies.install ?? ensureOfficialSimulatorBinary)({
      cacheDirectory: join(options.dataDirectory, "simulator-binaries"),
      update: options.managedSimulator.update,
      signal,
    }));
  const startup = new AbortController();
  const cancelStartup = () => startup.abort();
  signal.addEventListener("abort", cancelStartup, { once: true });
  if (signal.aborted) startup.abort();
  let simulator: Awaited<ReturnType<typeof startManagedSimulator>>;
  try {
    simulator = await (dependencies.start ?? startManagedSimulator)({
      binary,
      dataDirectory: options.dataDirectory,
      signal: startup.signal,
      ...(options.managedSimulator.battle ? { battle: options.managedSimulator.battle } : {}),
    });
  } finally {
    signal.removeEventListener("abort", cancelStartup);
  }
  const running = new AbortController();
  const lifetime = new AbortController();
  const stop = () => running.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let finished = false;
  let unexpectedExit = false;
  void simulator.exited.then(() => {
    if (!finished) {
      unexpectedExit = !signal.aborted;
      lifetime.abort();
      stop();
    }
  });
  try {
    const clock = sessionClock(options.managedSimulator.battle, simulator.clock);
    if (!signal.aborted) await run(simulator.settings, running.signal, clock, lifetime.signal);
    if (unexpectedExit)
      throw new Error(
        "Managed Simulator exited unexpectedly. The local host was stopped; retained data and token remain. Restart make local after checking local resources. No real AWS fallback was attempted.",
      );
  } finally {
    finished = true;
    running.abort();
    lifetime.abort();
    signal.removeEventListener("abort", stop);
    await simulator.stop();
  }
}

function validateBattleSelection(managed: NonNullable<Options["managedSimulator"]>) {
  if (managed.battle && (!managed.binary?.trim() || managed.update))
    throw new Error("Battle requires an explicit pinned binary and forbids release updates.");
}
function sessionClock(
  battle: OwnedSimulatorLaunchOptions | undefined,
  clock: OwnedSimulatorClock | undefined,
) {
  if (!battle) return undefined;
  if (!clock) throw new Error("Battle requires an owned Simulator clock.");
  return clock;
}
