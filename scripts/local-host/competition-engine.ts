import type { CloudFormationEngine } from "./cloudformation-engine";
import {
  coordinationCatalog,
  coordinationProblemView,
  LocalPluginLoader,
  noCoordinationSurface,
} from "./coordination-runtime";
import { DockerHostingEngine } from "./docker-engine";
import {
  type Context,
  type DefinitionKind,
  definitionKind,
  type EngineResult,
  HostError,
  type HostedEvent,
  isSolve,
  type Job,
  type Problem,
} from "./model";

function problemKinds(event: HostedEvent): ReadonlyMap<string, DefinitionKind> {
  return new Map(
    event.problems.map((problem) => [problem.problemId, definitionKind(problem.definition)]),
  );
}

/** Runtime dispatch only; cryptography and scoring rules belong to the catalog plugin. */
export class CompetitionEngine extends DockerHostingEngine {
  private readonly battles: Problem[];
  private readonly loader: LocalPluginLoader;
  constructor(
    root: string,
    dataDirectory: string,
    /** False in a container: Docker Compose problems publish on a loopback it cannot reach. */
    private readonly dockerProblems = true,
    /** Present only when the host was started with `--aws-region`. */
    private readonly cloud?: CloudFormationEngine,
  ) {
    super(root, dataDirectory);
    this.battles = coordinationCatalog(root);
    this.loader = new LocalPluginLoader(dataDirectory);
  }
  override catalog(): readonly Problem[] {
    return [
      ...(this.dockerProblems ? super.catalog() : []),
      ...this.battles,
      ...(this.cloud?.catalog() ?? []),
    ];
  }
  /** Decided by kind alone, so slot allocation still works for old cloud jobs without AWS. */
  requiresGateway(definition: string): boolean {
    return definitionKind(definition) === "compose";
  }
  coordinationPlugin(problem: Problem) {
    return this.loader.load(problem.definition);
  }
  override hostPorts(definition: string, offset: number): readonly number[] {
    return definitionKind(definition) === "compose" ? super.hostPorts(definition, offset) : [];
  }
  override async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.start(job, retain);
    if (kind === "cloudformation") return this.aws().start(job, retain);
    this.loader.load(job.definition);
    retain(
      JSON.stringify({ kind: "coordination", eventId: job.eventId, problemId: job.problemId }),
    );
  }
  override async recover(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.recover(job);
    if (kind === "cloudformation") return this.aws().recover(job);
    this.loader.load(job.definition);
  }
  override async pause(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.pause(job);
    if (kind === "cloudformation") return this.aws().pause();
  }
  override async resume(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.resume(job);
    if (kind === "cloudformation") return this.aws().resume(job);
    this.loader.load(job.definition);
  }
  override async stop(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.stop(job);
    if (kind === "cloudformation") return this.aws().stop(job);
    // Shared match state and scores survive a team's stop/restart/teardown.
  }
  override surface(job: Job): string {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.surface(job);
    if (kind === "cloudformation") return this.aws().surface(job);
    return noCoordinationSurface();
  }
  private aws(): CloudFormationEngine {
    if (!this.cloud)
      throw new HostError(
        503,
        "This event has AWS problems. Restart the host with --aws-region and AWS credentials.",
        "aws_not_configured",
      );
    return this.cloud;
  }
  private only(
    context: Context,
    kinds: ReadonlyMap<string, DefinitionKind>,
    kind: DefinitionKind,
  ): Context {
    return {
      ...context,
      event: {
        ...context.event,
        problems: context.event.problems.filter((problem) => kinds.get(problem.problemId) === kind),
      },
      jobs: context.jobs.filter((job) => kinds.get(job.problemId) === kind),
    };
  }
  override async view(context: Context): Promise<Record<string, unknown>> {
    const kinds = problemKinds(context.event);
    const docker = this.only(context, kinds, "compose");
    const base = docker.event.problems.length ? await super.view(docker) : { problems: [] };
    const battles = context.event.problems
      .filter((problem) => kinds.get(problem.problemId) === "coordination")
      .map((problem) =>
        coordinationProblemView(
          problem,
          context.team.scoreEvents
            .filter(
              (event) => event.problemId === problem.problemId && event.source === "coordination",
            )
            .reduce((sum, event) => sum + event.points, 0),
          context.event.createdAt,
        ),
      );
    const cloud = this.only(context, kinds, "cloudformation");
    const stacks = cloud.event.problems.length ? await this.aws().view(cloud) : { problems: [] };
    return {
      ...base,
      problems: [...(base.problems as unknown[]), ...battles, ...(stacks.problems as unknown[])],
    };
  }
  /**
   * Docker rebuilds its own events and totals from its snapshot. Battle and cloud events live
   * only on the team, so they are added back or a Docker action would drop them.
   */
  private combined(
    result: EngineResult,
    context: Context,
    kinds: ReadonlyMap<string, DefinitionKind>,
  ): EngineResult {
    const kept = context.team.scoreEvents.filter((event) => {
      const kind = kinds.get(event.problemId);
      return kind === "coordination" || kind === "cloudformation";
    });
    const cloudSolves = new Set(
      kept
        .filter((event) => kinds.get(event.problemId) === "cloudformation" && isSolve(event))
        .map((event) => event.problemId),
    );
    return {
      ...result,
      score: result.score + kept.reduce((sum, event) => sum + event.points, 0),
      completedProblems: result.completedProblems + cloudSolves.size,
      scoreEvents: [...result.scoreEvents, ...kept].sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt),
      ),
    };
  }
  override async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    const kinds = problemKinds(context.event);
    if (kinds.get(String(body.problemId)) === "cloudformation")
      return this.aws().submit(this.only(context, kinds, "cloudformation"), body);
    return this.combined(
      await super.submit(this.only(context, kinds, "compose"), body),
      context,
      kinds,
    );
  }
  override async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    const kinds = problemKinds(context.event);
    if (kinds.get(problemId) === "cloudformation")
      return this.aws().hint(this.only(context, kinds, "cloudformation"), problemId, hintId);
    return this.combined(
      await super.hint(this.only(context, kinds, "compose"), problemId, hintId),
      context,
      kinds,
    );
  }
}
