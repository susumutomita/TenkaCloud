import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { unlinkIfExists } from "./session-state";
import { createSimulatorClient } from "./simulator";
import { issueSimulatorLaunchToken, simulatorConsoleUrl } from "./simulator-auth";
import {
  reconcileSimulatorLaunchIntent,
  simulatorLaunchIntentPath,
  stopSimulatorLauncher,
} from "./simulator-launcher";
import {
  readSimulatorSessionRecord,
  type SimulatorPendingSnapshotRestoreRecord,
  type SimulatorPendingWorldRecord,
  type SimulatorSessionDeploymentRecord,
  type SimulatorSessionRecord,
  simulatorSessionSecretPath,
  writeSimulatorSessionRecord,
} from "./simulator-session-record";

/** Cleanup path used by `make local-down` after the detached API has crashed. */
export async function cleanupRecordedSimulatorSession(
  sessionPath: string,
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  participantEnvPath = join(dirname(sessionPath), "simulator-native.env"),
  requestTimeoutMs?: number,
): Promise<void> {
  const secretPath = simulatorSessionSecretPath(sessionPath);
  const intentPath = simulatorLaunchIntentPath(sessionPath);
  if (!existsSync(sessionPath) && !existsSync(secretPath)) {
    await reconcileSimulatorLaunchIntent(sessionPath, undefined, env);
    unlinkIfExists(participantEnvPath);
    return;
  }
  const recorded = readSimulatorSessionRecord(sessionPath);
  const errors: unknown[] = [];
  try {
    await reconcileSimulatorLaunchIntent(sessionPath, recorded.launcher, env);
  } catch (error) {
    errors.push(error);
  }
  const remaining: SimulatorSessionDeploymentRecord[] = [];
  const remainingPending: SimulatorPendingWorldRecord[] = [];
  const remainingSnapshotRestores: SimulatorPendingSnapshotRestoreRecord[] = [];
  for (const pending of recorded.pendingWorldCreates ?? []) {
    const launchToken = issueSimulatorLaunchToken(
      recorded.launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: pending.deploymentId,
      },
      86_400,
    );
    const refreshed = { ...pending, launchToken };
    try {
      const client = createSimulatorClient(
        recorded.launcher.baseUrl,
        fetchFn,
        launchToken,
        requestTimeoutMs,
      );
      const world = await client.getWorldByDeployment(pending.deploymentId);
      if (world) await client.deleteWorld(world.worldId);
    } catch (error) {
      errors.push(error);
      remainingPending.push(refreshed);
    }
  }
  for (const pending of recorded.pendingSnapshotRestores ?? []) {
    const launchToken = issueSimulatorLaunchToken(
      recorded.launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: pending.deploymentId,
      },
      86_400,
    );
    let refreshed = pending;
    try {
      const client = createSimulatorClient(
        recorded.launcher.baseUrl,
        fetchFn,
        launchToken,
        requestTimeoutMs,
      );
      let restoredWorldId = pending.restoredWorldId;
      if (!restoredWorldId) {
        const restored = await client.getSnapshotRestore(
          pending.sourceWorldId,
          pending.snapshotHash,
          pending.idempotencyKey,
        );
        restoredWorldId = restored?.worldId;
        if (restoredWorldId) refreshed = { ...pending, restoredWorldId };
      }
      const worldIds = new Set([
        pending.sourceWorldId,
        ...(restoredWorldId ? [restoredWorldId] : []),
      ]);
      for (const worldId of worldIds) await client.deleteWorld(worldId);
    } catch (error) {
      errors.push(error);
      remainingSnapshotRestores.push(refreshed);
    }
  }
  for (const deployment of recorded.deployments) {
    const launchToken = issueSimulatorLaunchToken(
      recorded.launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: deployment.deploymentId,
      },
      86_400,
    );
    const previousConsole = new URL(deployment.consoleUrl);
    const consoleBase = new URL(
      `${previousConsole.pathname}${previousConsole.search}`,
      `${recorded.launcher.baseUrl}/`,
    );
    const refreshed = {
      ...deployment,
      launchToken,
      consoleUrl: simulatorConsoleUrl(
        consoleBase.toString(),
        launchToken,
        recorded.launcher.baseUrl,
      ),
    };
    try {
      await createSimulatorClient(
        recorded.launcher.baseUrl,
        fetchFn,
        launchToken,
        requestTimeoutMs,
      ).deleteWorld(refreshed.worldId);
    } catch (error) {
      errors.push(error);
      remaining.push(refreshed);
    }
  }
  if (errors.length === 0) {
    try {
      await stopSimulatorLauncher(recorded.launcher, env);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    unlinkIfExists(sessionPath);
    unlinkIfExists(secretPath);
    unlinkIfExists(intentPath);
    unlinkIfExists(participantEnvPath);
  } else {
    writeSimulatorSessionRecord(sessionPath, {
      ...recorded,
      deployments: remaining,
      pendingWorldCreates: remainingPending,
      pendingSnapshotRestores: remainingSnapshotRestores,
    } satisfies SimulatorSessionRecord);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Recorded Simulator cleanup failed and can be retried");
  }
}
