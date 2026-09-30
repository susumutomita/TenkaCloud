import {
  coordinationCatalog,
  coordinationProblemView,
  isCoordination,
  LocalPluginLoader,
  noCoordinationSurface,
} from "./coordination-runtime";
import { DockerHostingEngine } from "./docker-engine";
import type { Context, EngineResult, Job, Problem } from "./model";

/** Runtime dispatch only; cryptography and scoring rules belong to the catalog plugin. */
export class CompetitionEngine extends DockerHostingEngine {
  private readonly battles: Problem[];
  private readonly loader: LocalPluginLoader;
  constructor(
    root: string,
    dataDirectory: string,
    /** False in a container: Docker Compose problems publish on a loopback it cannot reach. */
    private readonly dockerProblems = true,
  ) {
    super(root, dataDirectory);
    this.battles = coordinationCatalog(root);
    this.loader = new LocalPluginLoader(dataDirectory);
  }
  override catalog(): readonly Problem[] {
    return [...(this.dockerProblems ? super.catalog() : []), ...this.battles];
  }
  requiresGateway(definition: string): boolean {
    return !isCoordination(definition);
  }
  coordinationPlugin(problem: Problem) {
    return this.loader.load(problem.definition);
  }
  override hostPorts(definition: string, offset: number): readonly number[] {
    return isCoordination(definition) ? [] : super.hostPorts(definition, offset);
  }
  override async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    if (!isCoordination(job.definition)) return super.start(job, retain);
    this.loader.load(job.definition);
    retain(
      JSON.stringify({ kind: "coordination", eventId: job.eventId, problemId: job.problemId }),
    );
  }
  override async recover(job: Job): Promise<void> {
    if (!isCoordination(job.definition)) return super.recover(job);
    this.loader.load(job.definition);
  }
  override async pause(job: Job): Promise<void> {
    if (!isCoordination(job.definition)) return super.pause(job);
  }
  override async resume(job: Job): Promise<void> {
    if (!isCoordination(job.definition)) return super.resume(job);
    this.loader.load(job.definition);
  }
  override async stop(job: Job): Promise<void> {
    if (!isCoordination(job.definition)) return super.stop(job);
    // Shared match state and scores survive a team's stop/restart/teardown.
  }
  override surface(job: Job): string {
    return isCoordination(job.definition) ? noCoordinationSurface() : super.surface(job);
  }
  private dockerContext(context: Context): Context {
    return {
      ...context,
      event: {
        ...context.event,
        problems: context.event.problems.filter((problem) => !isCoordination(problem.definition)),
      },
      jobs: context.jobs.filter((job) => !isCoordination(job.definition)),
    };
  }
  override async view(context: Context): Promise<Record<string, unknown>> {
    const docker = this.dockerContext(context);
    const base = docker.event.problems.length ? await super.view(docker) : { problems: [] };
    const battles = context.event.problems
      .filter((problem) => isCoordination(problem.definition))
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
    return { ...base, problems: [...(base.problems as unknown[]), ...battles] };
  }
  private combined(result: EngineResult, context: Context): EngineResult {
    const events = context.team.scoreEvents.filter((event) => event.source === "coordination");
    return {
      ...result,
      score: result.score + events.reduce((sum, event) => sum + event.points, 0),
      scoreEvents: [...result.scoreEvents, ...events].sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt),
      ),
    };
  }
  override async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    return this.combined(await super.submit(this.dockerContext(context), body), context);
  }
  override async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    return this.combined(await super.hint(this.dockerContext(context), problemId, hintId), context);
  }
}
