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

interface RecordedCleanupContext {
  readonly recorded: SimulatorSessionRecord;
  readonly fetchFn: typeof fetch;
  readonly requestTimeoutMs: number | undefined;
  readonly errors: unknown[];
}

function cleanupLaunchToken(recorded: SimulatorSessionRecord, deploymentId: string): string {
  return issueSimulatorLaunchToken(
    recorded.launcher.launchSecret,
    { tenantId: "local", eventId: "local", teamId: "local", deploymentId },
    86_400,
  );
}

function cleanupClient(context: RecordedCleanupContext, launchToken: string) {
  return createSimulatorClient(
    context.recorded.launcher.baseUrl,
    context.fetchFn,
    launchToken,
    context.requestTimeoutMs,
  );
}

async function cleanupPendingWorld(
  context: RecordedCleanupContext,
  pending: SimulatorPendingWorldRecord,
): Promise<SimulatorPendingWorldRecord | undefined> {
  const launchToken = cleanupLaunchToken(context.recorded, pending.deploymentId);
  const refreshed = { ...pending, launchToken };
  try {
    const client = cleanupClient(context, launchToken);
    const world = await client.getWorldByDeployment(pending.deploymentId);
    if (world) await client.deleteWorld(world.worldId);
    return undefined;
  } catch (error) {
    context.errors.push(error);
    return refreshed;
  }
}

async function cleanupPendingSnapshotRestore(
  context: RecordedCleanupContext,
  pending: SimulatorPendingSnapshotRestoreRecord,
): Promise<SimulatorPendingSnapshotRestoreRecord | undefined> {
  const launchToken = cleanupLaunchToken(context.recorded, pending.deploymentId);
  let refreshed = pending;
  try {
    const client = cleanupClient(context, launchToken);
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
    return undefined;
  } catch (error) {
    context.errors.push(error);
    return refreshed;
  }
}

function refreshedDeployment(
  recorded: SimulatorSessionRecord,
  deployment: SimulatorSessionDeploymentRecord,
): SimulatorSessionDeploymentRecord {
  const launchToken = cleanupLaunchToken(recorded, deployment.deploymentId);
  const previousConsole = new URL(deployment.consoleUrl);
  const consoleBase = new URL(
    `${previousConsole.pathname}${previousConsole.search}`,
    `${recorded.launcher.baseUrl}/`,
  );
  return {
    ...deployment,
    launchToken,
    consoleUrl: simulatorConsoleUrl(consoleBase.toString(), launchToken, recorded.launcher.baseUrl),
  };
}

async function cleanupDeployment(
  context: RecordedCleanupContext,
  deployment: SimulatorSessionDeploymentRecord,
): Promise<SimulatorSessionDeploymentRecord | undefined> {
  const refreshed = refreshedDeployment(context.recorded, deployment);
  try {
    await cleanupClient(context, refreshed.launchToken).deleteWorld(refreshed.worldId);
    return undefined;
  } catch (error) {
    context.errors.push(error);
    return refreshed;
  }
}

async function reconcileRecordedLauncher(
  context: RecordedCleanupContext,
  sessionPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await reconcileSimulatorLaunchIntent(sessionPath, context.recorded.launcher, env);
  } catch (error) {
    context.errors.push(error);
  }
}

async function stopRecordedLauncher(
  context: RecordedCleanupContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (context.errors.length > 0) return;
  try {
    await stopSimulatorLauncher(context.recorded.launcher, env);
  } catch (error) {
    context.errors.push(error);
  }
}

interface RemainingRecordedResources {
  readonly deployments: SimulatorSessionDeploymentRecord[];
  readonly pendingWorldCreates: SimulatorPendingWorldRecord[];
  readonly pendingSnapshotRestores: SimulatorPendingSnapshotRestoreRecord[];
}

function finishRecordedCleanup(
  context: RecordedCleanupContext,
  resources: RemainingRecordedResources,
  paths: readonly string[],
  sessionPath: string,
): void {
  if (context.errors.length === 0) {
    for (const path of paths) unlinkIfExists(path);
    return;
  }
  writeSimulatorSessionRecord(sessionPath, {
    ...context.recorded,
    ...resources,
  } satisfies SimulatorSessionRecord);
  throw new AggregateError(context.errors, "Recorded Simulator cleanup failed and can be retried");
}

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
  const context = { recorded, fetchFn, requestTimeoutMs, errors } satisfies RecordedCleanupContext;
  await reconcileRecordedLauncher(context, sessionPath, env);
  const remaining: SimulatorSessionDeploymentRecord[] = [];
  const remainingPending: SimulatorPendingWorldRecord[] = [];
  const remainingSnapshotRestores: SimulatorPendingSnapshotRestoreRecord[] = [];
  for (const pending of recorded.pendingWorldCreates ?? []) {
    const remainingRecord = await cleanupPendingWorld(context, pending);
    if (remainingRecord) remainingPending.push(remainingRecord);
  }
  for (const pending of recorded.pendingSnapshotRestores ?? []) {
    const remainingRecord = await cleanupPendingSnapshotRestore(context, pending);
    if (remainingRecord) remainingSnapshotRestores.push(remainingRecord);
  }
  for (const deployment of recorded.deployments) {
    const remainingRecord = await cleanupDeployment(context, deployment);
    if (remainingRecord) remaining.push(remainingRecord);
  }
  await stopRecordedLauncher(context, env);
  finishRecordedCleanup(
    context,
    {
      deployments: remaining,
      pendingWorldCreates: remainingPending,
      pendingSnapshotRestores: remainingSnapshotRestores,
    },
    [sessionPath, secretPath, intentPath, participantEnvPath],
    sessionPath,
  );
}
