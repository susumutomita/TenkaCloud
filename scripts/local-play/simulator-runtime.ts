import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { StatusCodes } from "http-status-codes";
import type {
  AttackProbeRequest,
  AuthoritativeEndpointPlacement,
  ProbeResult,
} from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/shared";
import { parseLoopbackUrl } from "./loopback";
import {
  readPrivateJson,
  unlinkIfExists,
  writePrivateJson,
  writePrivateText,
} from "./session-state";
import {
  buildSimulatorCapabilityReport,
  createSimulatorClient,
  parseSimulatorSnapshot,
  SIMULATOR_PROTOCOL_VERSION,
  type SimulatedCloudProblem,
  type SimulatorClockAdvanceResponse,
  type SimulatorDeploymentResponse,
  SimulatorHttpError,
  type SimulatorSnapshot,
  type SimulatorWorldResponse,
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
  type SimulatorOwnedLaunchIntent,
  stopSimulatorLauncher,
  writeSimulatorLaunchIntent,
} from "./simulator-launcher";
import {
  nativeTargets,
  type SimulatorNativeRoute,
  simulatorNativeEnvironment,
} from "./simulator-native-environment";
import {
  simulatorDisruptionCommand,
  simulatorScoringAttackProbeCommand,
  simulatorScoringContract,
} from "./simulator-scoring";
import {
  readSimulatorSessionRecord,
  type SimulatorCompletedSnapshotRestoreRecord,
  type SimulatorPendingSnapshotRestoreRecord,
  type SimulatorPendingWorldRecord,
  type SimulatorSessionDeploymentRecord,
  type SimulatorSessionRecord,
  type SimulatorSessionWriteHooks,
  simulatorSessionSecretPath,
  writeSimulatorSessionRecord,
} from "./simulator-session-record";

export { cleanupRecordedSimulatorSession } from "./simulator-session-cleanup";
export type { SimulatorSessionRecord } from "./simulator-session-record";

const START_TIMEOUT_MS = 15_000;
const DEPLOY_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 100;
const TOKEN_TTL_SECONDS = 86_400;
const TOKEN_RENEW_WINDOW_MS = 60 * 60 * 1_000;

export interface LocalSimulatorDeployment extends SimulatorSessionDeploymentRecord {}

export interface SimulatorDataPlaneRoute {
  readonly upstreamBaseUrl: string;
  readonly worldId: string;
  readonly deploymentId: string;
  readonly targetId: string;
  readonly provider: string;
  readonly launchToken: string;
}

