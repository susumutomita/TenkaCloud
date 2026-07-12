import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, unlinkIfExists } from "./session-state";
import { createSimulatorClient } from "./simulator";
import { stopSimulatorLauncher } from "./simulator-launcher";
import type { SimulatorSessionRecord } from "./simulator-runtime";

/** Cleanup path used by `make local-down` after the detached API has crashed. */
export async function cleanupRecordedSimulatorSession(
  sessionPath: string,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  participantEnvPath = join(dirname(sessionPath), "simulator-native.env"),
): Promise<void> {
  if (!existsSync(sessionPath)) return;
  const recorded = readJson<SimulatorSessionRecord>(sessionPath);
  let firstError: unknown;
  for (const deployment of recorded.deployments) {
    try {
      await createSimulatorClient(
        recorded.launcher.baseUrl,
        fetchFn,
        deployment.launchToken,
      ).deleteWorld(deployment.worldId);
    } catch (error) {
      firstError ??= error;
    }
  }
  try {
    stopSimulatorLauncher(recorded.launcher, env);
  } catch (error) {
    firstError ??= error;
  }
  if (!firstError) {
    unlinkIfExists(sessionPath);
    unlinkIfExists(participantEnvPath);
  }
  if (firstError) throw firstError;
}
