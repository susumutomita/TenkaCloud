import { join } from "node:path";
import { startManagedSimulator } from "./managed-simulator";
import { assertSimulatorProxyDisabled, type SimulatorSettings } from "./simulator-hosting";
import { ensureOfficialSimulatorBinary } from "./simulator-release-lock";

interface Options {
  readonly dataDirectory: string;
  readonly simulator?: SimulatorSettings;
  readonly managedSimulator?: { readonly binary?: string; readonly update?: boolean };
}
interface Dependencies {
  readonly start?: typeof startManagedSimulator;
  readonly install?: typeof ensureOfficialSimulatorBinary;
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
    });
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
