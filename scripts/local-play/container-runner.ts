/**
 * [#2392 Phase 2] Docker adapter for the on-demand lifecycle. Given a problem
 * and an assigned host-port offset, it brings the container up on that port
 * block (reusing the Phase 1 compose remap) and returns the offset-remapped
 * problem so the API can point scoring at the right loopback URLs. The
 * long-lived `serve` process uses this to start/stop containers on demand —
 * the same compose mechanics as the `up` orchestrator, callable in-process.
 *
 * Docker + fs are injected (`ContainerRunnerDeps`), so the mechanics are
 * unit-tested with no Docker; the orchestrator / serve process supply the real
 * Docker Compose primitives.
 */

import { dirname, join, resolve } from "node:path";
import { assertComposePolicy } from "./compose-policy";
import type { ContainerProblem } from "./manifest";
import { remapComposeHostPorts, remapContainerProblem } from "./port-remap";

/** One problem's compose unit — the handle needed to tear it down. */
export interface LocalComposeUnit {
  readonly problemId: string;
  /** Host-port block owned by this unit. Optional only for pre-#3016 ledgers. */
  readonly offset?: number;
  readonly composePath: string;
  readonly composeProjectName: string;
  readonly secretEnv: readonly string[];
  /** Original problem `local/` dir; set when running a remapped copy so relative paths resolve. */
  readonly projectDirectory?: string;
  /** Temp remapped compose to delete on teardown (absent for an unremapped, offset-0 problem). */
  readonly remappedComposePath?: string;
}

export interface StartedContainer {
  readonly unit: LocalComposeUnit;
  /** The problem with `challengeEndpoints` / `verifyUrl` moved onto its port block. */
  readonly problem: ContainerProblem;
}

/**
 * Durable ownership hooks for the real serve process.
 *
 * `acquire` commits the compose handle before `compose up` can create anything. If the
 * start later fails, `cleanupFailedStart` tears the unit down and releases that commit.
 */
export interface ContainerStartOwnershipHooks {
  readonly acquire: (unit: LocalComposeUnit) => void;
  readonly cleanupFailedStart: (unit: LocalComposeUnit) => void;
}

/** A live unit reconstructed from the durable ownership ledger after a control-plane restart. */
export interface RecoveredContainer {
  readonly offset: number;
  readonly started: StartedContainer;
}

export class ContainerStartOwnershipError extends AggregateError {
  readonly retainsOwnership = true;

  constructor(
    readonly unit: LocalComposeUnit,
    errors: readonly unknown[],
  ) {
    super(errors, "Problem container start failed and cleanup was incomplete");
  }
}

/** Compose still interpolates required variables during `down`, even though no
 * container is started. Keep cleanup independent from the deploy secret. */
const CLEANUP_SECRET_VALUE = "tenkacloud-local-cleanup";

export interface ContainerRunnerDeps {
  readonly runCompose: (
    composePath: string,
    projectName: string,
    action: "up" | "down",
    env: NodeJS.ProcessEnv,
    allowFailure: boolean,
    projectDirectory?: string,
  ) => void;
  readonly waitForReachable: (url: string, label: string) => Promise<void>;
  /** Bounded diagnostics for this exact owned compose unit after readiness fails. */
  readonly diagnoseComposeUnit?: (
    unit: LocalComposeUnit,
    sensitiveValues: readonly string[],
  ) => string | undefined;
  /**
   * The container secrets for one problem. Takes the problem id because the secrets are
   * derived from it (Issue #2975): a restarted container must present the same evidence
   * a participant already reasoned about, and a per-call random draw could not.
   */
  readonly generateSecretEnv: (
    problemId: string,
    names: readonly string[],
  ) => Record<string, string>;
  readonly readCompose: (path: string) => string;
  readonly writeTempCompose: (path: string, content: string) => void;
  readonly removeTempCompose: (path: string) => void;
  readonly log: (message: string) => void;
}

export class ContainerRunner {
  constructor(
    private readonly localDir: string,
    private readonly deps: ContainerRunnerDeps,
  ) {}

