import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, unlinkIfExists, writePrivateJson } from "./session-state";
import { createSimulatorClient } from "./simulator";
import { stopSimulatorLauncher } from "./simulator-launcher";
import type { SimulatorSessionRecord } from "./simulator-runtime";

/** Cleanup path used by `make local-down` after the detached API has crashed. */
export async function cleanupRecordedSimulatorSession(
  sessionPath: string,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  participantEnvPath = join(dirname(sessionPath), "simulator-native.env"),
  requestTimeoutMs?: number,
): Promise<void> {
  if (!existsSync(sessionPath)) return;
  const recorded = readJson<SimulatorSessionRecord>(sessionPath);
  const errors: unknown[] = [];
  const remaining = [];
  for (const deployment of recorded.deployments) {
    try {
      await createSimulatorClient(
        recorded.launcher.baseUrl,
        fetchFn,
        deployment.launchToken,
        requestTimeoutMs,
      ).deleteWorld(deployment.worldId);
    } catch (error) {
      errors.push(error);
      remaining.push(deployment);
    }
  }
  if (errors.length === 0) {
    try {
      stopSimulatorLauncher(recorded.launcher, env);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    unlinkIfExists(sessionPath);
    unlinkIfExists(participantEnvPath);
  } else {
    writePrivateJson(sessionPath, {
      ...recorded,
      deployments: remaining,
    } satisfies SimulatorSessionRecord);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Recorded Simulator cleanup failed and can be retried");
  }
}
