import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { revealHint, submitFlag } from "../local-play/api-scoring";
import { createLocalPlayState, sessionScore } from "../local-play/api-state";
import { teamView } from "../local-play/api-views";
import { assertComposePolicy } from "../local-play/compose-policy";
import type { LocalComposeUnit, StartedContainer } from "../local-play/container-runner";
import {
  composeArgsForCli,
  generateSecretEnv,
  isComposeUnitRunning,
  resolveComposeCli,
} from "../local-play/docker-adapter";
import { type ContainerProblem, loadContainerProblem } from "../local-play/manifest";
import { remapComposeHostPorts, remapContainerProblem } from "../local-play/port-remap";
import {
  parseLocalPlaySnapshot,
  restoreLocalPlayState,
  snapshotLocalPlayState,
} from "../local-play/state-store";
import { verifySubmission } from "../local-play/verify-client";
import { privateDirectory } from "./files";
import {
  type Context,
  type EngineResult,
  HostError,
  type Job,
  object,
  type Problem,
  type RuntimeEngine,
} from "./model";

interface Definition {
  problem: ContainerProblem;
  hashes: Record<string, string>;
  composeText: string;
}
const fingerprint = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const packFiles = [
  "metadata.json",
  "local/docker-compose.yml",
  "local/Dockerfile",
  "local/app/server.mjs",
];
/** Deliberately small compatibility matrix: extending it requires reviewing the
 * challenge's HTTP surface, origin requirements and runtime isolation as well. */
function loadCatalog(repositoryRoot: string): Problem[] {
  const directory = join(repositoryRoot, "problems/challenges/sqli-demo");
  const problem = loadContainerProblem(directory);
  if (
    problem.scoring.kind !== "verify" ||
    problem.terminal ||
    Object.keys(problem.challengeEndpoints).join() !== "Web"
  ) {
    throw new Error("sqli-demo's runtime contract changed; review local-host compatibility.");
  }
  const definition: Definition = {
    problem,
    composeText: readFileSync(problem.composePath, "utf8"),
    hashes: Object.fromEntries(packFiles.map((path) => [path, fingerprint(join(directory, path))])),
  };
  return [
    {
      problemId: problem.problemId,
      name: problem.name,
      definition: JSON.stringify(definition),
    },
  ];
}

function definitionOf(job: Job, verifySources: boolean): Definition {
  const definition = JSON.parse(job.definition) as Definition;
  if (!verifySources) return definition;
  for (const [path, expected] of Object.entries(definition.hashes)) {
    if (fingerprint(join(definition.problem.problemDir, path)) !== expected) {
      throw new Error(
        "The event's pinned problem files changed. Restore the original catalog before continuing.",
      );
    }
  }
  return definition;
}

async function compose(
  unit: LocalComposeUnit,
  action: "up" | "down",
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const cli = resolveComposeCli();
  const args = composeArgsForCli(
    cli,
    unit.composePath,
    unit.composeProjectName,
    action,
    unit.projectDirectory,
  );
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
      else {
        const daemon = /cannot connect|daemon.*not running/iu.test(tail);
        reject(
          new Error(
            daemon
              ? "Docker daemon is unavailable. Start Docker Desktop or Engine and retry."
              : `Docker Compose ${action} failed (exit ${String(code)}). Inspect project ${unit.composeProjectName} on the host.`,
          ),
        );
      }
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
  private readonly problems: Problem[];
  private readonly running = new Map<string, StartedContainer>();
  constructor(
    repositoryRoot: string,
    private readonly dataDirectory: string,
  ) {
    this.problems = loadCatalog(repositoryRoot);
  }
  catalog(): readonly Problem[] {
    return this.problems;
  }
  private plan(
    job: Job,
    verifySources = true,
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
    const remapped = remapComposeHostPorts(source, job.offset);
    const directory = privateDirectory(join(this.dataDirectory, "runtimes", job.jobId));
    const composePath = join(directory, `${problem.composeProjectName}.compose.yml`);
    const unit: LocalComposeUnit = {
      problemId: job.problemId,
      offset: job.offset,
      composePath,
      composeProjectName: problem.composeProjectName,
      secretEnv: problem.secretEnv,
      projectDirectory: dirname(problem.composePath),
      remappedComposePath: composePath,
    };
    return {
      started: { unit, problem: remapContainerProblem(problem, remapped.portMap) },
      composeText: remapped.text,
      directory,
    };
  }
  async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    // Readiness of the CLI is checked on deploy, never on host startup.
    resolveComposeCli();
    const plan = this.plan(job);
    const unit = plan.started.unit;
    writeFileSync(unit.composePath, plan.composeText, { mode: 0o600 });
    retain(JSON.stringify(unit));
    const generated = generateSecretEnv(plan.directory, job.problemId, unit.secretEnv);
    try {
      await compose(unit, "up", { ...process.env, ...generated });
      await ready(plan.started.problem.verifyUrl);
      await ready(this.surfaceFrom(plan.started));
      this.running.set(job.jobId, plan.started);
    } catch (error) {
      try {
        await compose(unit, "down", { ...process.env, ...generated });
        unlinkSync(unit.composePath);
        retain(null);
      } catch {
        throw new Error(
          "Problem startup failed and cleanup was incomplete. Runtime ownership was retained; use host teardown to retry.",
          { cause: error },
        );
      }
      throw error;
    }
  }
  async recover(job: Job): Promise<void> {
    const plan = this.plan(job);
    const unit = this.validatedUnit(job, plan.started.unit);
    if (readFileSync(unit.composePath, "utf8") !== plan.composeText)
      throw new Error("Recorded runtime composition changed; refusing to adopt it.");
    if (!isComposeUnitRunning(unit))
      throw new Error(
        "The recorded problem environment is not running. Retry deployment from the host console.",
      );
    await ready(plan.started.problem.verifyUrl);
    await ready(this.surfaceFrom(plan.started));
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
    const plan = this.plan(job, false);
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
    unlinkSync(unit.composePath);
  }
  private surfaceFrom(started: StartedContainer): string {
    const url = started.problem.challengeEndpoints.Web;
    if (!url) throw new Error("This problem has no reviewed Web surface.");
    return url;
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
    const state = createLocalPlayState(
      { problems },
      {
        teamName: context.team.displayName,
        maxRunning: Math.max(1, problems.length),
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
        stopContainer: async () => {
          throw new Error("Participant state may not stop host-owned environments.");
        },
      },
    );
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
    const response = revealHint(problemId, hintId, state, new Date(context.now).toISOString());
    return this.result(state, response, context);
  }
}
