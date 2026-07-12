import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { StatusCodes } from "http-status-codes";
import type {
  AttackProbeRequest,
  ProbeResult,
} from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/shared";
import { readJson, unlinkIfExists, writePrivateJson, writePrivateText } from "./session-state";
import {
  buildSimulatorCapabilityReport,
  createSimulatorClient,
  SIMULATOR_PROTOCOL_VERSION,
  type SimulatedCloudProblem,
  type SimulatorClockAdvanceResponse,
  type SimulatorDeploymentResponse,
  type SimulatorSnapshot,
} from "./simulator";
import { issueSimulatorLaunchToken, simulatorConsoleUrl } from "./simulator-auth";
import { rewriteSimulatorDataPlaneOutputs } from "./simulator-data-plane";
import {
  launchSimulator,
  type SimulatorLauncherRecord,
  type SimulatorNativeCredentials,
  stopSimulatorLauncher,
} from "./simulator-launcher";
import {
  nativeTargets,
  type SimulatorNativeRoute,
  simulatorNativeEnvironment,
} from "./simulator-native-environment";
import {
  simulatorDisruptionCommand,
  simulatorScoringAttackProbeCommand,
} from "./simulator-scoring";

export { cleanupRecordedSimulatorSession } from "./simulator-session-cleanup";

const START_TIMEOUT_MS = 15_000;
const DEPLOY_TIMEOUT_MS = 30_000;
const TOKEN_TTL_SECONDS = 86_400;

export interface LocalSimulatorDeployment {
  readonly problemId: string;
  readonly worldId: string;
  readonly deploymentId: string;
  readonly launchToken: string;
  readonly status: SimulatorDeploymentResponse["status"];
  readonly outputs: Readonly<Record<string, string>>;
  readonly consoleUrl: string;
  readonly nativeCredentials: SimulatorNativeCredentials;
  readonly clockObservedAtMs: number;
}

export interface SimulatorSessionRecord {
  readonly protocolVersion: typeof SIMULATOR_PROTOCOL_VERSION;
  readonly launcher: SimulatorLauncherRecord;
  readonly deployments: readonly LocalSimulatorDeployment[];
}

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
  readonly nativeRoute: (problem: SimulatedCloudProblem, targetId: string) => SimulatorNativeRoute;
  readonly dataPlaneRoute: (
    problem: SimulatedCloudProblem,
    targetId: string,
  ) => SimulatorDataPlaneRoute;
  readonly close: () => Promise<void>;
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

export class SimulatorLocalRuntime implements LocalSimulatorRuntimePort {
  readonly #deployments = new Map<string, LocalSimulatorDeployment>();
  readonly #problems = new Map<string, SimulatedCloudProblem>();
  #launcher: SimulatorLauncherRecord | undefined;

  constructor(private readonly options: SimulatorRuntimeOptions) {
    if (existsSync(options.sessionPath)) {
      const recorded = readJson<SimulatorSessionRecord>(options.sessionPath);
      if (recorded.protocolVersion !== SIMULATOR_PROTOCOL_VERSION) {
        throw new Error(
          `Recorded Simulator protocol ${recorded.protocolVersion} does not match ${SIMULATOR_PROTOCOL_VERSION}`,
        );
      }
      this.#launcher = recorded.launcher;
      for (const deployment of recorded.deployments) {
        this.#deployments.set(deployment.problemId, deployment);
      }
    }
  }