export interface LocalSimulatorRuntimePort {
  readonly start: (problem: SimulatedCloudProblem) => Promise<LocalSimulatorDeployment>;
  readonly stop: (problemId: string) => Promise<void>;
  readonly reset: (problem: SimulatedCloudProblem) => Promise<LocalSimulatorDeployment>;
  readonly exportSnapshot: (problemId: string, path: string) => Promise<void>;
  readonly importSnapshot: (problemId: string, path: string) => Promise<void>;
  readonly advanceClock: (
    problemId: string,
    nowMs: number,
  ) => Promise<SimulatorClockAdvanceResponse | undefined>;
  readonly fireDisruption: (
    problem: SimulatedCloudProblem,
    disruptionId: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly attackProbe: (
    problem: SimulatedCloudProblem,
    request: AttackProbeRequest,
    observedAtMs: number,
  ) => Promise<ProbeResult>;
  readonly endpointPlacements?: (
    problem: SimulatedCloudProblem,
    slots: readonly string[],
    observedAtMs: number,
  ) => Promise<readonly AuthoritativeEndpointPlacement[]>;
  readonly nativeRoute: (
    problem: SimulatedCloudProblem,
    targetId: string,
  ) => Promise<SimulatorNativeRoute>;
  readonly dataPlaneRoute: (
    problem: SimulatedCloudProblem,
    targetId: string,
  ) => Promise<SimulatorDataPlaneRoute>;
  readonly consoleUrl: (problemId: string) => Promise<string>;
  readonly refreshAccess: (problemId: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** A failed Simulator start still owns a world that must be stopped before retrying. */
export class SimulatorStartOwnershipError extends AggregateError {
  readonly retainsOwnership = true;

  constructor(errors: readonly unknown[]) {
    super(errors, "Simulator deployment failed and its world still requires cleanup");
  }
}

export interface SimulatorRuntimeOptions {
  readonly sessionPath: string;
  readonly stateDir: string;
  readonly logPath: string;
  /** Digest-pinned workload images collected from the validated local catalog. */
  readonly workloadImages?: readonly string[];
  readonly participantEnvPath?: string;
  /** Local participant API origin hosting the header-injecting native route proxy. */
  readonly nativeProxyBaseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  /** Test seams; production uses the bounded defaults above. */
  readonly startTimeoutMs?: number;
  readonly deploymentTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly retryDelayMs?: number;
  /** Failure-injection seam for crash-consistency tests. */
  readonly sessionWriteHooks?: SimulatorSessionWriteHooks;
  /** Observability seam used to prove failed first persistence cannot orphan an owned launcher. */
  readonly onLauncherStarted?: (launcher: SimulatorLauncherRecord) => void;
  /** Failure-injection seam after the durable intent commits but before spawn. */
  readonly beforeLauncherSpawn?: (intent: SimulatorOwnedLaunchIntent) => void;
  /** Failure-injection seam for retryable session-file release after launcher stop. */
  readonly beforeSessionRelease?: () => void;
  /** Failure-injection seam for isolated data-plane listener lifecycle tests. */
  readonly startDataPlaneListener?: typeof startSimulatorDataPlaneListener;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function deploymentError(deployment: SimulatorDeploymentResponse): Error {
  const diagnostic = deployment.diagnostics?.map((item) => item.message).join("; ");
  return new Error(
    diagnostic
      ? `Simulator deployment ${deployment.status}: ${diagnostic}`
      : `Simulator deployment entered ${deployment.status}`,
  );
}

function safeMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  // JSON round-trip rejects functions, BigInts, cycles, and other non-wire values
  // before an external boundary sees them.
  return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, unknown>>;
}

function internalProviderIdempotencyKey(
  launcher: SimulatorLauncherRecord,
  domain: "attack-probe" | "endpoint-placement",
  parts: readonly string[],
): string {
  const digest = createHmac("sha256", launcher.launchSecret)
    .update(JSON.stringify({ domain, parts }))
    .digest("base64url");
  return `tenkacloud-internal-${domain}-${digest}`;
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return duration;
}

export class SimulatorLocalRuntime implements LocalSimulatorRuntimePort {
  readonly #deployments = new Map<string, LocalSimulatorDeployment>();
  readonly #problems = new Map<string, SimulatedCloudProblem>();
  #operationTail: Promise<void> = Promise.resolve();
  #lifecycleTail: Promise<void> = Promise.resolve();
  #launcher: SimulatorLauncherRecord | undefined;
  #launcherNeedsReplacement = false;
  readonly #pendingWorldCreates = new Map<string, SimulatorPendingWorldRecord>();
  readonly #pendingSnapshotRestores = new Map<string, SimulatorPendingSnapshotRestoreRecord>();
  readonly #completedSnapshotRestores = new Map<string, SimulatorCompletedSnapshotRestoreRecord>();
  readonly #dataPlaneListeners = new Map<string, Map<string, SimulatorDataPlaneListener>>();

  constructor(private readonly options: SimulatorRuntimeOptions) {
    positiveDuration(options.startTimeoutMs, START_TIMEOUT_MS, "Simulator start timeout");
    positiveDuration(options.deploymentTimeoutMs, DEPLOY_TIMEOUT_MS, "Simulator deploy timeout");
    positiveDuration(options.requestTimeoutMs, 10_000, "Simulator request timeout");
    positiveDuration(options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay");
    if (
      existsSync(options.sessionPath) ||
      existsSync(simulatorSessionSecretPath(options.sessionPath))
    ) {
      const recorded = readSimulatorSessionRecord(options.sessionPath);
      this.#launcher = recorded.launcher;
      this.#launcherNeedsReplacement = recorded.launcherNeedsReplacement === true;
      for (const deployment of recorded.deployments) {
        this.#deployments.set(deployment.problemId, deployment);
      }
      for (const pending of recorded.pendingWorldCreates ?? []) {
        this.#pendingWorldCreates.set(pending.problemId, pending);
      }
      for (const pending of recorded.pendingSnapshotRestores ?? []) {
        this.#pendingSnapshotRestores.set(pending.problemId, pending);
      }
      for (const completed of recorded.completedSnapshotRestores ?? []) {
        this.#completedSnapshotRestores.set(completed.problemId, completed);
      }
    }
  }

  #persist(): void {
    if (!this.#launcher) {
      if (
        this.#deployments.size > 0 ||
        this.#pendingWorldCreates.size > 0 ||
        this.#pendingSnapshotRestores.size > 0
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
        launcher: this.#launcher,
        deployments: [...this.#deployments.values()],
        ...(this.#pendingWorldCreates.size > 0
          ? { pendingWorldCreates: [...this.#pendingWorldCreates.values()] }
          : {}),
        ...(this.#pendingSnapshotRestores.size > 0
          ? { pendingSnapshotRestores: [...this.#pendingSnapshotRestores.values()] }
          : {}),
        ...(this.#completedSnapshotRestores.size > 0
          ? { completedSnapshotRestores: [...this.#completedSnapshotRestores.values()] }
          : {}),
        ...(this.#launcherNeedsReplacement ? { launcherNeedsReplacement: true } : {}),
      } satisfies SimulatorSessionRecord,
      this.options.sessionWriteHooks,
    );
    if (this.options.participantEnvPath && this.options.nativeProxyBaseUrl) {
      const environment = simulatorNativeEnvironment(
        this.#launcher,
        this.#deployments,
        this.#problems,
        this.options.nativeProxyBaseUrl,
      );
      if (environment) writePrivateText(this.options.participantEnvPath, environment);
      else unlinkIfExists(this.options.participantEnvPath);
    }
  }

  #client(launcher: SimulatorLauncherRecord, launchToken?: string) {
    return createSimulatorClient(
      launcher.baseUrl,
      this.options.fetchFn,
      launchToken,
      this.options.requestTimeoutMs,
    );
  }

  async #launchNewLauncher(): Promise<{
    readonly launcher: SimulatorLauncherRecord;
    readonly intent?: SimulatorOwnedLaunchIntent;
  }> {
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

  async #ensureDataPlaneListeners(
    problem: SimulatedCloudProblem,
  ): Promise<Map<string, SimulatorDataPlaneListener>> {
    const existing = this.#dataPlaneListeners.get(problem.problemId);
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
        )(async () => this.#fixedDataPlaneRoute(problem, target.targetId), this.options.fetchFn);
        listeners.set(target.targetId, listener);
      }
    } catch (error) {
      const entries = [...listeners.entries()];
      const closed = await Promise.allSettled(entries.map(([, listener]) => listener.close()));
      const failed = new Map<string, SimulatorDataPlaneListener>();
      const errors: unknown[] = [error];
      for (const [index, result] of closed.entries()) {
        if (result.status === "rejected") {
          const entry = entries[index];
          if (entry) failed.set(...entry);
          errors.push(result.reason);
        }
      }
      if (failed.size > 0) this.#dataPlaneListeners.set(problem.problemId, failed);
      throw errors.length === 1
        ? error
        : new AggregateError(errors, "Simulator data-plane listener startup cleanup failed");
    }
    this.#dataPlaneListeners.set(problem.problemId, listeners);
    return listeners;
  }

  async #participantOutputs(
    problem: SimulatedCloudProblem,
    outputs: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, string>>> {
    if (!this.options.nativeProxyBaseUrl) return outputs;
    const listeners = await this.#ensureDataPlaneListeners(problem);
    return rewriteSimulatorDataPlaneOutputs(problem, outputs, (targetId) => {
      const listener = listeners.get(targetId);
      if (!listener) throw new Error(`Simulator target listener is missing: ${targetId}`);
      return listener.origin;
    });
  }

  async #closeDataPlaneListeners(problemId: string): Promise<void> {
    const listeners = this.#dataPlaneListeners.get(problemId);
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
    if (listeners.size === 0 && this.#dataPlaneListeners.get(problemId) === listeners) {
      this.#dataPlaneListeners.delete(problemId);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Simulator data-plane listener cleanup failed");
    }
  }

  async #closeAllDataPlaneListeners(): Promise<void> {
    const problemIds = [...this.#dataPlaneListeners.keys()];
    const closed = await Promise.allSettled(
      problemIds.map((problemId) => this.#closeDataPlaneListeners(problemId)),
    );
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Simulator data-plane listener cleanup failed");
    }
  }

  async #withOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release = (): void => {};
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => active);
    this.#operationTail = tail;
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#operationTail === tail) this.#operationTail = Promise.resolve();
    }
  }

  async #withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    let release = (): void => {};
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => active);
    this.#lifecycleTail = tail;
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#lifecycleTail === tail) this.#lifecycleTail = Promise.resolve();
    }
  }