  /**
   * Bring `problem` up on host-port block `offset`. Offset 0 runs from the
   * original compose; a later offset runs from a port-remapped temp copy with
   * `--project-directory` pinned to the original dir so relative build contexts
   * and volumes still resolve. Returns the teardown unit + the offset-remapped
   * problem (its loopback URLs moved onto the block).
   */
  async start(
    problem: ContainerProblem,
    offset: number,
    ownership?: ContainerStartOwnershipHooks,
  ): Promise<StartedContainer> {
    const originalCompose = this.deps.readCompose(problem.composePath);
    // [Issue #3097] Deny-by-default structural policy, fail-closed before anything is written or
    // started. Port remapping below only rewrites published-port text (port-remap.ts preserves
    // everything else byte-for-byte), so validating the pre-remap text is equivalent to
    // validating what actually starts.
    assertComposePolicy(originalCompose, {
      problemDir: problem.problemDir,
      composePath: problem.composePath,
    });
    const { text, portMap } = remapComposeHostPorts(originalCompose, offset);
    let composePath = problem.composePath;
    let projectDirectory: string | undefined;
    let remappedComposePath: string | undefined;
    if (offset > 0) {
      remappedComposePath = join(this.localDir, `${problem.composeProjectName}.compose.yml`);
      this.deps.writeTempCompose(remappedComposePath, text);
      composePath = remappedComposePath;
      projectDirectory = dirname(problem.composePath);
    }
    const remappedProblem = remapContainerProblem(problem, portMap);
    const unit: LocalComposeUnit = {
      problemId: problem.problemId,
      offset,
      composePath,
      composeProjectName: problem.composeProjectName,
      secretEnv: problem.secretEnv,
      ...(projectDirectory ? { projectDirectory } : {}),
      ...(remappedComposePath ? { remappedComposePath } : {}),
    };
    const generatedSecrets = this.deps.generateSecretEnv(problem.problemId, problem.secretEnv);
    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...generatedSecrets,
    };
    // The remapped compose must exist before its handle is committed, but ownership must
    // be durable before `compose up`: a SIGKILL immediately after Docker creates the
    // project must still leave enough state for the replacement control plane to reclaim it.
    ownership?.acquire(unit);
    this.deps.log(`Starting problem container for ${problem.name}...`);
    try {
      this.deps.runCompose(
        composePath,
        problem.composeProjectName,
        "up",
        composeEnv,
        false,
        projectDirectory,
      );
      // The verifier is the mandatory scoring seam for every container problem.
      // Waiting only on optional challenge surfaces made verifier-only problems
      // report "running" before POST /verify was actually ready (or wait on
      // nothing at all). Always gate startup on verifyUrl, then on any additional
      // participant-facing endpoints the problem declares.
      await this.waitUntilReady(remappedProblem, unit, Object.values(generatedSecrets));
    } catch (startError) {
      try {
        if (ownership) ownership.cleanupFailedStart(unit);
        else this.stop(unit);
      } catch (cleanupError) {
        throw new ContainerStartOwnershipError(unit, [startError, cleanupError]);
      }
      throw startError;
    }
    return {
      problem: remappedProblem,
      unit,
    };
  }

  /**
   * Rebuild the in-memory half of a compose unit that this session already owns.
   *
   * New ledgers persist the assigned offset directly. For an older ledger, offset 0 is
   * identifiable from the absence of a remapped compose file; a later slot is recovered by
   * comparing the original and persisted remapped host ports. Ambiguous legacy state is
   * rejected instead of inventing an offset and pointing the portal at the wrong container.
   */
  async recover(problem: ContainerProblem, unit: LocalComposeUnit): Promise<RecoveredContainer> {
    const originalCompose = this.deps.readCompose(problem.composePath);
    // [Issue #3097] Same fail-closed policy as `start`: a compose file that was compliant when a
    // container was first started must still be compliant when the control plane reconciles it
    // after a restart (a catalog checkout could have changed underneath a long-lived session).
    assertComposePolicy(originalCompose, {
      problemDir: problem.problemDir,
      composePath: problem.composePath,
    });
    const offset = this.recoverOffset(problem, unit, originalCompose);
    const remapped = remapComposeHostPorts(originalCompose, offset);
    this.assertUnitMatchesProblem(problem, unit, offset, remapped.text);
    const recovered = {
      offset,
      started: {
        unit: { ...unit, offset },
        problem: remapContainerProblem(problem, remapped.portMap),
      },
    };
    const generatedSecrets = this.deps.generateSecretEnv(problem.problemId, problem.secretEnv);
    await this.waitUntilReady(
      recovered.started.problem,
      recovered.started.unit,
      Object.values(generatedSecrets),
    );
    return recovered;
  }

  private recoverOffset(
    problem: ContainerProblem,
    unit: LocalComposeUnit,
    originalCompose: string,
  ): number {
    if (unit.offset !== undefined) return unit.offset;
    if (unit.remappedComposePath === undefined) return 0;

    const basePorts = [...remapComposeHostPorts(originalCompose, 0).portMap.keys()].sort(
      (a, b) => a - b,
    );
    const remappedPorts = [
      ...remapComposeHostPorts(this.deps.readCompose(unit.composePath), 0).portMap.keys(),
    ].sort((a, b) => a - b);
    if (basePorts.length === 0 || basePorts.length !== remappedPorts.length) {
      throw new Error(`Cannot recover port offset for recorded problem "${problem.problemId}"`);
    }
    const offset = (remappedPorts[0] as number) - (basePorts[0] as number);
    if (
      offset < 0 ||
      !basePorts.every((basePort, index) => remappedPorts[index] === basePort + offset)
    ) {
      throw new Error(`Cannot recover port offset for recorded problem "${problem.problemId}"`);
    }
    return offset;
  }

  private assertUnitMatchesProblem(
    problem: ContainerProblem,
    unit: LocalComposeUnit,
    offset: number,
    remappedCompose: string,
  ): void {
    const sameSecrets =
      unit.secretEnv.length === problem.secretEnv.length &&
      unit.secretEnv.every((name, index) => name === problem.secretEnv[index]);
    if (
      unit.problemId !== problem.problemId ||
      unit.composeProjectName !== problem.composeProjectName ||
      !sameSecrets
    ) {
      throw new Error(`Recorded compose unit does not match problem "${problem.problemId}"`);
    }
    if (offset === 0) {
      if (
        resolve(unit.composePath) !== resolve(problem.composePath) ||
        unit.projectDirectory !== undefined ||
        unit.remappedComposePath !== undefined
      ) {
        throw new Error(`Recorded compose unit does not match offset 0 for "${problem.problemId}"`);
      }
      return;
    }

    const expectedComposePath = join(this.localDir, `${problem.composeProjectName}.compose.yml`);
    if (
      resolve(unit.composePath) !== resolve(expectedComposePath) ||
      unit.remappedComposePath === undefined ||
      resolve(unit.remappedComposePath) !== resolve(expectedComposePath) ||
      resolve(unit.projectDirectory ?? "") !== resolve(dirname(problem.composePath)) ||
      this.deps.readCompose(unit.composePath) !== remappedCompose
    ) {
      throw new Error(
        `Recorded compose unit does not match offset ${offset} for "${problem.problemId}"`,
      );
    }
  }

  private async waitUntilReady(
    problem: ContainerProblem,
    unit: LocalComposeUnit,
    sensitiveValues: readonly string[],
  ): Promise<void> {
    try {
      await Promise.all([
        this.deps.waitForReachable(problem.verifyUrl, "verify endpoint"),
        ...Object.entries(problem.challengeEndpoints).map(([label, url]) =>
          this.deps.waitForReachable(url, `challenge endpoint ${label}`),
        ),
      ]);
    } catch (error) {
      let diagnostics: string | undefined;
      try {
        diagnostics = this.deps.diagnoseComposeUnit?.(unit, sensitiveValues);
      } catch {
        // Diagnostics are best effort and must never replace the endpoint failure.
      }
      if (!diagnostics) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\n${diagnostics}`, { cause: error });
    }
  }

  /** Tear one unit down (idempotent) and drop its remapped temp compose. */
  stop(unit: LocalComposeUnit): void {
    this.stopPhysical(unit);
    this.finalizeStop(unit);
  }

  /** Physical compose down; the ownership record and temp compose still remain retryable. */
  stopPhysical(unit: LocalComposeUnit): void {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Compose treats an empty value as missing for `${NAME:?message}`. A
    // non-secret placeholder is enough for interpolation; `down` never starts
    // a container or evaluates the challenge's secret.
    for (const name of unit.secretEnv) env[name] = CLEANUP_SECRET_VALUE;
    this.deps.runCompose(
      unit.composePath,
      unit.composeProjectName,
      "down",
      env,
      false,
      unit.projectDirectory,
    );
  }

  /** Delete the remapped compose only after durable ownership release succeeds. */
  finalizeStop(unit: LocalComposeUnit): void {
    if (unit.remappedComposePath) this.deps.removeTempCompose(unit.remappedComposePath);
  }
}
