import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ComposeCli,
  composeArgsForCli,
  generateSecretEnv,
  isComposeUnitRunning,
  resolveComposeCli,
} from "./container/compose-cli";
import { assertComposePolicy } from "./container/compose-policy";
import type { LocalComposeUnit, StartedContainer } from "./container/container-runner";
import { remapContainerProblem } from "./container/port-remap";
import { revealContainerHint, submitFlag } from "./container/scoring";
import { createContainerState } from "./container/session";
import { sessionScore } from "./container/state";
import {
  parseLocalPlaySnapshot,
  restoreLocalPlayState,
  snapshotLocalPlayState,
} from "./container/state-store";
import {
  spawnDeclaredTerminal,
  type TerminalHandlers,
  type TerminalProcess,
} from "./container/terminal-shell";
import { verifySubmission } from "./container/verify-client";
import { teamView } from "./container/views";
import { requestWorkbench, type WorkbenchAction } from "./container/workbench-client";
import { boundedCompose } from "./container-budget";
import {
  type DockerDefinition as Definition,
  dockerDefinitionOf as definitionOf,
  loadDockerCatalog,
} from "./docker-catalog";
import {
  allocateNetworkSubnets,
  applyNetworkSubnets,
  DockerNetworkInventoryError,
  type NetworkSubnets,
  occupiedDockerSubnets,
} from "./docker-networks";
import {
  type Context,
  type EngineResult,
  HostError,
  type Job,
  object,
  type Problem,
  type RuntimeEngine,
} from "./model";
import { prepareRuntimeDirectory, removeRuntimeFiles } from "./runtime-directory";
import { type RuntimePorts, remapRuntimeComposePorts } from "./runtime-ports";

type ComposeAction = "up" | "down" | "stop" | "restart";

/** Recognizes "no daemon" across Docker CLI generations, Docker Desktop and Compose v1. */
const DAEMON_UNAVAILABLE =
  /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|daemon is not running|error during connect/iu;

export const DAEMON_UNAVAILABLE_MESSAGE =
  "Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry the deployment from the host console.";

/** A Compose failure caused by an unreachable daemon, never by the problem itself. */
export class DockerDaemonUnavailableError extends Error {
  constructor() {
    super(DAEMON_UNAVAILABLE_MESSAGE);
    this.name = "DockerDaemonUnavailableError";
  }
}

function composeCommandArgs(
  cli: ComposeCli,
  unit: LocalComposeUnit,
  action: ComposeAction,
): string[] {
  if (action === "up" || action === "down")
    return composeArgsForCli(
      cli,
      unit.composePath,
      unit.composeProjectName,
      action,
      unit.projectDirectory,
    );
  // `stop` keeps containers and volumes; `restart` starts stopped or running ones in place.
  const args = [
    "-f",
    unit.composePath,
    "-p",
    unit.composeProjectName,
    ...(unit.projectDirectory ? ["--project-directory", unit.projectDirectory] : []),
    action,
  ];
  return cli.command === "docker-compose" ? args : ["compose", ...args];
}

async function compose(
  unit: LocalComposeUnit,
  action: ComposeAction,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const cli = resolveComposeCli();
  const args = composeCommandArgs(cli, unit, action);
  await new Promise<void>((accept, reject) => {
    const child = spawn(cli.command, args, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    child.stderr.on("data", (chunk) => {
      tail = (tail + String(chunk)).slice(-16_384);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      // Do not send build logs or interpolated environment values to a competitor.
      if (code === 0) accept();
      else if (DAEMON_UNAVAILABLE.test(tail)) reject(new DockerDaemonUnavailableError());
      else if (/all predefined address pools have been fully subnetted/iu.test(tail))
        reject(
          new Error(
            "Docker has no free network address pool. Stopping an environment preserves its network and unfinished work. Configure a non-overlapping --docker-network-pool for new environments, or explicitly retire completed environments. No unrelated networks or retained team data were removed.",
          ),
        );
      else
        reject(
          new Error(
            `Docker Compose ${action} failed (exit ${String(code)}). Inspect project ${unit.composeProjectName} on the host.`,
          ),
        );
    });
  });
}

async function ready(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return;
    } catch {
      await new Promise((accept) => setTimeout(accept, 250));
    }
  }
  throw new Error("The problem's verifier did not become reachable within one minute.");
}

