import type {
  AttackProbeRequest,
  AuthoritativeEndpointPlacement,
  ProbeResult,
} from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { SimulatedCloudProblem, SimulatorClockAdvanceResponse } from "./simulator";
import type { startSimulatorDataPlaneListener } from "./simulator-data-plane-proxy";
import type { SimulatorLauncherRecord, SimulatorOwnedLaunchIntent } from "./simulator-launcher";
import type { SimulatorNativeRoute } from "./simulator-native-environment";
import type {
  SimulatorSessionDeploymentRecord,
  SimulatorSessionWriteHooks,
} from "./simulator-session-record";

export type LocalSimulatorDeployment = SimulatorSessionDeploymentRecord;

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
  /** Test seams; production uses the bounded defaults. */
  readonly startTimeoutMs?: number;
  readonly deploymentTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly sessionWriteHooks?: SimulatorSessionWriteHooks;
  readonly onLauncherStarted?: (launcher: SimulatorLauncherRecord) => void;
  readonly beforeLauncherSpawn?: (intent: SimulatorOwnedLaunchIntent) => void;
  readonly beforeSessionRelease?: () => void;
  readonly startDataPlaneListener?: typeof startSimulatorDataPlaneListener;
}

export interface LaunchedSimulator {
  readonly launcher: SimulatorLauncherRecord;
  readonly intent?: SimulatorOwnedLaunchIntent;
}
