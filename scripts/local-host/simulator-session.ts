import { copyFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { startManagedSimulator } from "./managed-simulator";
import { assertSimulatorProxyDisabled, type SimulatorSettings } from "./simulator-hosting";
import { ensureOfficialSimulatorBinary } from "./simulator-release-lock";

interface Options {
  readonly dataDirectory: string;
  readonly simulator?: SimulatorSettings;
  readonly managedSimulator?: {
    readonly binary?: string;
    readonly update?: boolean;
    readonly battleBundle?: string;
  };
}
interface Dependencies {
  readonly start?: typeof startManagedSimulator;
  readonly install?: typeof ensureOfficialSimulatorBinary;
}

const BATTLE_BUNDLE_BUILD =
  "python3 test/battle/image/build_bundle.py --out <path> in TenkaCloudSimulator (needs Go 1.26.11 and QEMU)";

/** Copy the Simulator state before a new version opens it; SQLite downgrade is not guaranteed. */
function backupSimulatorState(dataDirectory: string, from: string): void {
  const state = join(dataDirectory, "simulator", "practice.db");
  if (!lstatSync(state, { throwIfNoEntry: false })?.isFile()) return;
  copyFileSync(state, `${state}.${from}.bak`);
  console.log(`Simulator state copied to ${state}.${from}.bak before the update.`);
}

/** An explicit path must exist; otherwise the default directory is used only when present. */
function resolveBattleBundle(
  dataDirectory: string,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) {
    if (!lstatSync(explicit, { throwIfNoEntry: false }))
      throw new Error(`Battle bundle not found: ${explicit}`);
    return explicit;
  }
  const fallback = join(dataDirectory, "battle-bundle");
  if (lstatSync(fallback, { throwIfNoEntry: false })) return fallback;
  console.log(
    `Battle VM runtime: off. No bundle at ${fallback}; Battle problems stay unavailable. Build one with ${BATTLE_BUNDLE_BUILD}, or pass --battle-bundle <directory>.`,
  );
  return undefined;
}

/** Keep the native process alive until host operations drain, then stop only our child. */
export async function withSimulatorSession(
  options: Options,
  signal: AbortSignal,
  run: (settings: SimulatorSettings | undefined, signal: AbortSignal) => Promise<void>,
  dependencies: Dependencies = {},
): Promise<void> {
  if (signal.aborted) return;
  if (!options.managedSimulator) return run(options.simulator, signal);
  assertSimulatorProxyDisabled();
  const battleBundle = resolveBattleBundle(
    options.dataDirectory,
    options.managedSimulator.battleBundle,
  );
  const binary =
    options.managedSimulator.binary ??
    (await (dependencies.install ?? ensureOfficialSimulatorBinary)({
      cacheDirectory: join(options.dataDirectory, "simulator-binaries"),
      update: options.managedSimulator.update,
      checkLatest: true,
      beforeVersionChange: ({ from }) => backupSimulatorState(options.dataDirectory, from),
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
      ...(battleBundle ? { battleBundle } : {}),
    });
    if (battleBundle) console.log(`Battle VM runtime: ${battleBundle}`);
  } finally {
    signal.removeEventListener("abort", cancelStartup);
  }
  const running = new AbortController();
  const stop = () => running.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let finished = false;
  let unexpectedExit = false;
  void simulator.exited.then(() => {
    if (!finished && !signal.aborted) {
      unexpectedExit = true;
      stop();
    }
  });
  try {
    if (!signal.aborted) await run(simulator.settings, running.signal);
    if (unexpectedExit)
      throw new Error(
        "Managed Simulator exited unexpectedly. The local host was stopped; retained data and token remain. Restart make local after checking local resources. No real AWS fallback was attempted.",
      );
  } finally {
    finished = true;
    signal.removeEventListener("abort", stop);
    await simulator.stop();
  }
}
