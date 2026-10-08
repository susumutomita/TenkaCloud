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
import type { ParticipantAwsAccess } from "./participant-aws-access";
import { projectedScore } from "./score";

function problemKinds(event: HostedEvent): ReadonlyMap<string, DefinitionKind> {
  return new Map(
    event.problems.map((problem) => [problem.problemId, definitionKind(problem.definition)]),
  );
}

/** Runtime dispatch only; cryptography and scoring rules belong to the catalog plugin. */
export class CompetitionEngine extends DockerHostingEngine {
  get hasAws(): boolean {
    return this.cloud !== undefined;
  }

  participantAwsAccess(args: {
    kind: ParticipantAwsAccess["kind"];
    job: Job;
    assertCurrent: () => void;
  }): Promise<ParticipantAwsAccess> {
    if (definitionKind(args.job.definition) !== "cloudformation")
      throw new HostError(409, "This environment has no AWS access.", "not_ready");
    return this.aws().participantAwsAccess(args);
  }

  private readonly battles: Problem[];
  private readonly loader: LocalPluginLoader;
  constructor(
    root: string,
    dataDirectory: string,
    /** False in a container: Docker Compose problems publish on a loopback it cannot reach. */
    private readonly dockerProblems = true,
    /** Explicit adapter seam for cloud contracts and legacy-state rehearsals; never enabled by make local. */
    private readonly cloud?: CloudFormationEngine,
    networkPool?: string,
  ) {
    super(root, dataDirectory, networkPool);
    this.battles = coordinationCatalog(root);
    this.loader = new LocalPluginLoader(dataDirectory);
  }
  disruptionAdapter() {
    return this.cloud?.disruptionAdapter();
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
        "This event contains AWS resources from an older hosting revision. They are not operated by local hosting. Keep their state and use the reviewed cloud or legacy cleanup workflow; no AWS resources were changed.",
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
      return event.source === "gate_bonus" || kind === "coordination" || kind === "cloudformation";
    });
    const cloudSolves = new Set(
      kept
        .filter((event) => kinds.get(event.problemId) === "cloudformation" && isSolve(event))
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
    if (kinds.get(String(body.problemId)) === "cloudformation")
      return this.aws().submit(context, body);
    return this.combined(
      await super.submit(this.only(context, kinds, "compose"), body),
      context,
      kinds,
    );
  }
  override async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    const kinds = problemKinds(context.event);
    if (kinds.get(problemId) === "cloudformation")
      return this.aws().hint(context, problemId, hintId);
    return this.combined(
      await super.hint(this.only(context, kinds, "compose"), problemId, hintId),
      context,
      kinds,
    );
  }
}
