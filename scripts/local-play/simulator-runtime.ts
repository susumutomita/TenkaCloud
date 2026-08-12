import { createHash, randomUUID } from "node:crypto";
import { StatusCodes } from "http-status-codes";
import type {
  AttackProbeRequest,
  AuthoritativeEndpointPlacement,
  ProbeResult,
} from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/shared";
import { parseLoopbackUrl } from "./loopback";
import {
  type SimulatedCloudProblem,
  type SimulatorClockAdvanceResponse,
  SimulatorHttpError,
} from "./simulator";
import {
  reconcileSimulatorLaunchIntent,
  type SimulatorLauncherRecord,
  stopSimulatorLauncher,
} from "./simulator-launcher";
import { nativeTargets, type SimulatorNativeRoute } from "./simulator-native-environment";
import type {
  LocalSimulatorDeployment,
  LocalSimulatorRuntimePort,
  SimulatorDataPlaneRoute,
} from "./simulator-runtime-contract";
import { SimulatorRuntimeLifecycle } from "./simulator-runtime-lifecycle";
import { internalProviderIdempotencyKey } from "./simulator-runtime-shared";
import {
  simulatorDisruptionCommand,
  simulatorScoringAttackProbeCommand,
  simulatorScoringContract,
} from "./simulator-scoring";

export type {
  LocalSimulatorDeployment,
  LocalSimulatorRuntimePort,
  SimulatorDataPlaneRoute,
  SimulatorRuntimeOptions,
} from "./simulator-runtime-contract";
export { cleanupRecordedSimulatorSession } from "./simulator-session-cleanup";
export type { SimulatorSessionRecord } from "./simulator-session-record";

