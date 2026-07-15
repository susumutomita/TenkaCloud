import { randomUUID } from "node:crypto";
import { readPrivateJson, writePrivateJson } from "./session-state";
import {
  buildSimulatorCapabilityReport,
  type createSimulatorClient,
  parseSimulatorSnapshot,
  SIMULATOR_PROTOCOL_VERSION,
  type SimulatedCloudProblem,
  type SimulatorDeploymentResponse,
  type SimulatorSnapshot,
  type SimulatorWorldResponse,
} from "./simulator";
import { issueSimulatorLaunchToken, simulatorConsoleUrl } from "./simulator-auth";
import type { SimulatorLauncherRecord } from "./simulator-launcher";
import {
  type LocalSimulatorDeployment,
  SimulatorStartOwnershipError,
} from "./simulator-runtime-contract";
import { SimulatorRuntimeCore } from "./simulator-runtime-core";
import {
  DEPLOY_TIMEOUT_MS,
  deploymentError,
  positiveDuration,
  RETRY_DELAY_MS,
  safeMetadata,
  sleep,
  TOKEN_TTL_SECONDS,
} from "./simulator-runtime-shared";
import type {
  SimulatorCompletedSnapshotRestoreRecord,
  SimulatorPendingSnapshotRestoreRecord,
  SimulatorPendingWorldRecord,
} from "./simulator-session-record";

export abstract class SimulatorRuntimeLifecycle extends SimulatorRuntimeCore {
  protected async _preflight(
    problem: SimulatedCloudProblem,
    launcher: SimulatorLauncherRecord,
  ): Promise<void> {
    const capabilities = await this._client(launcher).capabilities();
    if (capabilities.protocolVersion !== SIMULATOR_PROTOCOL_VERSION) {
      throw new Error(
        `Simulator protocol ${capabilities.protocolVersion} does not match ${SIMULATOR_PROTOCOL_VERSION}`,
      );
    }
    const report = buildSimulatorCapabilityReport([problem.runtime], capabilities);
    if (!report.supported) {
      throw new Error(report.requirements.flatMap((item) => item.diagnostic ?? []).join("; "));
    }
  }

  protected async _deployment(
    client: ReturnType<typeof createSimulatorClient>,
    worldId: string,
    deploymentId: string,
    initial: SimulatorDeploymentResponse,
  ): Promise<SimulatorDeploymentResponse> {
    let current = initial;
    const deadline =
      Date.now() +
      positiveDuration(
        this.options.deploymentTimeoutMs,
        DEPLOY_TIMEOUT_MS,
        "Simulator deploy timeout",
      );
    while (current.status === "accepted" || current.status === "deploying") {
      if (Date.now() >= deadline) throw new Error("Simulator deployment readiness timed out");
      await sleep(
        positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
      );
      current = await client.getDeployment(worldId, deploymentId);
    }
    if (current.status !== "running") throw deploymentError(current);
    return current;
  }

