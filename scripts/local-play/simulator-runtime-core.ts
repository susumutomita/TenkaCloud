import { existsSync } from "node:fs";
import { unlinkIfExists, writePrivateText } from "./session-state";
import {
  createSimulatorClient,
  SIMULATOR_PROTOCOL_VERSION,
  type SimulatedCloudProblem,
} from "./simulator";
import {
  issueSimulatorLaunchToken,
  simulatorConsoleUrl,
  simulatorLaunchTokenExpiresAt,
} from "./simulator-auth";
import { rewriteSimulatorDataPlaneOutputs } from "./simulator-data-plane";
import {
  type SimulatorDataPlaneListener,
  startSimulatorDataPlaneListener,
} from "./simulator-data-plane-proxy";
import {
  clearSimulatorLaunchIntent,
  launchPreparedSimulator,
  prepareSimulatorLaunch,
  reconcileSimulatorLaunchIntent,
  type SimulatorLauncherRecord,
  stopSimulatorLauncher,
  writeSimulatorLaunchIntent,
} from "./simulator-launcher";
import { nativeTargets, simulatorNativeEnvironment } from "./simulator-native-environment";
import type {
  LaunchedSimulator,
  LocalSimulatorDeployment,
  SimulatorDataPlaneRoute,
  SimulatorRuntimeOptions,
} from "./simulator-runtime-contract";
import {
  DEPLOY_TIMEOUT_MS,
  positiveDuration,
  RETRY_DELAY_MS,
  START_TIMEOUT_MS,
  sleep,
  TOKEN_RENEW_WINDOW_MS,
  TOKEN_TTL_SECONDS,
} from "./simulator-runtime-shared";
import {
  readSimulatorSessionRecord,
  type SimulatorCompletedSnapshotRestoreRecord,
  type SimulatorPendingSnapshotRestoreRecord,
  type SimulatorPendingWorldRecord,
  type SimulatorSessionRecord,
  simulatorSessionSecretPath,
  writeSimulatorSessionRecord,
} from "./simulator-session-record";

export abstract class SimulatorRuntimeCore {
  protected readonly _deployments = new Map<string, LocalSimulatorDeployment>();
  protected readonly _problems = new Map<string, SimulatedCloudProblem>();
  protected _operationTail: Promise<void> = Promise.resolve();
  protected _lifecycleTail: Promise<void> = Promise.resolve();
  protected _launcher: SimulatorLauncherRecord | undefined;
  protected _launcherNeedsReplacement = false;
  protected readonly _pendingWorldCreates = new Map<string, SimulatorPendingWorldRecord>();
  protected readonly _pendingSnapshotRestores = new Map<
    string,
    SimulatorPendingSnapshotRestoreRecord
  >();
  protected readonly _completedSnapshotRestores = new Map<
    string,
    SimulatorCompletedSnapshotRestoreRecord
  >();
  protected readonly _dataPlaneListeners = new Map<
    string,
    Map<string, SimulatorDataPlaneListener>
  >();

  protected abstract _fixedDataPlaneRoute(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): SimulatorDataPlaneRoute;