export class SimulatorLocalRuntime
  extends SimulatorRuntimeLifecycle
  implements LocalSimulatorRuntimePort
{
  async advanceClock(
    problemId: string,
    nowMs: number,
  ): Promise<SimulatorClockAdvanceResponse | undefined> {
    return this._withOperation(() => this._advanceClockUnlocked(problemId, nowMs));
  }

  protected async _advanceClockUnlocked(
    problemId: string,
    nowMs: number,
  ): Promise<SimulatorClockAdvanceResponse | undefined> {
    if (!this._deployments.has(problemId) || !this._launcher) {
      throw new Error(`Simulator problem is not running: ${problemId}`);
    }
    const deployment = this._renewDeploymentToken(problemId);
    const milliseconds = Math.floor(nowMs - deployment.clockObservedAtMs);
    if (milliseconds <= 0) return undefined;
    if (!Number.isSafeInteger(milliseconds)) {
      throw new Error("Simulator clock advance exceeds the safe integer range");
    }
    const advanced = await this._client(this._launcher, deployment.launchToken).advanceClock(
      deployment.worldId,
      milliseconds,
    );
    this._deployments.set(problemId, { ...deployment, clockObservedAtMs: nowMs });
    this._persist();
    return advanced;
  }

  async fireDisruption(
    problem: SimulatedCloudProblem,
    disruptionId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this._withOperation(() => this._fireDisruptionUnlocked(problem, disruptionId));
  }

  protected async _fireDisruptionUnlocked(
    problem: SimulatedCloudProblem,
    disruptionId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this._deployments.has(problem.problemId) || !this._launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const deployment = this._renewDeploymentToken(problem.problemId);
    const command = simulatorDisruptionCommand(problem, deployment.outputs, disruptionId);
    return this._client(this._launcher, deployment.launchToken).executeProviderOperation(
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
    return this._withOperation(() => this._attackProbeUnlocked(problem, request, observedAtMs));
  }

  protected async _endpointPlacement(
    client: SimulatorClient,
    launcher: SimulatorLauncherRecord,
    deployment: LocalSimulatorDeployment,
    target: SimulatorNativeTarget,
    allowedPlatforms: ReadonlySet<string>,
    slot: string,
  ): Promise<AuthoritativeEndpointPlacement | undefined> {
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
        internalProviderIdempotencyKey(launcher, "endpoint-placement", [
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
      const effectiveUrl = parseLoopbackUrl(result.EffectiveUrl, "Simulator managed endpoint");
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
  }

  async endpointPlacements(
    problem: SimulatedCloudProblem,
    slots: readonly string[],
    _observedAtMs: number,
  ): Promise<readonly AuthoritativeEndpointPlacement[]> {
    return this._withOperation(async () => {
      const launcher = this._launcher;
      if (!this._deployments.has(problem.problemId) || !launcher) {
        throw new Error(`Simulator problem is not running: ${problem.problemId}`);
      }
      const deployment = this._renewDeploymentToken(problem.problemId);
      const target = nativeTargets(problem).find((candidate) => candidate.provider === "aws");
      if (!target) return [];
      const scoring = simulatorScoringContract(problem).scoring;
      if (scoring.kind !== "phased-polling") return [];
      const allowedPlatforms = new Set(Object.keys(scoring.platformRules));
      const client = this._client(launcher, deployment.launchToken);
      const placements = await Promise.all(
        slots.map((slot) =>
          this._endpointPlacement(client, launcher, deployment, target, allowedPlatforms, slot),
        ),
      );
      return placements.filter(
        (placement): placement is AuthoritativeEndpointPlacement => placement !== undefined,
      );
    });
  }

  protected async _attackProbeUnlocked(
    problem: SimulatedCloudProblem,
    request: AttackProbeRequest,
    observedAtMs: number,
  ): Promise<ProbeResult> {
    if (!this._deployments.has(problem.problemId) || !this._launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const deployment = this._renewDeploymentToken(problem.problemId);
    const command = simulatorScoringAttackProbeCommand(problem, request);
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const startedAt = Date.now();
    const result = await this._client(
      this._launcher,
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
      internalProviderIdempotencyKey(this._launcher, "attack-probe", [
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
    return this._withOperation(async () => this._nativeRouteUnlocked(problem, targetId));
  }

  protected _nativeRouteUnlocked(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): SimulatorNativeRoute {
    const deployment = this._deployments.get(problem.problemId);
    if (!deployment || !this._launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    if (!nativeTargets(problem).some((target) => target.targetId === targetId)) {
      throw new Error(`Simulator target does not exist: ${problem.problemId}/${targetId}`);
    }
    return {
      upstreamBaseUrl: this._launcher.baseUrl,
      worldId: deployment.worldId,
      deploymentId: deployment.deploymentId,
      targetId,
    };
  }

  async dataPlaneRoute(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): Promise<SimulatorDataPlaneRoute> {
    return this._withOperation(async () => this._dataPlaneRouteUnlocked(problem, targetId));
  }

  protected _dataPlaneRouteUnlocked(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): SimulatorDataPlaneRoute {
    if (!this._deployments.has(problem.problemId) || !this._launcher) {
      throw new Error(`Simulator problem is not running: ${problem.problemId}`);
    }
    const deployment = this._renewDeploymentToken(problem.problemId);
    const target = nativeTargets(problem).find((candidate) => candidate.targetId === targetId);
    if (!target) {
      throw new Error(`Simulator target does not exist: ${problem.problemId}/${targetId}`);
    }
    return {
      upstreamBaseUrl: this._launcher.baseUrl,
      worldId: deployment.worldId,
      deploymentId: deployment.deploymentId,
      targetId,
      provider: target.provider,
      launchToken: deployment.launchToken,
    };
  }

  protected _fixedDataPlaneRoute(
    problem: SimulatedCloudProblem,
    targetId: string,
  ): SimulatorDataPlaneRoute {
    const deployment = this._deployments.get(problem.problemId);
    const launcher = this._launcher;
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
    return this._withOperation(async () => this._renewDeploymentToken(problemId).consoleUrl);
  }

  async refreshAccess(problemId: string): Promise<void> {
    await this._withOperation(async () => {
      this._renewDeploymentToken(problemId);
    });
  }

  async close(): Promise<void> {
    return this._withLifecycle(async () => {
      await this._closeAllDataPlaneListeners();
      return this._withOperation(() => this._closeUnlocked());
    });
  }

  protected async _reconcileBeforeClose(errors: unknown[]): Promise<void> {
    try {
      await reconcileSimulatorLaunchIntent(
        this.options.sessionPath,
        this._launcher,
        this.options.env,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  protected async _stopOwnedProblems(errors: unknown[]): Promise<void> {
    const problemIds = new Set([
      ...this._deployments.keys(),
      ...this._pendingWorldCreates.keys(),
      ...this._pendingSnapshotRestores.keys(),
    ]);
    for (const problemId of problemIds) {
      try {
        await this._stopUnlocked(problemId);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  protected _releaseStoppedLauncher(launcher: SimulatorLauncherRecord, errors: unknown[]): void {
    const replacementState = this._launcherNeedsReplacement;
    this._launcher = undefined;
    this._launcherNeedsReplacement = false;
    try {
      this.options.beforeSessionRelease?.();
      this._persist();
    } catch (error) {
      // The launcher is already physically stopped, but keep its durable record
      // in memory so a second close can retry partial file removal.
      this._launcher = launcher;
      this._launcherNeedsReplacement = replacementState;
      errors.push(error);
    }
  }

  protected async _stopLauncherForClose(errors: unknown[]): Promise<void> {
    const launcher = this._launcher;
    if (!launcher) return;
    if (errors.length > 0) {
      this._persistRecovery(errors);
      return;
    }
    try {
      await stopSimulatorLauncher(launcher, this.options.env);
    } catch (error) {
      errors.push(error);
      this._persistRecovery(errors);
      return;
    }
    this._releaseStoppedLauncher(launcher, errors);
  }

  protected async _closeUnlocked(): Promise<void> {
    const errors: unknown[] = [];
    await this._reconcileBeforeClose(errors);
    await this._stopOwnedProblems(errors);
    await this._stopLauncherForClose(errors);
    if (errors.length > 0) throw new AggregateError(errors, "Simulator cleanup failed");
  }
}
