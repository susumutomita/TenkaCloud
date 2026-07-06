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
 * `docker compose` primitives.
 */

import { dirname, join } from "node:path";
import type { ContainerProblem } from "./manifest";
import { offsetLoopbackEndpoints, offsetLoopbackUrl, remapComposeHostPorts } from "./port-remap";

/** One problem's compose unit — the handle needed to tear it down. */
export interface LocalComposeUnit {
  readonly problemId: string;
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
  readonly generateSecretEnv: (names: readonly string[]) => Record<string, string>;
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
  async start(problem: ContainerProblem, offset: number): Promise<StartedContainer> {
    const { text, portMap } = remapComposeHostPorts(
      this.deps.readCompose(problem.composePath),
      offset,
    );
    let composePath = problem.composePath;
    let projectDirectory: string | undefined;
    let remappedComposePath: string | undefined;
    if (offset > 0) {
      remappedComposePath = join(this.localDir, `${problem.composeProjectName}.compose.yml`);
      this.deps.writeTempCompose(remappedComposePath, text);
      composePath = remappedComposePath;
      projectDirectory = dirname(problem.composePath);
    }
    const remappedProblem: ContainerProblem = {
      ...problem,
      challengeEndpoints: offsetLoopbackEndpoints(problem.challengeEndpoints, portMap),
      verifyUrl: offsetLoopbackUrl(problem.verifyUrl, portMap),
    };
    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.deps.generateSecretEnv(problem.secretEnv),
    };
    this.deps.log(`Starting problem container for ${problem.name}...`);
    this.deps.runCompose(
      composePath,
      problem.composeProjectName,
      "up",
      composeEnv,
      false,
      projectDirectory,
    );
    await Promise.all(
      Object.entries(remappedProblem.challengeEndpoints).map(([label, url]) =>
        this.deps.waitForReachable(url, `challenge endpoint ${label}`),
      ),
    );
    return {
      problem: remappedProblem,
      unit: {
        problemId: problem.problemId,
        composePath,
        composeProjectName: problem.composeProjectName,
        secretEnv: problem.secretEnv,
        ...(projectDirectory ? { projectDirectory } : {}),
        ...(remappedComposePath ? { remappedComposePath } : {}),
      },
    };
  }

  /** Tear one unit down (idempotent) and drop its remapped temp compose. */
  stop(unit: LocalComposeUnit): void {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Blank the per-deploy secret names so compose interpolation does not warn on down.
    for (const name of unit.secretEnv) env[name] = "";
    this.deps.runCompose(
      unit.composePath,
      unit.composeProjectName,
      "down",
      env,
      true,
      unit.projectDirectory,
    );
    if (unit.remappedComposePath) this.deps.removeTempCompose(unit.remappedComposePath);
  }
}