  #persist(): void {
    if (!this.#launcher) {
      unlinkIfExists(this.options.sessionPath);
      if (this.options.participantEnvPath) unlinkIfExists(this.options.participantEnvPath);
      return;
    }
    writePrivateJson(this.options.sessionPath, {
      protocolVersion: SIMULATOR_PROTOCOL_VERSION,
      launcher: this.#launcher,
      deployments: [...this.#deployments.values()],
    } satisfies SimulatorSessionRecord);
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

  async #readyLauncher(): Promise<SimulatorLauncherRecord> {
    if (!this.#launcher) {
      this.#launcher = await launchSimulator({
        stateDir: this.options.stateDir,
        logPath: this.options.logPath,
        workloadImages: this.options.workloadImages,
        env: this.options.env,
      });
      this.#persist();
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const capabilities = await createSimulatorClient(
          this.#launcher.baseUrl,
          this.options.fetchFn,
        ).capabilities();
        if (capabilities.protocolVersion !== SIMULATOR_PROTOCOL_VERSION) {
          throw new Error(
            `Simulator protocol ${capabilities.protocolVersion} does not match ${SIMULATOR_PROTOCOL_VERSION}`,
          );
        }
        return this.#launcher;
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    throw new Error(
      `Simulator did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async #preflight(
    problem: SimulatedCloudProblem,
    launcher: SimulatorLauncherRecord,
  ): Promise<void> {
    const capabilities = await createSimulatorClient(
      launcher.baseUrl,
      this.options.fetchFn,
    ).capabilities();
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
    const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
    while (current.status === "accepted" || current.status === "deploying") {
      if (Date.now() >= deadline) throw new Error("Simulator deployment readiness timed out");
      await sleep(100);
      current = await client.getDeployment(worldId, deploymentId);
    }
    if (current.status !== "running") throw deploymentError(current);
    return current;
  }

  async start(problem: SimulatedCloudProblem): Promise<LocalSimulatorDeployment> {
    this.#problems.set(problem.problemId, problem);
    const existing = this.#deployments.get(problem.problemId);
    if (existing) {
      const launcher = await this.#readyLauncher();
      const client = createSimulatorClient(
        launcher.baseUrl,
        this.options.fetchFn,
        existing.launchToken,
      );
      const current = await client.getDeployment(existing.worldId, existing.deploymentId);
      if (current.status !== "running") throw deploymentError(current);
      const recovered = {
        ...existing,
        status: current.status,
        outputs: this.options.nativeProxyBaseUrl
          ? rewriteSimulatorDataPlaneOutputs(
              problem,
              current.outputs,
              this.options.nativeProxyBaseUrl,
            )
          : current.outputs,
        clockObservedAtMs: Number.isSafeInteger(existing.clockObservedAtMs)
          ? existing.clockObservedAtMs
          : Date.now(),
      };
      this.#deployments.set(problem.problemId, recovered);
      this.#persist();
      return recovered;
    }

    const launcher = await this.#readyLauncher();
    await this.#preflight(problem, launcher);
    const deploymentId = `local-${problem.problemId}-${randomUUID()}`;
    const launchToken = issueSimulatorLaunchToken(
      launcher.launchSecret,
      { tenantId: "local", eventId: "local", teamId: "local", deploymentId },
      TOKEN_TTL_SECONDS,
    );
    const client = createSimulatorClient(launcher.baseUrl, this.options.fetchFn, launchToken);
    const world = await client.createWorld({
      tenantId: "local",
      eventId: "local",
      teamId: "local",
      deploymentId,
    });
    try {
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
        outputs: this.options.nativeProxyBaseUrl
          ? rewriteSimulatorDataPlaneOutputs(
              problem,
              deployed.outputs,
              this.options.nativeProxyBaseUrl,
            )
          : deployed.outputs,
        consoleUrl: simulatorConsoleUrl(world.consoleUrl, launchToken),
        nativeCredentials: launcher.nativeCredentials,
        clockObservedAtMs: Date.now(),
      };
      this.#deployments.set(problem.problemId, record);
      this.#persist();
      return record;
    } catch (error) {
      try {
        await client.deleteWorld(world.worldId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Simulator deployment failed and its world could not be deleted",
        );
      }
      throw error;
    }
  }

  async stop(problemId: string): Promise<void> {
    const deployment = this.#deployments.get(problemId);
    if (!deployment || !this.#launcher) return;
    const client = createSimulatorClient(
      this.#launcher.baseUrl,
      this.options.fetchFn,
      deployment.launchToken,
    );
    await client.deleteWorld(deployment.worldId);
    this.#deployments.delete(problemId);
    this.#problems.delete(problemId);
    this.#persist();
  }

  async reset(problem: SimulatedCloudProblem): Promise<LocalSimulatorDeployment> {
    await this.stop(problem.problemId);
    return this.start(problem);
  }

  async exportSnapshot(problemId: string, path: string): Promise<void> {
    const deployment = this.#deployments.get(problemId);
    if (!deployment || !this.#launcher)
      throw new Error(`Simulator problem is not running: ${problemId}`);
    const snapshot = await createSimulatorClient(
      this.#launcher.baseUrl,
      this.options.fetchFn,
      deployment.launchToken,
    ).exportSnapshot(deployment.worldId);
    writePrivateJson(path, snapshot);
  }

  async importSnapshot(problemId: string, path: string): Promise<void> {
    const deployment = this.#deployments.get(problemId);
    if (!deployment || !this.#launcher)
      throw new Error(`Simulator problem is not running: ${problemId}`);
    const snapshot = readJson<SimulatorSnapshot>(path);
    if (
      snapshot.protocolVersion !== SIMULATOR_PROTOCOL_VERSION ||
      snapshot.worldId !== deployment.worldId
    ) {
      throw new Error("Simulator snapshot does not match the running world and protocol");
    }
    await createSimulatorClient(
      this.#launcher.baseUrl,
      this.options.fetchFn,
      deployment.launchToken,
    ).importSnapshot(deployment.worldId, snapshot);
  }

  async advanceClock(
    problemId: string,
    nowMs: number,
  ): Promise<SimulatorClockAdvanceResponse | undefined> {
    const deployment = this.#deployments.get(problemId);
    if (!deployment || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problemId}`);
    }
    const milliseconds = Math.floor(nowMs - deployment.clockObservedAtMs);
    if (milliseconds <= 0) return undefined;
    if (!Number.isSafeInteger(milliseconds)) {
      throw new Error("Simulator clock advance exceeds the safe integer range");
    }
    const advanced = await createSimulatorClient(
      this.#launcher.baseUrl,
      this.options.fetchFn,
      deployment.launchToken,
    ).advanceClock(deployment.worldId, milliseconds);
    this.#deployments.set(problemId, { ...deployment, clockObservedAtMs: nowMs });
    this.#persist();
    return advanced;
  }

  async fireDisruption(
    problem: SimulatedCloudProblem,
    disruptionId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const deployment = this.#deployments.get(problem.problemId);
    if (!deployment || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const command = simulatorDisruptionCommand(problem, deployment.outputs, disruptionId);
    return createSimulatorClient(
      this.#launcher.baseUrl,
      this.options.fetchFn,
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
      `operator:${problem.problemId}:${disruptionId}:${randomUUID()}`,
    );
  }

  async attackProbe(
    problem: SimulatedCloudProblem,
    request: AttackProbeRequest,
    observedAtMs: number,
  ): Promise<ProbeResult> {
    const deployment = this.#deployments.get(problem.problemId);
    if (!deployment || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const command = simulatorScoringAttackProbeCommand(problem, request);
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const startedAt = Date.now();
    const result = await createSimulatorClient(
      this.#launcher.baseUrl,
      this.options.fetchFn,
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
      `scoring:${problem.problemId}:${observedAtMs}:${requestHash}`,
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

  nativeRoute(problem: SimulatedCloudProblem, targetId: string): SimulatorNativeRoute {
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

  dataPlaneRoute(problem: SimulatedCloudProblem, targetId: string): SimulatorDataPlaneRoute {
    const deployment = this.#deployments.get(problem.problemId);
    if (!deployment || !this.#launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
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

  async close(): Promise<void> {
    let firstError: unknown;
    for (const problemId of [...this.#deployments.keys()]) {
      try {
        await this.stop(problemId);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.#launcher) {
      try {
        stopSimulatorLauncher(this.#launcher, this.options.env);
      } catch (error) {
        firstError ??= error;
      }
      this.#launcher = undefined;
      this.#persist();
    }
    if (firstError) throw firstError;
  }
}