  constructor(protected readonly options: SimulatorRuntimeOptions) {
    positiveDuration(options.startTimeoutMs, START_TIMEOUT_MS, "Simulator start timeout");
    positiveDuration(options.deploymentTimeoutMs, DEPLOY_TIMEOUT_MS, "Simulator deploy timeout");
    positiveDuration(options.requestTimeoutMs, 10_000, "Simulator request timeout");
    positiveDuration(options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay");
    if (
      existsSync(options.sessionPath) ||
      existsSync(simulatorSessionSecretPath(options.sessionPath))
    ) {
      const recorded = readSimulatorSessionRecord(options.sessionPath);
      this._launcher = recorded.launcher;
      this._launcherNeedsReplacement = recorded.launcherNeedsReplacement === true;
      for (const deployment of recorded.deployments) {
        this._deployments.set(deployment.problemId, deployment);
      }
      for (const pending of recorded.pendingWorldCreates ?? []) {
        this._pendingWorldCreates.set(pending.problemId, pending);
      }
      for (const pending of recorded.pendingSnapshotRestores ?? []) {
        this._pendingSnapshotRestores.set(pending.problemId, pending);
      }
      for (const completed of recorded.completedSnapshotRestores ?? []) {
        this._completedSnapshotRestores.set(completed.problemId, completed);
      }
    }
  }

  protected _persist(): void {
    if (!this._launcher) {
      if (
        this._deployments.size > 0 ||
        this._pendingWorldCreates.size > 0 ||
        this._pendingSnapshotRestores.size > 0
      ) {
        throw new Error("Simulator runtime ownership cannot be persisted without its launcher");
      }
      unlinkIfExists(this.options.sessionPath);
      unlinkIfExists(simulatorSessionSecretPath(this.options.sessionPath));
      if (this.options.participantEnvPath) unlinkIfExists(this.options.participantEnvPath);
      return;
    }
    writeSimulatorSessionRecord(
      this.options.sessionPath,
      {
        protocolVersion: SIMULATOR_PROTOCOL_VERSION,
        launcher: this._launcher,
        deployments: [...this._deployments.values()],
        ...(this._pendingWorldCreates.size > 0
          ? { pendingWorldCreates: [...this._pendingWorldCreates.values()] }
          : {}),
        ...(this._pendingSnapshotRestores.size > 0
          ? { pendingSnapshotRestores: [...this._pendingSnapshotRestores.values()] }
          : {}),
        ...(this._completedSnapshotRestores.size > 0
          ? { completedSnapshotRestores: [...this._completedSnapshotRestores.values()] }
          : {}),
        ...(this._launcherNeedsReplacement ? { launcherNeedsReplacement: true } : {}),
      } satisfies SimulatorSessionRecord,
      this.options.sessionWriteHooks,
    );
    if (this.options.participantEnvPath && this.options.nativeProxyBaseUrl) {
      const environment = simulatorNativeEnvironment(
        this._launcher,
        this._deployments,
        this._problems,
        this.options.nativeProxyBaseUrl,
      );
      if (environment) writePrivateText(this.options.participantEnvPath, environment);
      else unlinkIfExists(this.options.participantEnvPath);
    }
  }

  protected _client(launcher: SimulatorLauncherRecord, launchToken?: string) {
    return createSimulatorClient(
      launcher.baseUrl,
      this.options.fetchFn,
      launchToken,
      this.options.requestTimeoutMs,
    );
  }

  protected async _launchNewLauncher(): Promise<LaunchedSimulator> {
    const prepared = await prepareSimulatorLaunch(
      {
        stateDir: this.options.stateDir,
        logPath: this.options.logPath,
        workloadImages: this.options.workloadImages,
        env: this.options.env,
      },
      this.options.sessionPath,
    );
    if (prepared.kind === "external") return { launcher: prepared.launcher };
    writeSimulatorLaunchIntent(this.options.sessionPath, prepared.intent);
    let spawnAttempted = false;
    try {
      this.options.beforeLauncherSpawn?.(prepared.intent);
      spawnAttempted = true;
      const launcher = await launchPreparedSimulator(prepared.intent, this.options.env);
      this.options.onLauncherStarted?.(launcher);
      return { launcher, intent: prepared.intent };
    } catch (error) {
      const errors: unknown[] = [error];
      try {
        if (spawnAttempted) {
          await reconcileSimulatorLaunchIntent(
            this.options.sessionPath,
            undefined,
            this.options.env,
          );
        } else {
          clearSimulatorLaunchIntent(this.options.sessionPath);
        }
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Simulator launch failed and cleanup was incomplete");
      }
      throw error;
    }
  }

  protected async _cleanupUnpublishedDataPlaneListeners(
    problemId: string,
    listeners: Map<string, SimulatorDataPlaneListener>,
    startError: unknown,
  ): Promise<never> {
    const entries = [...listeners.entries()];
    const closed = await Promise.allSettled(entries.map(([, listener]) => listener.close()));
    const failed = new Map<string, SimulatorDataPlaneListener>();
    const errors: unknown[] = [startError];
    for (const [index, result] of closed.entries()) {
      if (result.status !== "rejected") continue;
      const entry = entries[index];
      if (entry) failed.set(...entry);
      errors.push(result.reason);
    }
    if (failed.size > 0) this._dataPlaneListeners.set(problemId, failed);
    if (errors.length === 1) throw startError;
    throw new AggregateError(errors, "Simulator data-plane listener startup cleanup failed");
  }

  protected async _ensureDataPlaneListeners(
    problem: SimulatedCloudProblem,
  ): Promise<Map<string, SimulatorDataPlaneListener>> {
    const existing = this._dataPlaneListeners.get(problem.problemId);
    const targets = nativeTargets(problem);
    if (existing) {
      if (targets.every((target) => existing.has(target.targetId))) return existing;
      throw new Error(`Simulator data-plane listener cleanup is incomplete: ${problem.problemId}`);
    }
    const listeners = new Map<string, SimulatorDataPlaneListener>();
    try {
      for (const target of targets) {
        const listener = await (
          this.options.startDataPlaneListener ?? startSimulatorDataPlaneListener
        )(async () => this._fixedDataPlaneRoute(problem, target.targetId), this.options.fetchFn);
        listeners.set(target.targetId, listener);
      }
    } catch (error) {
      return this._cleanupUnpublishedDataPlaneListeners(problem.problemId, listeners, error);
    }
    this._dataPlaneListeners.set(problem.problemId, listeners);
    return listeners;
  }

  protected async _participantOutputs(
    problem: SimulatedCloudProblem,
    outputs: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, string>>> {
    if (!this.options.nativeProxyBaseUrl) return outputs;
    const listeners = await this._ensureDataPlaneListeners(problem);
    return rewriteSimulatorDataPlaneOutputs(problem, outputs, (targetId) => {
      const listener = listeners.get(targetId);
      if (!listener) throw new Error(`Simulator target listener is missing: ${targetId}`);
      return listener.origin;
    });
  }

  protected async _closeDataPlaneListeners(problemId: string): Promise<void> {
    const listeners = this._dataPlaneListeners.get(problemId);
    if (!listeners) return;
    const entries = [...listeners.entries()];
    const closed = await Promise.allSettled(entries.map(([, listener]) => listener.close()));
    const errors: unknown[] = [];
    for (const [index, result] of closed.entries()) {
      const entry = entries[index];
      if (!entry) continue;
      const [targetId, listener] = entry;
      if (result.status === "fulfilled") {
        if (listeners.get(targetId) === listener) listeners.delete(targetId);
      } else {
        errors.push(result.reason);
      }
    }
    if (listeners.size === 0 && this._dataPlaneListeners.get(problemId) === listeners) {
      this._dataPlaneListeners.delete(problemId);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Simulator data-plane listener cleanup failed");
    }
  }

  protected async _closeAllDataPlaneListeners(): Promise<void> {
    const problemIds = [...this._dataPlaneListeners.keys()];
    const closed = await Promise.allSettled(
      problemIds.map((problemId) => this._closeDataPlaneListeners(problemId)),
    );
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Simulator data-plane listener cleanup failed");
    }
  }

  protected async _withOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._operationTail;
    let release = (): void => {
      // Replaced synchronously by the executor below; never actually called.
    };
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous
      .catch(() => {
        // Serialisation only: a failed predecessor must not poison the queue.
      })
      .then(() => active);
    this._operationTail = tail;
    await previous.catch(() => {
      // Wait for the predecessor to settle; its failure belongs to its own caller.
    });
    try {
      return await operation();
    } finally {
      release();
      if (this._operationTail === tail) this._operationTail = Promise.resolve();
    }
  }