  #renewDeploymentToken(problemId: string): LocalSimulatorDeployment {
    const deployment = this.#deployments.get(problemId);
    const launcher = this.#launcher;
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
    this.#deployments.set(problemId, renewed);
    this.#persist();
    return renewed;
  }

  async #replaceLauncher(): Promise<void> {
    const previousLauncher = this.#launcher;
    const previousDeployments = new Map(this.#deployments);
    const launched = await this.#launchNewLauncher();
    const replacement = launched.launcher;
    for (const [problemId, deployment] of this.#deployments) {
      const launchToken = issueSimulatorLaunchToken(
        replacement.launchSecret,
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
        `${replacement.baseUrl}/`,
      );
      this.#deployments.set(problemId, {
        ...deployment,
        launchToken,
        consoleUrl: simulatorConsoleUrl(consoleBase.toString(), launchToken, replacement.baseUrl),
        nativeCredentials: replacement.nativeCredentials,
      });
    }
    this.#launcher = replacement;
    this.#launcherNeedsReplacement = false;
    try {
      this.#persist();
      if (launched.intent) {
        clearSimulatorLaunchIntent(this.options.sessionPath);
      }
    } catch (persistError) {
      const errors: unknown[] = [persistError];
      let stopped = replacement.kind === "external";
      if (replacement.kind !== "external") {
        try {
          await stopSimulatorLauncher(replacement, this.options.env);
          stopped = true;
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      if (stopped && launched.intent) {
        try {
          clearSimulatorLaunchIntent(this.options.sessionPath);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      if (stopped) {
        this.#launcher = previousLauncher;
        this.#launcherNeedsReplacement = true;
        this.#deployments.clear();
        for (const [problemId, deployment] of previousDeployments) {
          this.#deployments.set(problemId, deployment);
        }
      }
      try {
        this.#persist();
      } catch (recoveryError) {
        errors.push(recoveryError);
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Simulator replacement persistence failed and recovery was incomplete",
        );
      }
      throw persistError;
    }
  }

  async #readyLauncher(): Promise<SimulatorLauncherRecord> {
    await reconcileSimulatorLaunchIntent(
      this.options.sessionPath,
      this.#launcher,
      this.options.env,
    );
    if (this.#launcherNeedsReplacement) await this.#replaceLauncher();
    if (!this.#launcher) {
      const launched = await this.#launchNewLauncher();
      this.#launcher = launched.launcher;
      try {
        this.#persist();
        if (launched.intent) {
          clearSimulatorLaunchIntent(this.options.sessionPath);
        }
      } catch (persistError) {
        const errors: unknown[] = [persistError];
        let stopped = launched.launcher.kind === "external";
        if (launched.launcher.kind !== "external") {
          try {
            await stopSimulatorLauncher(launched.launcher, this.options.env);
            stopped = true;
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        if (stopped && launched.intent) {
          try {
            clearSimulatorLaunchIntent(this.options.sessionPath);
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        if (stopped) {
          this.#launcher = undefined;
          this.#launcherNeedsReplacement = false;
          try {
            unlinkIfExists(this.options.sessionPath);
            unlinkIfExists(simulatorSessionSecretPath(this.options.sessionPath));
            if (this.options.participantEnvPath) {
              unlinkIfExists(this.options.participantEnvPath);
            }
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            "Simulator launcher persistence failed and cleanup was incomplete",
          );
        }
        throw persistError;
      }
    }
    const launcher = this.#launcher;
    const deadline =
      Date.now() +
      positiveDuration(this.options.startTimeoutMs, START_TIMEOUT_MS, "Simulator start timeout");
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const capabilities = await this.#client(launcher).capabilities();
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
    const readinessError = new Error(
      `Simulator did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    const errors: unknown[] = [readinessError];
    let launcherStopped = launcher.kind === "external";
    try {
      await stopSimulatorLauncher(launcher, this.options.env);
      launcherStopped = launcher.kind !== "external";
    } catch (error) {
      errors.push(error);
    }
    // An unready external record is stale even though its process remains
    // operator-owned. For an owned launcher, replace only after stop succeeds;
    // a failed stop does not prove the old process/container is gone.
    this.#launcherNeedsReplacement = launcher.kind === "external" || launcherStopped;
    this.#persist();
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Simulator readiness failed and its launcher could not stop",
      );
    }
    throw readinessError;
  }

  async #preflight(
    problem: SimulatedCloudProblem,
    launcher: SimulatorLauncherRecord,
  ): Promise<void> {
    const capabilities = await this.#client(launcher).capabilities();
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

  async #deployment(
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

  async #recoverOrCreateWorld(
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
    return this.#withLifecycle(() => this.#withOperation(() => this.#startUnlocked(problem)));
  }

  async #startUnlocked(problem: SimulatedCloudProblem): Promise<LocalSimulatorDeployment> {
    this.#problems.set(problem.problemId, problem);
    if (this.#pendingSnapshotRestores.has(problem.problemId)) {
      throw new SimulatorStartOwnershipError([
        new Error("Simulator snapshot restore still requires cleanup"),
      ]);
    }
    const existing = this.#deployments.get(problem.problemId);
    if (existing) {
      try {
        const launcher = await this.#readyLauncher();
        const renewed = this.#renewDeploymentToken(problem.problemId);
        const client = this.#client(launcher, renewed.launchToken);
        const current = await client.getDeployment(renewed.worldId, renewed.deploymentId);
        if (current.status !== "running") throw deploymentError(current);
        const recovered = {
          ...renewed,
          status: current.status,
          outputs: await this.#participantOutputs(problem, current.outputs),
          clockObservedAtMs: Number.isSafeInteger(renewed.clockObservedAtMs)
            ? renewed.clockObservedAtMs
            : Date.now(),
        };
        this.#deployments.set(problem.problemId, recovered);
        this.#persist();
        return recovered;
      } catch (error) {
        // This branch adopted a durable world before the current start call.
        // Any access/readiness/persistence failure must keep the lifecycle slot
        // owned until Stop can explicitly reconcile that world.
        throw new SimulatorStartOwnershipError([error]);
      }
    }

    const priorPending = this.#pendingWorldCreates.get(problem.problemId);
    let launcher: SimulatorLauncherRecord;
    try {
      launcher = await this.#readyLauncher();
      await this.#preflight(problem, launcher);
    } catch (error) {
      if (priorPending) throw new SimulatorStartOwnershipError([error]);
      throw error;
    }
    const deploymentId = priorPending?.deploymentId ?? `local-${problem.problemId}-${randomUUID()}`;
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      { tenantId: "local", eventId: "local", teamId: "local", deploymentId },
      TOKEN_TTL_SECONDS,
    );
    const pending = { problemId: problem.problemId, deploymentId, launchToken };
    this.#pendingWorldCreates.set(problem.problemId, pending);
    try {
      this.#persist();
    } catch (persistError) {
      const errors: unknown[] = [persistError];
      try {
        this.#persist();
      } catch (recoveryError) {
        errors.push(recoveryError);
      }
      throw new SimulatorStartOwnershipError(errors);
    }
    const client = this.#client(launcher, launchToken);
    const world = await this.#recoverOrCreateWorld(client, pending);
    try {
      const provisional: LocalSimulatorDeployment = {
        problemId: problem.problemId,
        worldId: world.worldId,
        deploymentId,
        launchToken,
        status: "accepted",
        outputs: {},
        consoleUrl: simulatorConsoleUrl(world.consoleUrl, launchToken, launcher.baseUrl),
        nativeCredentials: launcher.nativeCredentials,
        clockObservedAtMs: Date.now(),
      };
      // Keep a complete recovery handle in memory as soon as the world exists.
      // If creation or the first protected commit fails and delete also fails,
      // stop(problemId) can retry and #persist can make crash recovery durable.
      this.#deployments.set(problem.problemId, provisional);
      this.#pendingWorldCreates.delete(problem.problemId);
      const created = await client.createDeployment(world.worldId, {
        problemId: problem.problemId,
        runtime: problem.runtime,
        templateBody: problem.templateBody,
        metadata: safeMetadata(problem.metadata),
        ...(problem.simulationOverlay ? { simulationOverlay: problem.simulationOverlay } : {}),
      });
      const deployed = await this.#deployment(client, world.worldId, deploymentId, created);
      const record: LocalSimulatorDeployment = {
        problemId: problem.problemId,
        worldId: world.worldId,
        deploymentId,
        launchToken,
        status: deployed.status,
        outputs: await this.#participantOutputs(problem, deployed.outputs),
        consoleUrl: provisional.consoleUrl,
        nativeCredentials: launcher.nativeCredentials,
        clockObservedAtMs: Date.now(),
      };
      this.#deployments.set(problem.problemId, record);
      this.#persist();
      return record;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await this.#closeDataPlaneListeners(problem.problemId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await client.deleteWorld(world.worldId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        const errors: unknown[] = [error, ...cleanupErrors];
        try {
          // The protected record is self-contained. A one-shot failure before
          // its first commit is recoverable by persisting the retained handle.
          this.#persist();
        } catch (recoveryError) {
          errors.push(recoveryError);
        }
        throw new SimulatorStartOwnershipError(errors);
      }
      this.#deployments.delete(problem.problemId);
      this.#pendingWorldCreates.delete(problem.problemId);
      try {
        this.#persist();
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Simulator deployment failed and its deleted world could not be reconciled",
        );
      }
      throw error;
    }
  }

  async stop(problemId: string): Promise<void> {
    return this.#withLifecycle(async () => {
      await this.#closeDataPlaneListeners(problemId);
      return this.#withOperation(() => this.#stopUnlocked(problemId));
    });
  }

  async #stopUnlocked(problemId: string): Promise<void> {
    const pendingRestore = this.#pendingSnapshotRestores.get(problemId);
    if (pendingRestore) {
      if (!this.#launcher) {
        throw new Error("Simulator snapshot restore ownership has no launcher for cleanup");
      }
      const deployment = this.#deployments.get(problemId);
      const launchToken = issueSimulatorLaunchToken(
        this.#launcher.launchSecret,
        {
          tenantId: "local",
          eventId: "local",
          teamId: "local",
          deploymentId: pendingRestore.deploymentId,
        },
        TOKEN_TTL_SECONDS,
      );
      const client = this.#client(this.#launcher, launchToken);
      let restoredWorldId = pendingRestore.restoredWorldId;
      if (!restoredWorldId) {
        const restored = await client.getSnapshotRestore(
          pendingRestore.sourceWorldId,
          pendingRestore.snapshotHash,
          pendingRestore.idempotencyKey,
        );
        if (restored) {
          restoredWorldId = restored.worldId;
          this.#pendingSnapshotRestores.set(problemId, {
            ...pendingRestore,
            restoredWorldId,
          });
          this.#persist();
        }
      }
      const worldIds = new Set([
        pendingRestore.sourceWorldId,
        ...(restoredWorldId ? [restoredWorldId] : []),
        ...(deployment ? [deployment.worldId] : []),
      ]);
      for (const worldId of worldIds) await client.deleteWorld(worldId);
      this.#deployments.delete(problemId);
      this.#pendingWorldCreates.delete(problemId);
      this.#pendingSnapshotRestores.delete(problemId);
      this.#completedSnapshotRestores.delete(problemId);
      this.#problems.delete(problemId);
      this.#persist();
      return;
    }
    const pending = this.#pendingWorldCreates.get(problemId);
    if (!this.#deployments.has(problemId)) {
      if (pending) {
        if (!this.#launcher) {
          throw new Error("Simulator pending world ownership has no launcher for cleanup");
        }
        const launchToken = issueSimulatorLaunchToken(
          this.#launcher.launchSecret,
          {
            tenantId: "local",
            eventId: "local",
            teamId: "local",
            deploymentId: pending.deploymentId,
          },
          TOKEN_TTL_SECONDS,
        );
        const refreshed = { ...pending, launchToken };
        this.#pendingWorldCreates.set(problemId, refreshed);
        this.#persist();
        const client = this.#client(this.#launcher, launchToken);
        let world: SimulatorWorldResponse | undefined;
        for (let attempt = 0; attempt < 3 && !world; attempt += 1) {
          world = await client.getWorldByDeployment(pending.deploymentId);
          if (!world && attempt < 2) {
            await sleep(
              positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
            );
          }
        }
        if (world) await client.deleteWorld(world.worldId);
        this.#pendingWorldCreates.delete(problemId);
        this.#completedSnapshotRestores.delete(problemId);
        this.#problems.delete(problemId);
        this.#persist();
        return;
      }
      // A previous delete may have succeeded before its persistence failed.
      // Reconcile the protected/public generation instead of treating retry as
      // a no-op and leaving a deleted world in the on-disk record.
      this.#completedSnapshotRestores.delete(problemId);
      if (this.#launcher) this.#persist();
      this.#problems.delete(problemId);
      return;
    }
    if (!this.#launcher) {
      throw new Error("Simulator world ownership has no launcher for cleanup");
    }
    const deployment = this.#renewDeploymentToken(problemId);
    const client = this.#client(this.#launcher, deployment.launchToken);
    await client.deleteWorld(deployment.worldId);
    this.#deployments.delete(problemId);
    this.#pendingWorldCreates.delete(problemId);
    this.#completedSnapshotRestores.delete(problemId);
    this.#problems.delete(problemId);
    this.#persist();
  }

  async reset(problem: SimulatedCloudProblem): Promise<LocalSimulatorDeployment> {
    return this.#withLifecycle(async () => {
      await this.#closeDataPlaneListeners(problem.problemId);
      return this.#withOperation(async () => {
        await this.#stopUnlocked(problem.problemId);
        return this.#startUnlocked(problem);
      });
    });
  }

  async exportSnapshot(problemId: string, path: string): Promise<void> {
    return this.#withOperation(() => this.#exportSnapshotUnlocked(problemId, path));
  }

  async #exportSnapshotUnlocked(problemId: string, path: string): Promise<void> {
    if (!this.#deployments.has(problemId) || !this.#launcher)
      throw new Error(`Simulator problem is not running: ${problemId}`);
    const deployment = this.#renewDeploymentToken(problemId);
    const snapshot = await this.#client(this.#launcher, deployment.launchToken).exportSnapshot(
      deployment.worldId,
    );
    writePrivateJson(path, snapshot);
  }

  async #recoverOrRestoreSnapshot(
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
    return this.#withLifecycle(() =>
      this.#withOperation(() => this.#importSnapshotUnlocked(problemId, path)),
    );
  }

  async #importSnapshotUnlocked(problemId: string, path: string): Promise<void> {
    if (!this.#deployments.has(problemId) || !this.#launcher)
      throw new Error(`Simulator problem is not running: ${problemId}`);
    const deployment = this.#renewDeploymentToken(problemId);
    const snapshot = parseSimulatorSnapshot(readPrivateJson<unknown>(path, 16 * 1024 * 1024));
    const client = this.#client(this.#launcher, deployment.launchToken);
    const completed = this.#completedSnapshotRestores.get(problemId);
    if (
      completed &&
      completed.deploymentId === deployment.deploymentId &&
      completed.sourceWorldId === snapshot.worldId &&
      completed.snapshotHash === snapshot.hash
    ) {
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
      if (current.status !== "running")
        throw new SimulatorStartOwnershipError([deploymentError(current)]);
      if (this.#pendingSnapshotRestores.has(problemId)) {
        this.#pendingSnapshotRestores.delete(problemId);
        this.#persist();
      }
      return;
    }
    const existingPending = this.#pendingSnapshotRestores.get(problemId);
    const sourceWorldId = existingPending?.sourceWorldId ?? deployment.worldId;
    if (
      snapshot.protocolVersion !== SIMULATOR_PROTOCOL_VERSION ||
      snapshot.worldId !== sourceWorldId
    ) {
      throw new Error("Simulator snapshot does not match the running world and protocol");
    }
    if (
      existingPending &&
      (existingPending.deploymentId !== deployment.deploymentId ||
        existingPending.snapshotHash !== snapshot.hash)
    ) {
      throw new SimulatorStartOwnershipError([
        new Error("A different Simulator snapshot restore still requires cleanup"),
      ]);
    }
    const pending: SimulatorPendingSnapshotRestoreRecord = existingPending ?? {
      problemId,
      deploymentId: deployment.deploymentId,
      sourceWorldId,
      snapshotHash: snapshot.hash,
      idempotencyKey: `restore-${snapshot.hash}`,
    };
    if (!existingPending) {
      this.#pendingSnapshotRestores.set(problemId, pending);
      try {
        this.#persist();
      } catch (error) {
        const errors: unknown[] = [error];
        try {
          this.#persist();
        } catch (recoveryError) {
          errors.push(recoveryError);
        }
        throw new SimulatorStartOwnershipError(errors);
      }
    }
    const restored = await this.#recoverOrRestoreSnapshot(client, pending, snapshot);
    if (restored.worldId === sourceWorldId) {
      throw new SimulatorStartOwnershipError([
        new Error("Simulator snapshot restore must return a new world"),
      ]);
    }
    const dualOwnership = { ...pending, restoredWorldId: restored.worldId };
    this.#pendingSnapshotRestores.set(problemId, dualOwnership);
    try {
      this.#persist();
    } catch (error) {
      const errors: unknown[] = [error];
      try {
        this.#persist();
      } catch (recoveryError) {
        errors.push(recoveryError);
      }
      throw new SimulatorStartOwnershipError(errors);
    }

    let restoredDeployment: SimulatorDeploymentResponse | undefined;
    const readinessErrors: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await client.getDeployment(restored.worldId, deployment.deploymentId);
        if (current.status === "running") {
          restoredDeployment = current;
          break;
        }
        readinessErrors.push(deploymentError(current));
      } catch (error) {
        readinessErrors.push(error);
      }
      try {
        await client.importSnapshot(sourceWorldId, snapshot, pending.idempotencyKey);
      } catch (error) {
        readinessErrors.push(error);
      }
      await sleep(
        positiveDuration(this.options.retryDelayMs, RETRY_DELAY_MS, "Simulator retry delay"),
      );
    }
    if (!restoredDeployment) throw new SimulatorStartOwnershipError(readinessErrors);

    const replacement: LocalSimulatorDeployment = {
      ...deployment,
      worldId: restored.worldId,
      status: restoredDeployment.status,
      outputs: this.#problems.has(problemId)
        ? await this.#participantOutputs(
            this.#problems.get(problemId) as SimulatedCloudProblem,
            restoredDeployment.outputs,
          )
        : restoredDeployment.outputs,
      consoleUrl: simulatorConsoleUrl(
        restored.consoleUrl,
        deployment.launchToken,
        this.#launcher.baseUrl,
      ),
      clockObservedAtMs: Date.now(),
    };
    this.#deployments.set(problemId, replacement);
    try {
      this.#persist();
    } catch (error) {
      throw new SimulatorStartOwnershipError([error]);
    }

    await client.deleteWorld(sourceWorldId);
    this.#completedSnapshotRestores.set(problemId, {
      problemId,
      deploymentId: deployment.deploymentId,
      sourceWorldId,
      restoredWorldId: restored.worldId,
      snapshotHash: snapshot.hash,
      idempotencyKey: pending.idempotencyKey,
    });
    this.#pendingSnapshotRestores.delete(problemId);
    try {
      this.#persist();
    } catch (error) {
      // Keep the deleted source handle in memory so a retry can reconcile an
      // ambiguous protected/public generation without cloning another world.
      this.#pendingSnapshotRestores.set(problemId, dualOwnership);
      throw new SimulatorStartOwnershipError([error]);
    }
  }

  async advanceClock(
    problemId: string,
    nowMs: number,
  ): Promise<SimulatorClockAdvanceResponse | undefined> {
    return this.#withOperation(() => this.#advanceClockUnlocked(problemId, nowMs));
  }

  async #advanceClockUnlocked(
    problemId: string,
    nowMs: number,
  ): Promise<SimulatorClockAdvanceResponse | undefined> {
    if (!this.#deployments.has(problemId) || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problemId}`);
    }
    const deployment = this.#renewDeploymentToken(problemId);
    const milliseconds = Math.floor(nowMs - deployment.clockObservedAtMs);
    if (milliseconds <= 0) return undefined;
    if (!Number.isSafeInteger(milliseconds)) {
      throw new Error("Simulator clock advance exceeds the safe integer range");
    }
    const advanced = await this.#client(this.#launcher, deployment.launchToken).advanceClock(
      deployment.worldId,
      milliseconds,
    );
    this.#deployments.set(problemId, { ...deployment, clockObservedAtMs: nowMs });
    this.#persist();
    return advanced;
  }

  async fireDisruption(
    problem: SimulatedCloudProblem,
    disruptionId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#withOperation(() => this.#fireDisruptionUnlocked(problem, disruptionId));
  }

  async #fireDisruptionUnlocked(
    problem: SimulatedCloudProblem,
    disruptionId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this.#deployments.has(problem.problemId) || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const deployment = this.#renewDeploymentToken(problem.problemId);
    const command = simulatorDisruptionCommand(problem, deployment.outputs, disruptionId);
    return this.#client(this.#launcher, deployment.launchToken).executeProviderOperation(
      deployment.worldId,
      command.provider,
      command.operation,
      {
        deploymentId: deployment.deploymentId,
        targetId: command.targetId,
        engine: command.engine,
        service: command.service,
        resourceType: command.resourceType,
        input: command.input,
      },
      `operator:${problem.problemId}:${disruptionId}:${randomUUID()}`,
    );
  }

  async attackProbe(
    problem: SimulatedCloudProblem,
    request: AttackProbeRequest,
    observedAtMs: number,
  ): Promise<ProbeResult> {
    return this.#withOperation(() => this.#attackProbeUnlocked(problem, request, observedAtMs));
  }

  async endpointPlacements(
    problem: SimulatedCloudProblem,
    slots: readonly string[],
    _observedAtMs: number,
  ): Promise<readonly AuthoritativeEndpointPlacement[]> {
    return this.#withOperation(async () => {
      if (!this.#deployments.has(problem.problemId) || !this.#launcher) {
        throw new Error(`Simulator problem is not running: ${problem.problemId}`);
      }
      const deployment = this.#renewDeploymentToken(problem.problemId);
      const target = nativeTargets(problem).find((candidate) => candidate.provider === "aws");
      if (!target) return [];
      const scoring = simulatorScoringContract(problem).scoring;
      if (scoring.kind !== "phased-polling") return [];
      const allowedPlatforms = new Set(Object.keys(scoring.platformRules));
      const client = this.#client(this.#launcher, deployment.launchToken);
      const placements = await Promise.all(
        slots.map(async (slot): Promise<AuthoritativeEndpointPlacement | undefined> => {
          try {
            const result = await client.executeProviderOperation(
              deployment.worldId,
              target.provider,
              "DescribeEndpointPlacement",
              {
                deploymentId: deployment.deploymentId,
                targetId: target.targetId,
                engine: target.engine,
                service: "runtime",
                resourceType: "Runtime::Endpoint",
                input: { Slot: slot, TargetId: target.targetId },
              },
              internalProviderIdempotencyKey(this.#launcher, "endpoint-placement", [
                deployment.worldId,
                deployment.deploymentId,
                target.targetId,
                slot,
              ]),
            );
            if (
              result.DeploymentId !== deployment.deploymentId ||
              result.TargetId !== target.targetId ||
              result.Slot !== slot ||
              typeof result.EffectiveUrl !== "string" ||
              typeof result.VerifiedPlatform !== "string" ||
              !allowedPlatforms.has(result.VerifiedPlatform)
            ) {
              throw new Error("Simulator endpoint placement response is invalid");
            }
            const effectiveUrl = parseLoopbackUrl(
              result.EffectiveUrl,
              "Simulator managed endpoint",
            );
            if (effectiveUrl.username || effectiveUrl.password) {
              throw new Error("Simulator endpoint placement response is invalid");
            }
            return {
              slot,
              effectiveUrl: effectiveUrl.toString(),
              verifiedPlatform: result.VerifiedPlatform,
            };
          } catch (error) {
            if (error instanceof SimulatorHttpError && error.status === StatusCodes.NOT_FOUND) {
              return undefined;
            }
            throw error;
          }
        }),
      );
      return placements.filter(
        (placement): placement is AuthoritativeEndpointPlacement => placement !== undefined,
      );
    });
  }

  async #attackProbeUnlocked(
    problem: SimulatedCloudProblem,
    request: AttackProbeRequest,
    observedAtMs: number,
  ): Promise<ProbeResult> {
    if (!this.#deployments.has(problem.problemId) || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const deployment = this.#renewDeploymentToken(problem.problemId);
    const command = simulatorScoringAttackProbeCommand(problem, request);
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const startedAt = Date.now();
    const result = await this.#client(
      this.#launcher,
      deployment.launchToken,
    ).executeProviderOperation(
      deployment.worldId,
      command.provider,
      command.operation,
      {
        deploymentId: deployment.deploymentId,
        targetId: command.targetId,
        engine: command.engine,
        service: command.service,
        resourceType: command.resourceType,
        input: command.input,
      },
      internalProviderIdempotencyKey(this.#launcher, "attack-probe", [
        deployment.worldId,
        deployment.deploymentId,
        command.targetId,
        String(observedAtMs),
        requestHash,
      ]),
    );
    const status = result.StatusCode;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("Simulator AttackProbe response is missing a valid StatusCode");
    }
    return {
      ok: status >= StatusCodes.OK && status < StatusCodes.MULTIPLE_CHOICES,
      status,
      responseTimeMs: Date.now() - startedAt,
    };
  }

  async nativeRoute(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): Promise<SimulatorNativeRoute> {
    return this.#withOperation(async () => this.#nativeRouteUnlocked(problem, targetId));
  }

  #nativeRouteUnlocked(problem: SimulatedCloudProblem, targetId: string): SimulatorNativeRoute {
    const deployment = this.#deployments.get(problem.problemId);
    if (!deployment || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    if (!nativeTargets(problem).some((target) => target.targetId === targetId)) {
      throw new Error(`Simulator target does not exist: ${problem.problemId}/${targetId}`);
    }
    return {
      upstreamBaseUrl: this.#launcher.baseUrl,
      worldId: deployment.worldId,
      deploymentId: deployment.deploymentId,
      targetId,
    };
  }

  async dataPlaneRoute(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): Promise<SimulatorDataPlaneRoute> {
    return this.#withOperation(async () => this.#dataPlaneRouteUnlocked(problem, targetId));
  }

  #dataPlaneRouteUnlocked(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): SimulatorDataPlaneRoute {
    if (!this.#deployments.has(problem.problemId) || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const deployment = this.#renewDeploymentToken(problem.problemId);
    const target = nativeTargets(problem).find((candidate) => candidate.targetId === targetId);
    if (!target) {
      throw new Error(`Simulator target does not exist: ${problem.problemId}/${targetId}`);
    }
    return {
      upstreamBaseUrl: this.#launcher.baseUrl,
      worldId: deployment.worldId,
      deploymentId: deployment.deploymentId,
      targetId,
      provider: target.provider,
      launchToken: deployment.launchToken,
    };
  }

  #fixedDataPlaneRoute(problem: SimulatedCloudProblem, targetId: string): SimulatorDataPlaneRoute {
    const deployment = this.#deployments.get(problem.problemId);
    const launcher = this.#launcher;
    if (!deployment || !launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const target = nativeTargets(problem).find((candidate) => candidate.targetId === targetId);
    if (!target) {
      throw new Error(`Simulator target does not exist: ${problem.problemId}/${targetId}`);
    }
    // Listener teardown happens before world deletion under #withLifecycle, so
    // this lock-free resolver cannot race a lifecycle owner. Avoiding the global
    // operation queue also lets an unpublished listener drain after start fails.
    return {
      upstreamBaseUrl: launcher.baseUrl,
      worldId: deployment.worldId,
      deploymentId: deployment.deploymentId,
      targetId,
      provider: target.provider,
      launchToken: deployment.launchToken,
    };
  }

  async consoleUrl(problemId: string): Promise<string> {
    return this.#withOperation(async () => this.#renewDeploymentToken(problemId).consoleUrl);
  }

  async refreshAccess(problemId: string): Promise<void> {
    await this.#withOperation(async () => {
      this.#renewDeploymentToken(problemId);
    });
  }

  async close(): Promise<void> {
    return this.#withLifecycle(async () => {
      await this.#closeAllDataPlaneListeners();
      return this.#withOperation(() => this.#closeUnlocked());
    });
  }

  async #closeUnlocked(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await reconcileSimulatorLaunchIntent(
        this.options.sessionPath,
        this.#launcher,
        this.options.env,
      );
    } catch (error) {
      errors.push(error);
    }
    const ownedProblemIds = new Set([
      ...this.#deployments.keys(),
      ...this.#pendingWorldCreates.keys(),
      ...this.#pendingSnapshotRestores.keys(),
    ]);
    for (const problemId of ownedProblemIds) {
      try {
        await this.#stopUnlocked(problemId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#launcher) {
      if (errors.length === 0) {
        try {
          await stopSimulatorLauncher(this.#launcher, this.options.env);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 0) {
        const stoppedLauncher = this.#launcher;
        const replacementState = this.#launcherNeedsReplacement;
        this.#launcher = undefined;
        this.#launcherNeedsReplacement = false;
        try {
          this.options.beforeSessionRelease?.();
          this.#persist();
        } catch (error) {
          // The launcher is already physically stopped, but keep its durable
          // record in memory so a second close can retry partial file removal.
          this.#launcher = stoppedLauncher;
          this.#launcherNeedsReplacement = replacementState;
          errors.push(error);
        }
      } else {
        try {
          this.#persist();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Simulator cleanup failed");
  }
}