  protected async _recoverOrCreateWorld(
    client: ReturnType<typeof createSimulatorClient>,
    pending: SimulatorPendingWorldRecord,
  ): Promise<SimulatorWorldResponse> {
    const errors: unknown[] = [];
    const request = {
      tenantId: "local",
      eventId: "local",
      teamId: "local",
      deploymentId: pending.deploymentId,
    } as const;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const recovered = await client.getWorldByDeployment(pending.deploymentId);
        if (recovered) return recovered;
      } catch (error) {
        errors.push(error);
      }
      try {
        return await client.createWorld(request);
      } catch (error) {
        errors.push(error);
      }
      await sleep(
        positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
      );
    }
    throw new SimulatorStartOwnershipError(errors);
  }

  async start(problem: SimulatedCloudProblem): Promise<LocalSimulatorDeployment> {
    return this._withLifecycle(() => this._withOperation(() => this._startUnlocked(problem)));
  }

  protected async _resumeDeployment(
    problem: SimulatedCloudProblem,
    existing: LocalSimulatorDeployment,
  ): Promise<LocalSimulatorDeployment> {
    try {
      const launcher = await this._readyLauncher();
      const renewed = this._renewDeploymentToken(problem.problemId);
      const client = this._client(launcher, renewed.launchToken);
      const current = await client.getDeployment(renewed.worldId, renewed.deploymentId);
      if (current.status !== "running") throw deploymentError(current);
      const recovered = {
        ...existing,
        ...renewed,
        status: current.status,
        outputs: await this._participantOutputs(problem, current.outputs),
        clockObservedAtMs: Number.isSafeInteger(renewed.clockObservedAtMs)
          ? renewed.clockObservedAtMs
          : Date.now(),
      };
      this._deployments.set(problem.problemId, recovered);
      this._persist();
      return recovered;
    } catch (error) {
      // This branch adopted a durable world before the current start call.
      // Keep the lifecycle slot owned until Stop explicitly reconciles it.
      throw new SimulatorStartOwnershipError([error]);
    }
  }

  protected async _launcherForWorldStart(
    problem: SimulatedCloudProblem,
    priorPending: SimulatorPendingWorldRecord | undefined,
  ): Promise<SimulatorLauncherRecord> {
    try {
      const launcher = await this._readyLauncher();
      await this._preflight(problem, launcher);
      return launcher;
    } catch (error) {
      if (priorPending) throw new SimulatorStartOwnershipError([error]);
      throw error;
    }
  }

  protected _protectPendingWorld(
    problem: SimulatedCloudProblem,
    priorPending: SimulatorPendingWorldRecord | undefined,
    launcher: SimulatorLauncherRecord,
  ): SimulatorPendingWorldRecord {
    const deploymentId = priorPending?.deploymentId ?? `local-${problem.problemId}-${randomUUID()}`;
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      { tenantId: "local", eventId: "local", teamId: "local", deploymentId },
      TOKEN_TTL_SECONDS,
    );
    const pending = { problemId: problem.problemId, deploymentId, launchToken };
    this._pendingWorldCreates.set(problem.problemId, pending);
    try {
      this._persist();
    } catch (persistError) {
      const errors: unknown[] = [persistError];
      try {
        this._persist();
      } catch (recoveryError) {
        errors.push(recoveryError);
      }
      throw new SimulatorStartOwnershipError(errors);
    }
    return pending;
  }

  protected async _prepareWorldStart(
    problem: SimulatedCloudProblem,
    priorPending: SimulatorPendingWorldRecord | undefined,
  ): Promise<PreparedWorldStart> {
    const launcher = await this._launcherForWorldStart(problem, priorPending);
    const pending = this._protectPendingWorld(problem, priorPending, launcher);
    return {
      launcher,
      pending,
      client: this._client(launcher, pending.launchToken),
    };
  }

  protected async _cleanupFailedWorldDeployment(
    problemId: string,
    client: SimulatorClient,
    worldId: string,
    startError: unknown,
  ): Promise<never> {
    const cleanupErrors: unknown[] = [];
    try {
      await this._closeDataPlaneListeners(problemId);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await client.deleteWorld(worldId);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const errors: unknown[] = [startError, ...cleanupErrors];
      this._persistRecovery(errors);
      throw new SimulatorStartOwnershipError(errors);
    }
    this._deployments.delete(problemId);
    this._pendingWorldCreates.delete(problemId);
    try {
      this._persist();
    } catch (recoveryError) {
      throw new AggregateError(
        [startError, recoveryError],
        "Simulator deployment failed and its deleted world could not be reconciled",
      );
    }
    throw startError;
  }

  protected async _deployWorld(
    problem: SimulatedCloudProblem,
    start: PreparedWorldStart,
    world: SimulatorWorldResponse,
  ): Promise<LocalSimulatorDeployment> {
    try {
      const provisional: LocalSimulatorDeployment = {
        problemId: problem.problemId,
        worldId: world.worldId,
        deploymentId: start.pending.deploymentId,
        launchToken: start.pending.launchToken,
        status: "accepted",
        outputs: {},
        consoleUrl: simulatorConsoleUrl(
          world.consoleUrl,
          start.pending.launchToken,
          start.launcher.baseUrl,
        ),
        nativeCredentials: start.launcher.nativeCredentials,
        clockObservedAtMs: Date.now(),
      };
      // Keep a complete recovery handle in memory as soon as the world exists.
      this._deployments.set(problem.problemId, provisional);
      this._pendingWorldCreates.delete(problem.problemId);
      const created = await start.client.createDeployment(world.worldId, {
        problemId: problem.problemId,
        runtime: problem.runtime,
        templateBody: problem.templateBody,
        metadata: safeMetadata(problem.metadata),
        ...(problem.simulationOverlay ? { simulationOverlay: problem.simulationOverlay } : {}),
      });
      const deployed = await this._deployment(
        start.client,
        world.worldId,
        start.pending.deploymentId,
        created,
      );
      const record: LocalSimulatorDeployment = {
        ...provisional,
        status: deployed.status,
        outputs: await this._participantOutputs(problem, deployed.outputs),
        clockObservedAtMs: Date.now(),
      };
      this._deployments.set(problem.problemId, record);
      this._persist();
      return record;
    } catch (error) {
      return this._cleanupFailedWorldDeployment(
        problem.problemId,
        start.client,
        world.worldId,
        error,
      );
    }
  }

  protected async _startUnlocked(
    problem: SimulatedCloudProblem,
  ): Promise<LocalSimulatorDeployment> {
    this._problems.set(problem.problemId, problem);
    if (this._pendingSnapshotRestores.has(problem.problemId)) {
      throw new SimulatorStartOwnershipError([
        new Error("Simulator snapshot restore still requires cleanup"),
      ]);
    }
    const existing = this._deployments.get(problem.problemId);
    if (existing) return this._resumeDeployment(problem, existing);
    const priorPending = this._pendingWorldCreates.get(problem.problemId);
    const start = await this._prepareWorldStart(problem, priorPending);
    const world = await this._recoverOrCreateWorld(start.client, start.pending);
    return this._deployWorld(problem, start, world);
  }

  async stop(problemId: string): Promise<void> {
    return this._withLifecycle(async () => {
      await this._closeDataPlaneListeners(problemId);
      return this._withOperation(() => this._stopUnlocked(problemId));
    });
  }

  protected _forgetProblem(problemId: string): void {
    this._deployments.delete(problemId);
    this._pendingWorldCreates.delete(problemId);
    this._pendingSnapshotRestores.delete(problemId);
    this._completedSnapshotRestores.delete(problemId);
    this._problems.delete(problemId);
  }

  protected async _stopPendingSnapshotRestore(
    problemId: string,
    pending: SimulatorPendingSnapshotRestoreRecord,
  ): Promise<void> {
    const launcher = this._launcher;
    if (!launcher) {
      throw new Error("Simulator snapshot restore ownership has no launcher for cleanup");
    }
    const deployment = this._deployments.get(problemId);
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: pending.deploymentId,
      },
      TOKEN_TTL_SECONDS,
    );
    const client = this._client(launcher, launchToken);
    let restoredWorldId = pending.restoredWorldId;
    if (!restoredWorldId) {
      const restored = await client.getSnapshotRestore(
        pending.sourceWorldId,
        pending.snapshotHash,
        pending.idempotencyKey,
      );
      if (restored) {
        restoredWorldId = restored.worldId;
        this._pendingSnapshotRestores.set(problemId, { ...pending, restoredWorldId });
        this._persist();
      }
    }
    const worldIds = new Set([
      pending.sourceWorldId,
      ...(restoredWorldId ? [restoredWorldId] : []),
      ...(deployment ? [deployment.worldId] : []),
    ]);
    for (const worldId of worldIds) await client.deleteWorld(worldId);
    this._forgetProblem(problemId);
    this._persist();
  }

  protected async _findPendingWorld(
    client: SimulatorClient,
    deploymentId: string,
  ): Promise<SimulatorWorldResponse | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const world = await client.getWorldByDeployment(deploymentId);
      if (world || attempt === 2) return world;
      await sleep(
        positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
      );
    }
    return undefined;
  }

  protected async _stopPendingWorld(
    problemId: string,
    pending: SimulatorPendingWorldRecord,
  ): Promise<void> {
    const launcher = this._launcher;
    if (!launcher) {
      throw new Error("Simulator pending world ownership has no launcher for cleanup");
    }
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: pending.deploymentId,
      },
      TOKEN_TTL_SECONDS,
    );
    this._pendingWorldCreates.set(problemId, { ...pending, launchToken });
    this._persist();
    const client = this._client(launcher, launchToken);
    const world = await this._findPendingWorld(client, pending.deploymentId);
    if (world) await client.deleteWorld(world.worldId);
    this._forgetProblem(problemId);
    this._persist();
  }

  protected _stopInactiveProblem(problemId: string): void {
    // A previous delete may have succeeded before its persistence failed.
    // Reconcile the protected/public generation instead of treating retry as a
    // no-op and leaving a deleted world in the on-disk record.
    this._completedSnapshotRestores.delete(problemId);
    if (this._launcher) this._persist();
    this._problems.delete(problemId);
  }

  protected async _stopActiveDeployment(problemId: string): Promise<void> {
    const launcher = this._launcher;
    if (!launcher) throw new Error("Simulator world ownership has no launcher for cleanup");
    const deployment = this._renewDeploymentToken(problemId);
    await this._client(launcher, deployment.launchToken).deleteWorld(deployment.worldId);
    this._forgetProblem(problemId);
    this._persist();
  }

  protected async _stopUnlocked(problemId: string): Promise<void> {
    const pendingRestore = this._pendingSnapshotRestores.get(problemId);
    if (pendingRestore) {
      return this._stopPendingSnapshotRestore(problemId, pendingRestore);
    }
    const pending = this._pendingWorldCreates.get(problemId);
    if (!this._deployments.has(problemId)) {
      if (pending) return this._stopPendingWorld(problemId, pending);
      this._stopInactiveProblem(problemId);
      return;
    }
    await this._stopActiveDeployment(problemId);
  }

  async reset(problem: SimulatedCloudProblem): Promise<LocalSimulatorDeployment> {
    return this._withLifecycle(async () => {
      await this._closeDataPlaneListeners(problem.problemId);
      return this._withOperation(async () => {
        await this._stopUnlocked(problem.problemId);
        return this._startUnlocked(problem);
      });
    });
  }

  async exportSnapshot(problemId: string, path: string): Promise<void> {
    return this._withOperation(() => this._exportSnapshotUnlocked(problemId, path));
  }

  protected async _exportSnapshotUnlocked(problemId: string, path: string): Promise<void> {
    if (!this._deployments.has(problemId) || !this._launcher)
      throw new Error(`Simulator problem is not running: ${problemId}`);
    const deployment = this._renewDeploymentToken(problemId);
    const snapshot = await this._client(this._launcher, deployment.launchToken).exportSnapshot(
      deployment.worldId,
    );
    writePrivateJson(path, snapshot);
  }

  protected async _recoverOrRestoreSnapshot(
    client: ReturnType<typeof createSimulatorClient>,
    pending: SimulatorPendingSnapshotRestoreRecord,
    snapshot: SimulatorSnapshot,
  ): Promise<SimulatorWorldResponse> {
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const recovered = await client.getSnapshotRestore(
          pending.sourceWorldId,
          pending.snapshotHash,
          pending.idempotencyKey,
        );
        if (recovered) return recovered;
      } catch (error) {
        errors.push(error);
      }
      try {
        return await client.importSnapshot(pending.sourceWorldId, snapshot, pending.idempotencyKey);
      } catch (error) {
        errors.push(error);
      }
      await sleep(
        positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
      );
    }
    throw new SimulatorStartOwnershipError(errors);
  }

  async importSnapshot(problemId: string, path: string): Promise<void> {
    return this._withLifecycle(() =>
      this._withOperation(() => this._importSnapshotUnlocked(problemId, path)),
    );
  }

  protected _completedRestoreMatches(
    completed: SimulatorCompletedSnapshotRestoreRecord | undefined,
    deployment: LocalSimulatorDeployment,
    snapshot: SimulatorSnapshot,
  ): completed is SimulatorCompletedSnapshotRestoreRecord {
    return (
      completed !== undefined &&
      completed.deploymentId === deployment.deploymentId &&
      completed.sourceWorldId === snapshot.worldId &&
      completed.snapshotHash === snapshot.hash
    );
  }

  protected async _reconcileCompletedSnapshotRestore(
    problemId: string,
    completed: SimulatorCompletedSnapshotRestoreRecord,
    deployment: LocalSimulatorDeployment,
    client: SimulatorClient,
  ): Promise<void> {
    if (deployment.worldId !== completed.restoredWorldId) {
      throw new SimulatorStartOwnershipError([
        new Error("Completed Simulator restore does not match the active world"),
      ]);
    }
    const restored = await client.getSnapshotRestore(
      completed.sourceWorldId,
      completed.snapshotHash,
      completed.idempotencyKey,
    );
    if (!restored || restored.worldId !== completed.restoredWorldId) {
      throw new SimulatorStartOwnershipError([
        new Error("Completed Simulator restore lookup is inconsistent"),
      ]);
    }
    const current = await client.getDeployment(restored.worldId, deployment.deploymentId);
    if (current.status !== "running") {
      throw new SimulatorStartOwnershipError([deploymentError(current)]);
    }
    if (this._pendingSnapshotRestores.has(problemId)) {
      this._pendingSnapshotRestores.delete(problemId);
      this._persist();
    }
  }

  protected _persistNewSnapshotOwnership(): void {
    try {
      this._persist();
    } catch (error) {
      const errors: unknown[] = [error];
      this._persistRecovery(errors);
      throw new SimulatorStartOwnershipError(errors);
    }
  }

  protected _pendingSnapshotRestore(
    problemId: string,
    deployment: LocalSimulatorDeployment,
    snapshot: SimulatorSnapshot,
  ): SimulatorPendingSnapshotRestoreRecord {
    const existing = this._pendingSnapshotRestores.get(problemId);
    const sourceWorldId = existing?.sourceWorldId ?? deployment.worldId;
    if (
      snapshot.protocolVersion !== SIMULATOR_PROTOCOL_VERSION ||
      snapshot.worldId !== sourceWorldId
    ) {
      throw new Error("Simulator snapshot does not match the running world and protocol");
    }
    if (
      existing &&
      (existing.deploymentId !== deployment.deploymentId || existing.snapshotHash !== snapshot.hash)
    ) {
      throw new SimulatorStartOwnershipError([
        new Error("A different Simulator snapshot restore still requires cleanup"),
      ]);
    }
    if (existing) return existing;
    const pending: SimulatorPendingSnapshotRestoreRecord = {
      problemId,
      deploymentId: deployment.deploymentId,
      sourceWorldId,
      snapshotHash: snapshot.hash,
      idempotencyKey: `restore-${snapshot.hash}`,
    };
    this._pendingSnapshotRestores.set(problemId, pending);
    this._persistNewSnapshotOwnership();
    return pending;
  }

  protected _protectRestoredWorld(
    problemId: string,
    pending: SimulatorPendingSnapshotRestoreRecord,
    restoredWorldId: string,
  ): SimulatorPendingSnapshotRestoreRecord {
    const dualOwnership = { ...pending, restoredWorldId };
    this._pendingSnapshotRestores.set(problemId, dualOwnership);
    this._persistNewSnapshotOwnership();
    return dualOwnership;
  }

  protected async _waitForRestoredDeployment(
    client: SimulatorClient,
    restoredWorldId: string,
    deploymentId: string,
    sourceWorldId: string,
    snapshot: SimulatorSnapshot,
    idempotencyKey: string,
  ): Promise<SimulatorDeploymentResponse> {
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await client.getDeployment(restoredWorldId, deploymentId);
        if (current.status === "running") return current;
        errors.push(deploymentError(current));
      } catch (error) {
        errors.push(error);
      }
      try {
        await client.importSnapshot(sourceWorldId, snapshot, idempotencyKey);
      } catch (error) {
        errors.push(error);
      }
      await sleep(
        positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
      );
    }
    throw new SimulatorStartOwnershipError(errors);
  }

  protected async _snapshotReplacement(
    problemId: string,
    deployment: LocalSimulatorDeployment,
    restored: SimulatorWorldResponse,
    restoredDeployment: SimulatorDeploymentResponse,
    launcher: SimulatorLauncherRecord,
  ): Promise<LocalSimulatorDeployment> {
    const problem = this._problems.get(problemId);
    return {
      ...deployment,
      worldId: restored.worldId,
      status: restoredDeployment.status,
      outputs: problem
        ? await this._participantOutputs(problem, restoredDeployment.outputs)
        : restoredDeployment.outputs,
      consoleUrl: simulatorConsoleUrl(
        restored.consoleUrl,
        deployment.launchToken,
        launcher.baseUrl,
      ),
      clockObservedAtMs: Date.now(),
    };
  }

  protected async _completeSnapshotRestore(
    problemId: string,
    deployment: LocalSimulatorDeployment,
    pending: SimulatorPendingSnapshotRestoreRecord,
    dualOwnership: SimulatorPendingSnapshotRestoreRecord,
    restoredWorldId: string,
    client: SimulatorClient,
  ): Promise<void> {
    await client.deleteWorld(pending.sourceWorldId);
    this._completedSnapshotRestores.set(problemId, {
      problemId,
      deploymentId: deployment.deploymentId,
      sourceWorldId: pending.sourceWorldId,
      restoredWorldId,
      snapshotHash: pending.snapshotHash,
      idempotencyKey: pending.idempotencyKey,
    });
    this._pendingSnapshotRestores.delete(problemId);
    try {
      this._persist();
    } catch (error) {
      // Keep the deleted source handle in memory so a retry can reconcile an
      // ambiguous protected/public generation without cloning another world.
      this._pendingSnapshotRestores.set(problemId, dualOwnership);
      throw new SimulatorStartOwnershipError([error]);
    }
  }

  protected async _importSnapshotUnlocked(problemId: string, path: string): Promise<void> {
    const launcher = this._launcher;
    if (!this._deployments.has(problemId) || !launcher)
      throw new Error(`Simulator problem is not running: ${problemId}`);
    const deployment = this._renewDeploymentToken(problemId);
    const snapshot = parseSimulatorSnapshot(readPrivateJson<unknown>(path, 16 * 1024 * 1024));
    const client = this._client(launcher, deployment.launchToken);
    const completed = this._completedSnapshotRestores.get(problemId);
    if (this._completedRestoreMatches(completed, deployment, snapshot)) {
      await this._reconcileCompletedSnapshotRestore(problemId, completed, deployment, client);
      return;
    }
    const pending = this._pendingSnapshotRestore(problemId, deployment, snapshot);
    const restored = await this._recoverOrRestoreSnapshot(client, pending, snapshot);
    if (restored.worldId === pending.sourceWorldId) {
      throw new SimulatorStartOwnershipError([
        new Error("Simulator snapshot restore must return a new world"),
      ]);
    }
    const dualOwnership = this._protectRestoredWorld(problemId, pending, restored.worldId);
    const restoredDeployment = await this._waitForRestoredDeployment(
      client,
      restored.worldId,
      deployment.deploymentId,
      pending.sourceWorldId,
      snapshot,
      pending.idempotencyKey,
    );
    const replacement = await this._snapshotReplacement(
      problemId,
      deployment,
      restored,
      restoredDeployment,
      launcher,
    );
    this._deployments.set(problemId, replacement);
    try {
      this._persist();
    } catch (error) {
      throw new SimulatorStartOwnershipError([error]);
    }
    await this._completeSnapshotRestore(
      problemId,
      deployment,
      pending,
      dualOwnership,
      restored.worldId,
      client,
    );
  }
}