  protected async _withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._lifecycleTail;
    let release = (): void => {
      // Replaced synchronously by the executor below; never actually called.
    };
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous
      .catch(() => {
        // Serialisation only: a failed predecessor must not poison the queue.
      })
      .then(() => active);
    this._lifecycleTail = tail;
    await previous.catch(() => {
      // Wait for the predecessor to settle; its failure belongs to its own caller.
    });
    try {
      return await operation();
    } finally {
      release();
      if (this._lifecycleTail === tail) this._lifecycleTail = Promise.resolve();
    }
  }

  protected _renewDeploymentToken(problemId: string): LocalSimulatorDeployment {
    const deployment = this._deployments.get(problemId);
    const launcher = this._launcher;
    if (!deployment || !launcher) {
      throw new Error(`Simulator problem is not running: ${problemId}`);
    }
    const expiresAt = simulatorLaunchTokenExpiresAt(deployment.launchToken, launcher.launchSecret);
    if (expiresAt !== undefined && expiresAt > Date.now() + TOKEN_RENEW_WINDOW_MS) {
      return deployment;
    }
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: deployment.deploymentId,
      },
      TOKEN_TTL_SECONDS,
    );
    const previousConsole = new URL(deployment.consoleUrl);
    const consoleBase = new URL(
      `${previousConsole.pathname}${previousConsole.search}`,
      `${launcher.baseUrl}/`,
    );
    const renewed = {
      ...deployment,
      launchToken,
      consoleUrl: simulatorConsoleUrl(consoleBase.toString(), launchToken, launcher.baseUrl),
      nativeCredentials: launcher.nativeCredentials,
    };
    this._deployments.set(problemId, renewed);
    this._persist();
    return renewed;
  }

  protected _deploymentForLauncher(
    deployment: LocalSimulatorDeployment,
    launcher: SimulatorLauncherRecord,
  ): LocalSimulatorDeployment {
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      {
        tenantId: "local",
        eventId: "local",
        teamId: "local",
        deploymentId: deployment.deploymentId,
      },
      TOKEN_TTL_SECONDS,
    );
    const previousConsole = new URL(deployment.consoleUrl);
    const consoleBase = new URL(
      `${previousConsole.pathname}${previousConsole.search}`,
      `${launcher.baseUrl}/`,
    );
    return {
      ...deployment,
      launchToken,
      consoleUrl: simulatorConsoleUrl(consoleBase.toString(), launchToken, launcher.baseUrl),
      nativeCredentials: launcher.nativeCredentials,
    };
  }

  protected _renewDeploymentsForLauncher(launcher: SimulatorLauncherRecord): void {
    for (const [problemId, deployment] of this._deployments) {
      this._deployments.set(problemId, this._deploymentForLauncher(deployment, launcher));
    }
  }

  protected async _stopUnpersistedLauncher(
    launcher: SimulatorLauncherRecord,
    errors: unknown[],
  ): Promise<boolean> {
    if (launcher.kind === "external") return true;
    try {
      await stopSimulatorLauncher(launcher, this.options.env);
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  }

  protected _clearUnpersistedLaunchIntent(
    launched: LaunchedSimulator,
    stopped: boolean,
    errors: unknown[],
  ): void {
    if (!stopped || !launched.intent) return;
    try {
      clearSimulatorLaunchIntent(this.options.sessionPath);
    } catch (error) {
      errors.push(error);
    }
  }

  protected _restorePreviousLauncher(
    launcher: SimulatorLauncherRecord | undefined,
    deployments: ReadonlyMap<string, LocalSimulatorDeployment>,
  ): void {
    this._launcher = launcher;
    this._launcherNeedsReplacement = true;
    this._deployments.clear();
    for (const [problemId, deployment] of deployments) {
      this._deployments.set(problemId, deployment);
    }
  }

  protected _persistRecovery(errors: unknown[]): void {
    try {
      this._persist();
    } catch (error) {
      errors.push(error);
    }
  }

  protected async _recoverReplacementPersistenceFailure(
    persistError: unknown,
    launched: LaunchedSimulator,
    previousLauncher: SimulatorLauncherRecord | undefined,
    previousDeployments: ReadonlyMap<string, LocalSimulatorDeployment>,
  ): Promise<never> {
    const errors: unknown[] = [persistError];
    const stopped = await this._stopUnpersistedLauncher(launched.launcher, errors);
    this._clearUnpersistedLaunchIntent(launched, stopped, errors);
    if (stopped) this._restorePreviousLauncher(previousLauncher, previousDeployments);
    this._persistRecovery(errors);
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Simulator replacement persistence failed and recovery was incomplete",
      );
    }
    throw persistError;
  }

  protected async _replaceLauncher(): Promise<void> {
    const previousLauncher = this._launcher;
    const previousDeployments = new Map(this._deployments);
    const launched = await this._launchNewLauncher();
    const replacement = launched.launcher;
    this._renewDeploymentsForLauncher(replacement);
    this._launcher = replacement;
    this._launcherNeedsReplacement = false;
    try {
      this._persist();
      if (launched.intent) {
        clearSimulatorLaunchIntent(this.options.sessionPath);
      }
    } catch (persistError) {
      await this._recoverReplacementPersistenceFailure(
        persistError,
        launched,
        previousLauncher,
        previousDeployments,
      );
    }
  }

  protected _releaseUnpersistedSessionFiles(errors: unknown[]): void {
    try {
      unlinkIfExists(this.options.sessionPath);
      unlinkIfExists(simulatorSessionSecretPath(this.options.sessionPath));
      if (this.options.participantEnvPath) unlinkIfExists(this.options.participantEnvPath);
    } catch (error) {
      errors.push(error);
    }
  }

  protected async _recoverNewLauncherPersistenceFailure(
    persistError: unknown,
    launched: LaunchedSimulator,
  ): Promise<never> {
    const errors: unknown[] = [persistError];
    const stopped = await this._stopUnpersistedLauncher(launched.launcher, errors);
    this._clearUnpersistedLaunchIntent(launched, stopped, errors);
    if (stopped) {
      this._launcher = undefined;
      this._launcherNeedsReplacement = false;
      this._releaseUnpersistedSessionFiles(errors);
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Simulator launcher persistence failed and cleanup was incomplete",
      );
    }
    throw persistError;
  }

  protected async _createAndPersistLauncher(): Promise<void> {
    const launched = await this._launchNewLauncher();
    this._launcher = launched.launcher;
    try {
      this._persist();
      if (launched.intent) clearSimulatorLaunchIntent(this.options.sessionPath);
    } catch (persistError) {
      await this._recoverNewLauncherPersistenceFailure(persistError, launched);
    }
  }

  protected async _markUnreadyLauncher(
    launcher: SimulatorLauncherRecord,
    readinessError: Error,
  ): Promise<never> {
    const errors: unknown[] = [readinessError];
    let launcherStopped = launcher.kind === "external";
    try {
      await stopSimulatorLauncher(launcher, this.options.env);
      launcherStopped = launcher.kind !== "external";
    } catch (error) {
      errors.push(error);
    }
    // An unready external record is stale even though its process remains
    // operator-owned. For an owned launcher, replace only after stop succeeds.
    this._launcherNeedsReplacement = launcher.kind === "external" || launcherStopped;
    this._persist();
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Simulator readiness failed and its launcher could not stop",
      );
    }
    throw readinessError;
  }

  protected async _waitForLauncherReady(
    launcher: SimulatorLauncherRecord,
  ): Promise<SimulatorLauncherRecord> {
    const deadline =
      Date.now() +
      positiveDuration(this.options.startTimeoutMs, START_TIMEOUT_MS, "Simulator start timeout");
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const capabilities = await this._client(launcher).capabilities();
        if (capabilities.protocolVersion !== SIMULATOR_PROTOCOL_VERSION) {
          throw new Error(
            `Simulator protocol ${capabilities.protocolVersion} does not match ${SIMULATOR_PROTOCOL_VERSION}`,
          );
        }
        return launcher;
      } catch (error) {
        lastError = error;
        await sleep(
          positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
        );
      }
    }
    return this._markUnreadyLauncher(
      launcher,
      new Error(
        `Simulator did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      ),
    );
  }

  protected async _readyLauncher(): Promise<SimulatorLauncherRecord> {
    await reconcileSimulatorLaunchIntent(
      this.options.sessionPath,
      this._launcher,
      this.options.env,
    );
    if (this._launcherNeedsReplacement) await this._replaceLauncher();
    if (!this._launcher) await this._createAndPersistLauncher();
    return this._waitForLauncherReady(this._launcher as SimulatorLauncherRecord);
  }
}