export class DockerHostingEngine implements RuntimeEngine {
  readonly supportsOnDemand = true;
  containerCost(definition: string) {
    return boundedCompose((JSON.parse(definition) as Definition).composeText).cost;
  }
  private readonly problems: Problem[];
  private readonly running = new Map<string, StartedContainer>();
  private readonly networkReservations = new Map<string, readonly string[]>();
  constructor(
    repositoryRoot: string,
    private readonly dataDirectory: string,
    private readonly networkPool?: string,
  ) {
    this.problems = loadDockerCatalog(repositoryRoot);
  }
  catalog(): readonly Problem[] {
    return this.problems;
  }
  hostPorts(definition: string, offset: number, runtimePorts?: RuntimePorts): readonly number[] {
    const { composeText } = JSON.parse(definition) as Definition;
    return [...remapRuntimeComposePorts(composeText, offset, runtimePorts).portMap.values()];
  }
  private plan(
    job: Job,
    verifySources = true,
    newSubnets?: NetworkSubnets,
    claimNewDirectory = false,
  ): {
    started: StartedContainer;
    composeText: string;
    directory: string;
  } {
    const { problem: original, composeText: source } = definitionOf(job, verifySources);
    const problem = { ...original, composeProjectName: `tch-${job.jobId.toLowerCase()}` };
    assertComposePolicy(source, {
      problemDir: problem.problemDir,
      composePath: problem.composePath,
    });
    const remapped = remapRuntimeComposePorts(source, job.offset, job.runtimePorts);
    let plannedCompose = job.runtimePorts ? boundedCompose(remapped.text).text : remapped.text;
    const networkSubnets =
      newSubnets ??
      (job.unit ? (JSON.parse(job.unit) as LocalComposeUnit).networkSubnets : undefined);
    if (networkSubnets) plannedCompose = applyNetworkSubnets(plannedCompose, networkSubnets);
    const directory = prepareRuntimeDirectory(this.dataDirectory, job.jobId, claimNewDirectory);
    const composePath = join(directory, `${problem.composeProjectName}.compose.yml`);
    const unit: LocalComposeUnit = {
      problemId: job.problemId,
      offset: job.offset,
      composePath,
      composeProjectName: problem.composeProjectName,
      secretEnv: problem.secretEnv,
      projectDirectory: dirname(problem.composePath),
      remappedComposePath: composePath,
      ...(networkSubnets ? { networkSubnets } : {}),
    };
    return {
      started: { unit, problem: remapContainerProblem(problem, remapped.portMap) },
      composeText: plannedCompose,
      directory,
    };
  }
  private allocateNetworks(job: Job): NetworkSubnets | undefined {
    if (!this.networkPool || !job.runtimePorts) return undefined;
    try {
      return allocateNetworkSubnets(definitionOf(job, true).composeText, this.networkPool, [
        ...occupiedDockerSubnets(),
        ...[...this.networkReservations.values()].flat(),
      ]);
    } catch (cause) {
      if (cause instanceof DockerNetworkInventoryError && cause.daemonUnavailable)
        throw new DockerDaemonUnavailableError();
      throw cause;
    }
  }
  async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    // Readiness of the CLI is checked on deploy, never on host startup.
    resolveComposeCli();
    if (job.unit) throw new Error("A retained environment must be resumed, never recreated.");
    const networkSubnets = this.allocateNetworks(job);
    const plan = this.plan(job, true, networkSubnets, true);
    if (networkSubnets) this.networkReservations.set(job.jobId, Object.values(networkSubnets));
    const unit = plan.started.unit;
    writeFileSync(unit.composePath, plan.composeText, { mode: 0o600 });
    retain(JSON.stringify(unit));
    const generated = generateSecretEnv(plan.directory, job.problemId, unit.secretEnv);
    try {
      await compose(unit, "up", { ...process.env, ...generated });
      await ready(plan.started.problem.verifyUrl);
      await this.readySurfaces(plan.started);
      this.running.set(job.jobId, plan.started);
    } catch (error) {
      try {
        await compose(unit, "down", { ...process.env, ...generated });
        removeRuntimeFiles(this.dataDirectory, job.jobId, unit.composePath);
        retain(null);
        this.networkReservations.delete(job.jobId);
      } catch (cleanup) {
        throw startupCleanupFailure(error, cleanup);
      }
      throw error;
    }
  }
  async recover(job: Job): Promise<void> {
    const plan = this.plan(job);
    const unit = this.validatedUnit(job, plan.started.unit);
    if (unit.networkSubnets)
      this.networkReservations.set(job.jobId, Object.values(unit.networkSubnets));
    if (readFileSync(unit.composePath, "utf8") !== plan.composeText)
      throw new Error("Recorded runtime composition changed; refusing to adopt it.");
    if (!isComposeUnitRunning(unit))
      throw new Error(
        "The recorded problem environment is not running. Retry deployment from the host console.",
      );
    await ready(plan.started.problem.verifyUrl);
    await this.readySurfaces(plan.started);
    this.running.set(job.jobId, plan.started);
  }
  private validatedUnit(job: Job, expected: LocalComposeUnit): LocalComposeUnit {
    if (!job.unit) throw new Error("Missing durable runtime ownership.");
    const unit = JSON.parse(job.unit) as LocalComposeUnit;
    for (const key of [
      "problemId",
      "offset",
      "composePath",
      "composeProjectName",
      "projectDirectory",
      "remappedComposePath",
    ] as const) {
      if (unit[key] !== expected[key])
        throw new Error("Runtime ownership does not match this team/problem.");
    }
    if (JSON.stringify(unit.secretEnv) !== JSON.stringify(expected.secretEnv))
      throw new Error("Runtime secret declaration changed.");
    return unit;
  }
  async stop(job: Job): Promise<void> {
    // Cleanup must remain possible after a catalog update. The private persisted
    // compose text is the original creation plan, not the new checkout's file.
    const plan = this.plan(job, false, undefined, true);
    const unit = this.validatedUnit(job, plan.started.unit);
    // Reconstruct only a missing file from the private pinned plan. A different
    // existing file is a conflict, never something we execute or overwrite.
    if (!existsSync(unit.composePath))
      writeFileSync(unit.composePath, plan.composeText, { flag: "wx", mode: 0o600 });
    if (readFileSync(unit.composePath, "utf8") !== plan.composeText)
      throw new Error("Recorded runtime composition changed; refusing unsafe cleanup.");
    // Compose down still interpolates variables, but does not need the original
    // secret. Cleanup must work even if a deployment's private seed file is lost.
    const cleanupEnvironment = Object.fromEntries(
      unit.secretEnv.map((name) => [name, "tenkacloud-host-cleanup"]),
    );
    await compose(unit, "down", { ...process.env, ...cleanupEnvironment });
    this.running.delete(job.jobId);
    this.networkReservations.delete(job.jobId);
    removeRuntimeFiles(this.dataDirectory, job.jobId, unit.composePath);
  }
  /** Validated, unchanged private plan of an owned environment. */
  private ownedUnit(
    job: Job,
    verifySources: boolean,
  ): { unit: LocalComposeUnit; directory: string } {
    const plan = this.plan(job, verifySources);
    const unit = this.validatedUnit(job, plan.started.unit);
    if (
      !existsSync(unit.composePath) ||
      readFileSync(unit.composePath, "utf8") !== plan.composeText
    )
      throw new Error(
        "Recorded runtime composition changed or is missing; refusing to operate it.",
      );
    return { unit, directory: plan.directory };
  }
  async pause(job: Job): Promise<void> {
    const { unit } = this.ownedUnit(job, false);
    // `compose stop` never recreates containers; interpolation needs names, not the secrets.
    const placeholders = Object.fromEntries(
      unit.secretEnv.map((name) => [name, "tenkacloud-host-stop"]),
    );
    this.running.delete(job.jobId);
    await compose(unit, "stop", { ...process.env, ...placeholders });
  }
  async resume(job: Job): Promise<void> {
    const plan = this.plan(job);
    const { unit, directory } = this.ownedUnit(job, true);
    const generated = generateSecretEnv(directory, job.problemId, unit.secretEnv);
    await compose(unit, "restart", { ...process.env, ...generated });
    await ready(plan.started.problem.verifyUrl);
    await this.readySurfaces(plan.started);
    this.running.set(job.jobId, plan.started);
  }
  private surfaceFrom(started: StartedContainer): string {
    const url = Object.values(started.problem.challengeEndpoints)[0];
    if (!url) throw new Error("This problem has no participant HTTP surface.");
    return new URL(url).origin;
  }
  private async readySurfaces(started: StartedContainer): Promise<void> {
    for (const url of new Set(Object.values(started.problem.challengeEndpoints))) await ready(url);
  }
  surfaces(job: Job): Readonly<Record<string, string>> {
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    return started.problem.challengeEndpoints;
  }
  gatewayPolicy(job: Job): { applicationRoutes: boolean; deniedPaths: readonly string[] } {
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    const verify = new URL(started.problem.verifyUrl);
    return {
      applicationRoutes: true,
      deniedPaths: verify.origin === this.surfaceFrom(started) ? [verify.pathname] : [],
    };
  }
  terminalSupported(job: Job): boolean {
    return Boolean(this.running.get(job.jobId)?.problem.terminal);
  }
  async openTerminal(
    job: Job,
    handlers: TerminalHandlers,
    assertCurrent: () => void,
  ): Promise<TerminalProcess> {
    const { unit } = this.ownedUnit(job, true);
    const terminal = this.running.get(job.jobId)?.problem.terminal;
    if (!terminal) throw new HostError(409, "This problem has no running participant terminal.");
    return spawnDeclaredTerminal(unit, terminal.service, handlers, assertCurrent);
  }
  async workbench(job: Job, action: WorkbenchAction, body?: unknown): Promise<unknown> {
    this.ownedUnit(job, true);
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    return requestWorkbench(started.problem.verifyUrl, action, body);
  }
  surface(job: Job): string {
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    return this.surfaceFrom(started);
  }
  private async state(context: Context) {
    const problems = context.event.problems.map(
      (problem) => (JSON.parse(problem.definition) as Definition).problem,
    );
    const state = createContainerState(problems, {
      teamName: context.team.displayName,
      verify: (url, submission, verifyContext, options) =>
        verifySubmission(
          url,
          submission,
          { ...verifyContext, teamId: context.team.teamId },
          {
            ...options,
            fetchImpl: (input, init) =>
              fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
          },
        ),
      startContainer: async (problem) => {
        const job = context.jobs.find(
          (candidate) =>
            candidate.problemId === problem.problemId && candidate.status === "COMPLETE",
        );
        const started = job && this.running.get(job.jobId);
        if (!started) throw new Error("Host-owned problem runtime is unavailable.");
        return started;
      },
    });
    if (context.team.snapshot)
      restoreLocalPlayState(state, parseLocalPlaySnapshot(context.team.snapshot));
    for (const job of context.jobs) {
      if (job.status === "COMPLETE" && this.running.has(job.jobId))
        await state.lifecycle.ensureRunning(job.problemId);
    }
    return state;
  }
  async view(context: Context): Promise<Record<string, unknown>> {
    const state = await this.state(context);
    return object(teamView(state, context.now).body);
  }
  private result(
    state: Awaited<ReturnType<DockerHostingEngine["state"]>>,
    response: {
      status: number;
      body: unknown;
    },
    context: Context,
  ): EngineResult {
    const snapshot = snapshotLocalPlayState(state);
    const jobs = new Map(context.jobs.map((job) => [job.problemId, job.jobId]));
    const completedProblems = [...state.runtimes.values()].filter((runtime) =>
      runtime.problem.scoring.kind === "verify"
        ? runtime.solved.has(runtime.problem.problemId)
        : runtime.problem.scoring.checks.every((check) => runtime.solved.has(check.id)),
    ).length;
    return {
      status: response.status,
      body: object(response.body),
      snapshot: JSON.stringify(snapshot),
      score: sessionScore(state),
      completedProblems,
      scoreEvents: state.scoreEvents.map((event) => ({
        ...event,
        jobId: jobs.get(event.problemId) ?? event.jobId,
      })),
    };
  }
  async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    const state = await this.state(context);
    const response = await submitFlag(
      {
        method: "POST",
        path: "/portal/me/submit-flag",
        query: {},
        body,
      },
      state,
      new Date(context.now).toISOString(),
    );
    return this.result(state, response, context);
  }
  async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    const state = await this.state(context);
    const response = revealContainerHint(
      problemId,
      hintId,
      state,
      new Date(context.now).toISOString(),
    );
    return this.result(state, response, context);
  }
}

/**
 * Startup failed and removing its partial environment failed too. The first failure is the
 * cause the organizer has to fix; ownership stays recorded, and the next deployment retry
 * removes the partial environment before starting again.
 */
function startupCleanupFailure(startup: unknown, cleanup: unknown): Error {
  if (startup instanceof DockerDaemonUnavailableError) return new DockerDaemonUnavailableError();
  const reason = startup instanceof Error ? startup.message : String(startup);
  const cleanupReason = cleanup instanceof Error ? cleanup.message : String(cleanup);
  return new Error(
    `${reason} Removing the partial environment also failed (${cleanupReason}); ownership is retained and retrying the deployment removes it first.`,
    { cause: startup },
  );
}
