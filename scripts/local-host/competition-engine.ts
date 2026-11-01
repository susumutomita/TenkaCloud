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
import { projectedScore } from "./score";
import {
  submissionCatalog,
  submissionDefinition,
  submissionProblemView,
  submitStudy,
} from "./submission-runtime";

function problemKinds(event: HostedEvent): ReadonlyMap<string, DefinitionKind> {
  return new Map(
    event.problems.map((problem) => [problem.problemId, definitionKind(problem.definition)]),
  );
}

/**
 * Saved events from an older hosting revision can contain CloudFormation jobs. Local hosting
 * keeps their state and refuses every operation on them; it never changes AWS resources.
 */
function retiredAwsJob(): never {
  throw new HostError(
    503,
    "This event contains AWS resources from an older hosting revision. They are not operated by local hosting. Keep their state and use the reviewed cloud or legacy cleanup workflow; no AWS resources were changed.",
    "aws_not_configured",
  );
}

/** Runtime dispatch only; cryptography and scoring rules belong to the catalog plugin. */
export class CompetitionEngine extends DockerHostingEngine {
  private readonly battles: Problem[];
  private readonly submissions: readonly Problem[];
  private readonly loader: LocalPluginLoader;
  constructor(
    root: string,
    dataDirectory: string,
    /** False in a container: Docker Compose problems publish on a loopback it cannot reach. */
    private readonly dockerProblems = true,
    networkPool?: string,
    submissionCatalogPath?: string,
    competitionNetwork = false,
    readonly catalogWarnings: readonly string[] = [],
  ) {
    super(root, dataDirectory, networkPool, competitionNetwork);
    this.battles = coordinationCatalog(root);
    this.submissions = submissionCatalog(submissionCatalogPath);
    const ids = [
      ...(dockerProblems ? super.catalog() : []),
      ...this.battles,
      ...this.submissions,
    ].map((problem) => problem.problemId);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate problem catalog identity.");
    this.loader = new LocalPluginLoader(dataDirectory);
  }
  override catalog(): readonly Problem[] {
    return this.catalogEntries();
  }
  /** Complete compatibility registry; saved events execute their persisted definitions. */
  protected catalogEntries(): readonly Problem[] {
    return [...(this.dockerProblems ? super.catalog() : []), ...this.battles, ...this.submissions];
  }
  /** Decided by kind alone, so slot allocation still works for old cloud jobs without AWS. */
  requiresGateway(definition: string): boolean {
    return definitionKind(definition) === "compose";
  }
  coordinationPlugin(problem: Problem) {
    return this.loader.load(problem.definition);
  }
  override hostPorts(
    definition: string,
    offset: number,
    runtimePorts?: import("./runtime-ports").RuntimePorts,
  ): readonly number[] {
    return definitionKind(definition) === "compose"
      ? super.hostPorts(definition, offset, runtimePorts)
      : [];
  }
  override async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.start(job, retain);
    if (kind === "cloudformation") retiredAwsJob();
    if (kind === "submission") {
      submissionDefinition(job);
      retain(JSON.stringify({ kind, eventId: job.eventId, problemId: job.problemId }));
      return;
    }
    this.loader.load(job.definition);
    retain(
      JSON.stringify({ kind: "coordination", eventId: job.eventId, problemId: job.problemId }),
    );
  }
  override async recover(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.recover(job);
    if (kind === "cloudformation") retiredAwsJob();
    if (kind === "submission") {
      submissionDefinition(job);
      return;
    }
    this.loader.load(job.definition);
  }
  override async pause(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.pause(job);
    if (kind === "cloudformation") retiredAwsJob();
  }
  override async resume(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.resume(job);
    if (kind === "cloudformation") retiredAwsJob();
    if (kind === "submission") {
      submissionDefinition(job);
      return;
    }
    this.loader.load(job.definition);
  }
  override async stop(job: Job): Promise<void> {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.stop(job);
    if (kind === "cloudformation") retiredAwsJob();
    // Shared match state and scores survive a team's stop/restart/teardown.
  }
  override surface(job: Job): string {
    const kind = definitionKind(job.definition);
    if (kind === "compose") return super.surface(job);
    if (kind === "cloudformation") retiredAwsJob();
    return noCoordinationSurface();
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
      .map((problem) => {
        const scores = context.team.scoreEvents.filter(
          (event) => event.problemId === problem.problemId && event.source === "coordination",
        );
        return coordinationProblemView(
          problem,
          scores.reduce((sum, event) => sum + event.points, 0),
          context.event.createdAt,
          scores
            .map((event) => event.occurredAt)
            .sort((left, right) => left.localeCompare(right))
            .at(-1),
        );
      });
    const submissions = context.event.problems
      .filter((problem) => kinds.get(problem.problemId) === "submission")
      .map((problem) => submissionProblemView(problem, context));
    if (context.event.problems.some((problem) => kinds.get(problem.problemId) === "cloudformation"))
      retiredAwsJob();
    return {
      ...base,
      ...(context.event.problems.every((problem) => problem.publicCatalog)
        ? { problemCatalog: context.event.problems.map((problem) => problem.publicCatalog) }
        : {}),
      problems: [...(base.problems as unknown[]), ...battles, ...submissions],
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
      return (
        event.source === "gate_bonus" ||
        kind === "coordination" ||
        kind === "cloudformation" ||
        kind === "submission"
      );
    });
    const cloudSolves = new Set(
      kept
        .filter(
          (event) =>
            ["cloudformation", "submission"].includes(kinds.get(event.problemId) ?? "") &&
            isSolve(event),
        )
        .map((event) => event.problemId),
    );
    const scoreEvents = [...result.scoreEvents, ...kept].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt),
    );
    return {
      ...result,
      score: projectedScore(context.event, scoreEvents).total,
      completedProblems: result.completedProblems + cloudSolves.size,
      scoreEvents,
    };
  }
  override async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    const kinds = problemKinds(context.event);
    if (kinds.get(String(body.problemId)) === "submission") return submitStudy(context, body);
    if (kinds.get(String(body.problemId)) === "cloudformation") retiredAwsJob();
    return this.combined(
      await super.submit(this.only(context, kinds, "compose"), body),
      context,
      kinds,
    );
  }
  override async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    const kinds = problemKinds(context.event);
    if (kinds.get(problemId) === "submission")
      throw new HostError(404, "Submission problems have no platform hints.");
    if (kinds.get(problemId) === "cloudformation") retiredAwsJob();
    return this.combined(
      await super.hint(this.only(context, kinds, "compose"), problemId, hintId),
      context,
      kinds,
    );
  }
}
