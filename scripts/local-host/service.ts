import { id, issueSession, randomToken, SerialQueue } from "./auth";
import {
  type GatewayPortRange,
  gatewayPort,
  gatewaySlots,
  MAX_JOBS,
  SLOT_STRIDE,
} from "./gateway-ports";
import {
  assertPlaying,
  type Context,
  type Gate,
  gate,
  HostError,
  type HostedEvent,
  hasStarted,
  type Job,
  type JobOperation,
  object,
  type RuntimeEngine,
  scoringEnded,
  type Team,
  text,
} from "./model";
import { portsFree } from "./ports";
import { digest, type HostStore } from "./store";

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  token: string;
  nonce?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const eventPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const SLOT_QUEUE = "runtime-slots";
const NONTERMINAL_STATUSES: readonly Job["status"][] = ["PENDING", "IN_PROGRESS"];
/** Organizer-intended states of one environment that do not make a ready event undeployed. */
const INTENDED_IDLE_STATUSES: readonly Job["status"][] = ["STOPPED", "DELETED"];
const jobPattern = eventPattern;

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 2000) : fallback;
}

const NOTICE_JA =
  "> 競技モードでは、問題環境の起動・停止は主催者が行います。問題文の「起動」操作は不要です。競技中は「アクセス先 URL」の Web を開いてください。\n\n";
const NOTICE_EN =
  "> In competition mode, the organizer starts and stops your environment. Skip the problem's Start instruction and open Web under Access URLs during the event.\n\n";

function withEnglish(
  problem: Record<string, unknown>,
  edit: (english: Record<string, unknown>) => void,
): void {
  if (!problem.i18n) return;
  const english = { ...object(object(problem.i18n).en) };
  edit(english);
  problem.i18n = { en: english };
}

/** Strip organizer-only and not-yet-earned content from a scorer problem view. */
function participantProblem(
  raw: Record<string, unknown>,
  gateKind: Gate["kind"],
  ended: boolean,
): Record<string, unknown> {
  const problem = { ...raw };
  delete problem.lifecycle; // Competition environments are host-owned, never participant-resettable.
  delete problem.recommended;
  if (typeof problem.instructions === "string")
    problem.instructions = NOTICE_JA + problem.instructions;
  withEnglish(problem, (english) => {
    if (typeof english.instructions === "string")
      english.instructions = NOTICE_EN + english.instructions;
  });
  if (!ended) {
    delete problem.writeup;
    withEnglish(problem, (english) => {
      delete english.writeup;
    });
  }
  if (gateKind === "scoring_not_started") {
    problem.instructions = "";
    delete problem.i18n;
  }
  return problem;
}

/** The local adapter retains the existing admin/participant HTTP contracts. */
export class HostingService {
  private readonly queue = new SerialQueue();
  private readonly tasks = new Set<Promise<void>>();
  private readonly busyEvents = new Set<string>();
  /** jobId → eventId of single-environment operations still running. */
  private readonly busyJobs = new Map<string, string>();
  surfaceLink?: (job: Job, team: Team) => Promise<string>;
  closeSurface?: (jobId: string) => Promise<void>;
  /** Fixed exercise-gateway ports; a runtime slot is only used when its gateway port is free. */
  gatewayPorts?: GatewayPortRange;
  constructor(
    readonly store: HostStore,
    readonly engine: RuntimeEngine,
    private readonly masterKey: string,
    readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.error,
  ) {}
  private currentEvent(eventId: string): HostedEvent {
    const event = this.store.event(eventId);
    if (event.status === "READY" && event.endsAt && Date.parse(event.endsAt) <= this.now()) {
      event.status = "ENDED";
      event.updatedAt = new Date(this.now()).toISOString();
      this.store.putEvent(event);
    }
    return event;
  }
  private summary(event: HostedEvent) {
    const { problems, ...summary } = event;
    return {
      ...summary,
      teamCount: this.store.teams(event.eventId).length,
      problemCount: problems.length,
    };
  }
  private detail(event: HostedEvent, query: URLSearchParams) {
    const teams = this.store.teams(event.eventId);
    const jobs = this.store.jobs(event.eventId);
    return {
      ...this.summary(event),
      teams: teams.map((team) => ({
        teamId: team.teamId,
        internalSlug: team.internalSlug,
        displayName: team.displayName,
        ...(query.get("withTeamLoginKeys") === "true" ? { teamLoginKey: team.loginKey } : {}),
      })),
      problems: event.problems.map((problem) => ({
        problemId: problem.problemId,
        defaultRegion: "local",
      })),
      deploymentsByProblem: Object.fromEntries(
        event.problems.map((problem) => [
          problem.problemId,
          jobs
            .filter((job) => job.problemId === problem.problemId)
            .map((job) => ({
              jobId: job.jobId,
              teamId: job.teamId,
              status: job.status,
              ...(job.error ? { error: job.error } : {}),
              ...(job.operation ? { operation: job.operation } : {}),
              ...this.gatewayPortField(job),
            })),
        ]),
      ),
      ...(query.get("withScoreEvents") === "true"
        ? {
            scoreEventsByTeam: teams.map((team) => ({
              teamId: team.teamId,
              teamName: team.displayName,
              events: [...team.scoreEvents].reverse(),
            })),
          }
        : {}),
    };
  }
  /** Display-only: an out-of-range slot is reported by the gateway itself when it is opened. */
  private gatewayPortField(job: Job): { gatewayPort?: number } {
    const range = this.gatewayPorts;
    if (!range || job.status === "DELETED") return {};
    const slot = job.offset / SLOT_STRIDE;
    return Number.isInteger(slot) && slot >= 1 && slot <= gatewaySlots(range)
      ? { gatewayPort: gatewayPort(range, job.offset) }
      : {};
  }
  async admin(request: ApiRequest): Promise<ApiResponse> {
    const unauthenticated = this.adminLogin(request);
    if (unauthenticated) return unauthenticated;
    this.store.authenticateAdmin(request.token, this.now());
    const fixed = this.adminFixedRoute(request);
    if (fixed) return fixed;
    const parts = request.path.split("/").filter(Boolean).map(decodeURIComponent);
    const eventId = parts[0] === "events" ? parts[1] : undefined;
    if (!eventId || !eventPattern.test(eventId)) throw new HostError(404, "Unknown host endpoint.");
    if (parts.length === 2 && request.method === "GET")
      return ok(this.detail(this.currentEvent(eventId), request.query));
    return this.queue.run(eventId, async () =>
      this.mutateEvent(this.currentEvent(eventId), parts.slice(2), request),
    );
  }
  private adminLogin(request: ApiRequest): ApiResponse | undefined {
    if (request.path === "/host/login" && request.method === "POST") {
      return ok(issueSession(this.store, this.masterKey, object(request.body).key, this.now()));
    }
    if (request.path === "/host/logout" && request.method === "POST") {
      // A revocation handle only revokes itself and works after its access token expires.
      const body = object(request.body);
      this.store.revokeSession(text(body.refreshToken, "refreshToken", 128));
      return ok({ revoked: true });
    }
    return undefined;
  }
  private adminFixedRoute(request: ApiRequest): ApiResponse | undefined {
    if (request.path === "/host/catalog" && request.method === "GET") {
      return ok({
        items: this.engine.catalog().map((problem) => ({
          problemId: problem.problemId,
          name: problem.name,
          runtime: "docker",
        })),
      });
    }
    if (request.path === "/feature-flags" && request.method === "GET") return ok({ flags: {} });
    if (request.path === "/events" && request.method === "GET") {
      return ok({
        items: this.store.events().map((event) => this.summary(this.currentEvent(event.eventId))),
      });
    }
    if (request.path === "/events" && request.method === "POST")
      return this.createEvent(object(request.body));
    return undefined;
  }
  private createEvent(body: Record<string, unknown>): ApiResponse {
    const name = text(body.name, "name");
    if (!Array.isArray(body.teams) || body.teams.length < 1 || body.teams.length > MAX_JOBS)
      throw new HostError(400, "Choose 1–40 teams.");
    if (
      !Array.isArray(body.problems) ||
      body.problems.length < 1 ||
      body.problems.length > MAX_JOBS
    )
      throw new HostError(400, "Choose at least one supported problem.");
    const catalog = this.engine.catalog();
    const problems = body.problems.map((value) => {
      const problemId = text(object(value).problemId, "problemId");
      const problem = catalog.find((candidate) => candidate.problemId === problemId);
      if (!problem)
        throw new HostError(422, `Problem is not supported by local hosting: ${problemId}`);
      return { ...problem };
    });
    if (new Set(problems.map((problem) => problem.problemId)).size !== problems.length)
      throw new HostError(400, "Duplicate problem.");
    if (body.teams.length * problems.length > MAX_JOBS)
      throw new HostError(
        422,
        "Local hosting supports at most 40 simultaneous team/problem environments.",
      );
    const timestamp = this.now();
    const eventId = id(timestamp);
    const teams: Team[] = body.teams.map((value) => {
      const internalSlug = text(object(value).internalSlug, "internalSlug", 40);
      if (!slugPattern.test(internalSlug))
        throw new HostError(400, "Use lowercase letters, digits and hyphens for team slugs.");
      return {
        teamId: id(timestamp),
        eventId,
        internalSlug,
        displayName: internalSlug,
        loginKey: randomToken(),
        snapshot: null,
        score: 0,
        completedProblems: 0,
        scoreEvents: [],
      };
    });
    if (new Set(teams.map((team) => team.internalSlug)).size !== teams.length)
      throw new HostError(400, "Duplicate team slug.");
    const event: HostedEvent = {
      eventId,
      name,
      status: "DRAFT",
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: new Date(timestamp).toISOString(),
      expiresAt: Math.floor(timestamp / 1000) + 365 * 24 * 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems,
    };
    this.store.transaction(() => {
      this.store.putEvent(event);
      for (const team of teams) this.store.putTeam(team);
    });
    return ok(
      {
        ...this.summary(event),
        problems: problems.map((problem) => ({
          problemId: problem.problemId,
          defaultRegion: "local",
        })),
        teams: teams.map((team) => ({
          teamId: team.teamId,
          internalSlug: team.internalSlug,
          teamLoginKey: team.loginKey,
        })),
      },
      201,
    );
  }
  private async mutateEvent(
    event: HostedEvent,
    parts: string[],
    request: ApiRequest,
  ): Promise<ApiResponse> {
    if (this.busyEvents.has(event.eventId))
      throw new HostError(409, "An environment operation is already in progress.");
    const body = () => object(request.body);
    const commands: Record<string, () => ApiResponse | Promise<ApiResponse>> = {
      "POST deploy": () => this.deploy(event, body()),
      "DELETE ": () => this.teardown(event),
      "PATCH schedule": () => this.schedule(event, body()),
      "POST end": () => this.end(event),
      "POST lock-scoring": () => this.lockScoring(event, true),
      "DELETE lock-scoring": () => this.lockScoring(event, false),
      "POST archive": () => this.archive(event),
      "POST notifications": () => this.notify(event, body()),
    };
    const command = commands[`${request.method} ${parts.join("/")}`];
    if (command) return command();
    if (
      parts.length === 3 &&
      parts[0] === "teams" &&
      parts[2] === "rotate-login-key" &&
      request.method === "POST"
    )
      return this.rotateTeamKey(event, parts[1] ?? "");
    const operation = jobOperation(parts, request.method);
    if (operation) return this.operateJob(event, parts[1] ?? "", operation);
    throw new HostError(404, "This operation is not available in local hosting.");
  }
  private eventHasBusyJob(eventId: string): boolean {
    return [...this.busyJobs.values()].includes(eventId);
  }
  /** Stop, restart or tear down exactly one team/problem environment of this event. */
  private operateJob(event: HostedEvent, jobId: string, operation: JobOperation): ApiResponse {
    if (!jobPattern.test(jobId)) throw new HostError(404, "Deployment not found in this event.");
    const job = this.store.job(jobId);
    // The job identifier is not a capability: it must belong to the event in the path.
    if (job.eventId !== event.eventId)
      throw new HostError(404, "Deployment not found in this event.");
    if (this.busyJobs.has(jobId) || job.operation)
      throw new HostError(409, "An operation on this environment is already in progress.");
    assertJobOperation(event, job, operation);
    job.operation = operation;
    this.store.putJob(job);
    this.busyJobs.set(jobId, event.eventId);
    this.track(
      this.runJobOperation(jobId, operation).finally(() => this.busyJobs.delete(jobId)),
      event.eventId,
    );
    return ok({ eventId: event.eventId, jobId, operation }, 202);
  }
  private async runJobOperation(jobId: string, operation: JobOperation): Promise<void> {
    const job = this.store.job(jobId);
    if (operation === "restart" && (job.status === "FAILED" || job.status === "DELETED")) {
      job.operation = undefined;
      this.store.putJob(job);
      // A missing or failed environment is rebuilt exactly like a deployment retry.
      await this.startJob(jobId);
    } else {
      try {
        await this.closeSurface?.(job.jobId);
        if (operation === "stop") {
          await this.engine.pause(job);
          job.status = "STOPPED";
        } else if (operation === "restart") {
          job.status = "IN_PROGRESS";
          this.store.putJob(job);
          await this.engine.resume(job);
          job.status = "COMPLETE";
        } else {
          job.status = "DELETING";
          this.store.putJob(job);
          if (job.unit) await this.engine.stop(job);
          job.unit = null;
          job.status = "DELETED";
        }
        job.error = undefined;
      } catch (error) {
        job.status = "FAILED";
        job.error = failureMessage(error, "Environment operation failed; ownership retained.");
      }
      job.operation = undefined;
      this.store.putJob(job);
    }
    this.promoteIfDeployed(job.eventId);
  }
  /** A deploying event becomes ready once every one of its environments is running. */
  private promoteIfDeployed(eventId: string): void {
    const event = this.store.event(eventId);
    if (event.status !== "DEPLOYING") return;
    if (this.store.jobs(eventId).every((job) => job.status === "COMPLETE")) {
      event.status = "READY";
      this.saveEvent(event);
    }
  }
  private saveEvent(event: HostedEvent): void {
    event.updatedAt = new Date(this.now()).toISOString();
    this.store.putEvent(event);
  }
  private end(event: HostedEvent): ApiResponse {
    if (event.status !== "READY") throw new HostError(409, "Only a ready event can end.");
    event.status = "ENDED";
    event.endsAt = new Date(this.now()).toISOString();
    this.saveEvent(event);
    return ok({
      endsAt: event.endsAt,
      updatedDeployments: this.store.jobs(event.eventId).length,
    });
  }
  private lockScoring(event: HostedEvent, locked: boolean): ApiResponse {
    if (!["READY", "ENDED"].includes(event.status))
      throw new HostError(409, "Event is not lockable.");
    event.scoringLocked = locked;
    event.scoringLockedAt = locked ? new Date(this.now()).toISOString() : undefined;
    this.saveEvent(event);
    return ok({ scoringLocked: event.scoringLocked, scoringLockedAt: event.scoringLockedAt });
  }
  private archive(event: HostedEvent): ApiResponse {
    if (!["DRAFT", "ENDED", "TEARDOWN"].includes(event.status))
      throw new HostError(409, "Event is not archivable.");
    if (this.store.jobs(event.eventId).some((job) => job.unit))
      throw new HostError(409, "Tear down all environments before archiving.");
    event.status = "ARCHIVED";
    this.saveEvent(event);
    return ok({ archivedAt: event.updatedAt });
  }
  private notify(event: HostedEvent, body: Record<string, unknown>): ApiResponse {
    const severity = body.severity ?? "info";
    if (severity !== "info" && severity !== "warning")
      throw new HostError(400, "Invalid notification severity.");
    const notificationId = id(this.now());
    const occurredAt = new Date(this.now()).toISOString();
    this.store.notify(event.eventId, notificationId, {
      notificationId,
      occurredAt,
      title: text(body.title, "title"),
      body: text(body.body, "body", 2000),
      severity,
    });
    return ok({ notificationId, occurredAt });
  }
  private rotateTeamKey(event: HostedEvent, teamId: string): ApiResponse {
    const team = this.store.team(teamId);
    if (team.eventId !== event.eventId) throw new HostError(404, "Team not found in this event.");
    team.loginKey = randomToken();
    this.store.putTeam(team);
    return ok({
      kind: "ok",
      teamId: team.teamId,
      teamLoginKey: team.loginKey,
      rotatedAt: new Date(this.now()).toISOString(),
    });
  }
  private schedule(event: HostedEvent, body: Record<string, unknown>): ApiResponse {
    if (event.status !== "READY")
      throw new HostError(409, "Deploy the event before scheduling it.");
    if (
      Object.keys(body).some(
        (key) => !["startNow", "startsAt", "endsAt", "scoreboardFreezeMinutes"].includes(key),
      )
    )
      throw new HostError(422, "Automatic deploy/teardown schedules are not supported locally.");
    if (body.startNow !== undefined && body.startNow !== true)
      throw new HostError(400, "startNow must be true.");
    if (body.startNow && body.startsAt !== undefined)
      throw new HostError(400, "Choose startNow or startsAt, not both.");
    const parseTime = (value: unknown): string => {
      const input = text(value, "timestamp", 40);
      const milliseconds = Date.parse(input);
      if (
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(input) ||
        !Number.isFinite(milliseconds)
      )
        throw new HostError(400, "An ISO timestamp with a timezone is required.");
      return new Date(milliseconds).toISOString();
    };
    if (body.startNow) event.startsAt = new Date(this.now()).toISOString();
    if (body.startsAt !== undefined) event.startsAt = parseTime(body.startsAt);
    if (body.endsAt !== undefined) event.endsAt = parseTime(body.endsAt);
    if (event.startsAt && event.endsAt && Date.parse(event.endsAt) <= Date.parse(event.startsAt))
      throw new HostError(400, "The end must be after the start.");
    if (body.scoreboardFreezeMinutes !== undefined) {
      const minutes = body.scoreboardFreezeMinutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 180)
        throw new HostError(400, "Freeze minutes must be an integer from 0 to 180.");
      event.scoreboardFreezeMinutes = minutes;
    }
    this.saveEvent(event);
    return ok({
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      updatedDeployments: this.store.jobs(event.eventId).length,
    });
  }
  /**
   * Never-started teardown recovery: an end time already in the past would end the re-prepared
   * event the moment it started.
   */
  private clearPastEnd(event: HostedEvent): void {
    if (event.endsAt && Date.parse(event.endsAt) <= this.now()) event.endsAt = undefined;
  }
  /** Every host port a slot needs: the problem's published ports and its exercise gateway. */
  private slotPorts(definition: string, offset: number): readonly number[] {
    const ports = [...(this.engine.hostPorts?.(definition, offset) ?? [])];
    if (this.gatewayPorts) ports.push(gatewayPort(this.gatewayPorts, offset));
    return ports;
  }
  /** Offsets recorded for live jobs in this database, optionally ignoring one job. */
  private recordedOffsets(except?: string): Set<number> {
    return new Set(
      this.store
        .jobs()
        .filter((job) => job.status !== "DELETED" && job.jobId !== except)
        .map((job) => job.offset),
    );
  }
  /**
   * The lowest free port block whose host ports are actually unbound. SQLite only knows this
   * host's own jobs; an unrelated process, another data directory's containers or a lazily
   * allocated exercise gateway can hold a block that no recorded job owns.
   */
  private async freeSlot(definition: string, occupied: Set<number>): Promise<number> {
    const slots = this.gatewayPorts ? gatewaySlots(this.gatewayPorts) : MAX_JOBS;
    for (let index = 1; index <= slots; index += 1) {
      const offset = index * SLOT_STRIDE;
      if (occupied.has(offset)) continue;
      if (await portsFree(this.slotPorts(definition, offset))) {
        occupied.add(offset);
        return offset;
      }
    }
    throw new HostError(
      422,
      "No free runtime port blocks. Tear down another event or stop the processes holding the local ports.",
    );
  }
  private async deploy(event: HostedEvent, body: Record<string, unknown>): Promise<ApiResponse> {
    // A torn-down event that never started (for example after a failed first deployment) can
    // be prepared again; an event that already ran is final and needs a new event instead.
    const redeployable = event.status === "TEARDOWN" && !event.startsAt;
    if (!["DRAFT", "DEPLOYING"].includes(event.status) && !redeployable)
      throw new HostError(
        409,
        event.status === "TEARDOWN"
          ? "This event already ran and was torn down. Create a new event to host again."
          : "This event has already been deployed.",
      );
    if (this.eventHasBusyJob(event.eventId))
      throw new HostError(409, "A team environment operation is still in progress.");
    if (
      Object.keys(body).some((key) => key !== "retryFailedOnly") ||
      (body.retryFailedOnly !== undefined && body.retryFailedOnly !== true)
    )
      throw new HostError(
        422,
        "Only full deployment or failed-environment retry is supported locally.",
      );
    const teams = this.store.teams(event.eventId);
    const existing = this.store.jobs(event.eventId);
    // Slot allocation reads every event's jobs, so serialize it across events too.
    const targets = await this.queue.run(SLOT_QUEUE, async () => {
      const occupied = this.recordedOffsets();
      const planned: Job[] = [];
      for (const team of teams)
        for (const problem of event.problems) {
          const previous = existing.find(
            (job) => job.teamId === team.teamId && job.problemId === problem.problemId,
          );
          if (previous?.status === "COMPLETE") continue;
          if (previous) {
            planned.push(previous);
            continue;
          }
          planned.push({
            jobId: id(this.now()),
            eventId: event.eventId,
            teamId: team.teamId,
            problemId: problem.problemId,
            definition: problem.definition,
            offset: await this.freeSlot(problem.definition, occupied),
            status: "PENDING",
            unit: null,
          });
        }
      if (redeployable) this.clearPastEnd(event);
      event.status = "DEPLOYING";
      this.store.transaction(() => {
        this.saveEvent(event);
        for (const job of planned) this.store.putJob(job);
      });
      return planned;
    });
    this.launch(event.eventId, async () => {
      for (const original of targets) await this.startJob(original.jobId);
      const latest = this.store.event(event.eventId);
      if (this.store.jobs(event.eventId).every((job) => job.status === "COMPLETE"))
        latest.status = "READY";
      this.saveEvent(latest);
    });
    return ok(
      {
        eventId: event.eventId,
        enqueued: targets.length,
        skipped:
          existing.length -
          targets.filter((job) => existing.some((prior) => prior.jobId === job.jobId)).length,
      },
      202,
    );
  }
  private async startJob(jobId: string): Promise<void> {
    const job = this.store.job(jobId);
    try {
      if (job.unit) {
        await this.closeSurface?.(job.jobId);
        await this.engine.stop(job);
        job.unit = null;
        this.store.putJob(job);
      }
      // A retry keeps its block unless something else took the ports in the meantime, or a
      // removed environment's block was recorded for another environment since.
      if (
        !(await portsFree(this.slotPorts(job.definition, job.offset))) ||
        this.recordedOffsets(job.jobId).has(job.offset)
      ) {
        job.offset = await this.queue.run(SLOT_QUEUE, () =>
          this.freeSlot(job.definition, this.recordedOffsets(job.jobId)),
        );
      }
      job.status = "IN_PROGRESS";
      job.error = undefined;
      this.store.putJob(job);
      await this.engine.start(job, (unit) => {
        job.unit = unit;
        this.store.putJob(job);
      });
      job.status = "COMPLETE";
    } catch (error) {
      job.status = "FAILED";
      job.error = failureMessage(error, "Runtime failed.");
    }
    this.store.putJob(job);
  }
  private teardown(event: HostedEvent): ApiResponse {
    if (this.eventHasBusyJob(event.eventId))
      throw new HostError(409, "A team environment operation is still in progress.");
    event.status = "TEARDOWN";
    // Only an event that ran gets a final end time; a never-started event stays re-deployable.
    if (event.startsAt) event.endsAt ??= new Date(this.now()).toISOString();
    this.saveEvent(event);
    const jobs = this.store.jobs(event.eventId);
    this.launch(event.eventId, async () => {
      for (const job of jobs) {
        if (job.status === "DELETED") continue;
        job.status = "DELETING";
        this.store.putJob(job);
        try {
          await this.closeSurface?.(job.jobId);
          if (job.unit) await this.engine.stop(job);
          job.unit = null;
          job.error = undefined;
          job.status = "DELETED";
        } catch (error) {
          job.status = "FAILED";
          job.error = failureMessage(error, "Cleanup failed; ownership retained.");
        }
        this.store.putJob(job);
      }
    });
    return ok(
      {
        eventId: event.eventId,
        enqueued: jobs.filter((job) => job.status !== "DELETED").length,
        skipped: jobs.filter((job) => job.status === "DELETED").length,
      },
      202,
    );
  }
  private launch(eventId: string, operation: () => Promise<void>): void {
    this.busyEvents.add(eventId);
    this.track(
      Promise.resolve()
        .then(operation)
        .finally(() => this.busyEvents.delete(eventId)),
      eventId,
    );
  }
  /** Background work is logged when it fails and awaited by `drain()` before shutdown. */
  private track(work: Promise<void>, eventId: string): void {
    const task: Promise<void> = work
      .catch((error: unknown) => {
        this.log(
          `Local-host operation failed for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }
  async drain(): Promise<void> {
    await Promise.all([...this.tasks]);
  }
  /**
   * Re-adopt recorded runtimes before the listeners open. Jobs recover concurrently: each
   * unreachable environment costs one readiness timeout, not one per job, so an outage
   * affecting every environment delays the consoles by minutes rather than the better part
   * of an hour.
   */
  async recover(): Promise<void> {
    await Promise.all(this.store.jobs().map((job) => this.recoverJob(job)));
    for (const event of this.store.events()) {
      if (!["DEPLOYING", "READY"].includes(event.status)) continue;
      const jobs = this.store.jobs(event.eventId);
      // A ready event keeps running when the organizer deliberately stopped or removed one
      // team's environment; only an environment that was lost makes it deployable again.
      const recovered =
        jobs.length === event.problems.length * this.store.teams(event.eventId).length &&
        jobs.every(
          (job) =>
            job.status === "COMPLETE" ||
            (event.status === "READY" && INTENDED_IDLE_STATUSES.includes(job.status)),
        );
      event.status = recovered ? "READY" : "DEPLOYING";
      this.saveEvent(event);
    }
  }
  private async recoverJob(job: Job): Promise<void> {
    // An operation interrupted by a shutdown is settled by the recovery below.
    if (job.operation) {
      job.operation = undefined;
      this.store.putJob(job);
    }
    // A stopped environment keeps its containers and ownership until it is restarted.
    if (job.status === "DELETED" || (job.status === "STOPPED" && job.unit)) return;
    if (!job.unit) {
      if (!NONTERMINAL_STATUSES.includes(job.status)) return;
      job.status = "FAILED";
      job.error =
        "Startup was interrupted before runtime ownership was acquired. Retry deployment.";
      this.store.putJob(job);
      return;
    }
    try {
      if (job.status === "DELETING") {
        await this.engine.stop(job);
        job.status = "DELETED";
        job.unit = null;
      } else {
        await this.engine.recover(job);
        job.status = "COMPLETE";
        job.error = undefined;
      }
    } catch (error) {
      job.status = "FAILED";
      job.error = failureMessage(error, "Runtime recovery failed.");
    }
    this.store.putJob(job);
  }
  private context(team: Team): Context {
    return {
      event: this.currentEvent(team.eventId),
      team,
      jobs: this.store.jobs(team.eventId, team.teamId),
      now: this.now(),
    };
  }
  async participant(request: ApiRequest): Promise<ApiResponse> {
    const team = this.store.authenticateTeam(request.token);
    const context = this.context(team);
    if (request.method === "GET") return this.participantRead(context, request.path);
    if (request.method === "PATCH" && request.path === "/portal/me") {
      return this.queue.run(team.eventId, async () => {
        const latest = this.store.authenticateTeam(request.token);
        latest.displayName = text(object(request.body).teamName, "teamName", 80);
        this.store.putTeam(latest);
        return ok(await this.teamView(this.context(latest)));
      });
    }
    if (request.method !== "POST") throw new HostError(404, "Unknown participant endpoint.");
    const hintMatch = /^\/portal\/me\/problems\/([^/]+)\/hints\/([^/]+)\/reveal$/u.exec(
      request.path,
    );
    if (request.path !== "/portal/me/submit-flag" && !hintMatch)
      throw new HostError(
        404,
        "Participants cannot deploy, reset or stop competition environments.",
      );
    const body = hintMatch ? {} : object(request.body);
    if (
      !hintMatch &&
      (typeof body.flag !== "string" ||
        body.flag.length > 16_384 ||
        typeof body.problemId !== "string")
    )
      throw new HostError(400, "Invalid flag submission.");
    if ("teamId" in body || "eventId" in body)
      throw new HostError(
        400,
        "Team and event identity come from authentication, not the request body.",
      );
    const action = hintMatch
      ? {
          problemId: decodeURIComponent(hintMatch[1] ?? ""),
          hintId: decodeURIComponent(hintMatch[2] ?? ""),
        }
      : { problemId: String(body.problemId) };
    return this.queue.run(team.eventId, () => this.score(request, body, action));
  }
  /** Runs inside the event's serial queue: one submission or hint reveal, awarded at most once. */
  private async score(
    request: ApiRequest,
    body: Record<string, unknown>,
    action: { problemId: string; hintId?: string },
  ): Promise<ApiResponse> {
    const fresh = this.store.authenticateTeam(request.token);
    const current = this.context(fresh);
    const fingerprint = digest(JSON.stringify({ path: request.path, body }));
    if (request.nonce) {
      if (!/^[A-Za-z0-9_-]{8,128}$/u.test(request.nonce))
        throw new HostError(400, "Invalid Idempotency-Key.");
      const receipt = this.store.receipt(fresh.teamId, request.nonce, fingerprint);
      if (receipt) return receipt;
    }
    assertPlaying(current.event, this.now());
    const deployed = current.jobs.some(
      (job) => job.problemId === action.problemId && job.status === "COMPLETE",
    );
    if (!deployed) throw new HostError(409, "This team's problem environment is not running.");
    const result =
      action.hintId === undefined
        ? await this.engine.submit(current, body)
        : await this.engine.hint(current, action.problemId, action.hintId);
    if (result.status >= 400) return ok(result.body, result.status);
    // A verifier finishing after the server deadline must not award points. The
    // engine works on a disposable snapshot, so rejecting here discards its mutation.
    assertPlaying(this.currentEvent(fresh.eventId), this.now());
    this.store.transaction(() => {
      this.store.putTeam({
        ...fresh,
        snapshot: result.snapshot,
        score: result.score,
        completedProblems: result.completedProblems,
        scoreEvents: result.scoreEvents,
      });
      if (request.nonce)
        this.store.putReceipt(fresh.teamId, request.nonce, fingerprint, result.status, result.body);
    });
    return ok(result.body, result.status);
  }
  private async participantRead(context: Context, path: string): Promise<ApiResponse> {
    switch (path) {
      case "/portal/me":
        return ok(await this.teamView(context));
      case "/portal/me/score-events":
        // Newest first, like the cloud endpoint.
        return ok({ entries: context.team.scoreEvents.slice(0, 100) });
      case "/portal/me/notifications":
        return ok({
          eventId: context.event.eventId,
          items: this.store.notifications(context.event.eventId),
        });
      case "/portal/me/deploy-logs":
        return ok({ entries: [], cursor: "" });
      case "/portal/leaderboard":
        return ok(this.leaderboard(context));
      case "/portal/leaderboard/score-events":
        return ok(this.leaderboardScoreEvents(context));
      default:
        throw new HostError(404, "Unknown participant endpoint.");
    }
  }
  /** Oldest first per team, teams by cumulative score: the shape the timeline chart consumes. */
  private leaderboardScoreEvents(context: Context) {
    const cutoff = this.freezeCutoff(context.event);
    const teams = this.store.teams(context.event.eventId).map((team) => {
      const events = [...team.scoreEvents]
        .reverse()
        .filter((event) => cutoff === null || Date.parse(event.occurredAt) < cutoff);
      return {
        teamId: team.teamId,
        teamName: team.displayName,
        isMyTeam: team.teamId === context.team.teamId,
        events,
        total: events.reduce((sum, event) => sum + event.points, 0),
      };
    });
    teams.sort(
      (left, right) => right.total - left.total || left.teamName.localeCompare(right.teamName),
    );
    return {
      eventId: context.event.eventId,
      teams: teams.map(({ total: _total, ...team }) => team),
    };
  }
  private freezeCutoff(event: HostedEvent): number | null {
    // Ending, teardown and archival all publish the final board; only a live freeze window hides it.
    if (!event.endsAt || event.scoreboardFreezeMinutes === 0 || scoringEnded(event)) return null;
    const cutoff = Date.parse(event.endsAt) - event.scoreboardFreezeMinutes * 60_000;
    return this.now() >= cutoff ? cutoff : null;
  }
  private leaderboard(context: Context) {
    const cutoff = this.freezeCutoff(context.event);
    const entries = this.store
      .teams(context.event.eventId)
      .map((team) => {
        const historical = team.scoreEvents.filter(
          (event) => cutoff !== null && Date.parse(event.occurredAt) < cutoff,
        );
        return {
          teamId: team.teamId,
          teamName: team.displayName,
          score:
            cutoff === null ? team.score : historical.reduce((sum, event) => sum + event.points, 0),
          completedProblems:
            cutoff === null
              ? team.completedProblems
              : new Set(
                  historical
                    .filter((event) => event.source === "flag" && event.result === "ok")
                    .map((event) => event.problemId),
                ).size,
          totalProblems: context.event.problems.length,
          isMyTeam: team.teamId === context.team.teamId,
        };
      })
      .sort((left, right) => right.score - left.score || left.teamId.localeCompare(right.teamId));
    let rank = 1;
    return {
      eventId: context.event.eventId,
      scoreboardFrozen: cutoff !== null,
      // The portal's countdown, freeze-end timestamp and final/live result labels read this.
      ...(context.event.endsAt ? { endsAt: context.event.endsAt } : {}),
      entries: entries.map((entry, index) => {
        if (index > 0 && entry.score !== entries[index - 1]?.score) rank = index + 1;
        return { ...entry, rank };
      }),
    };
  }
  private async teamView(context: Context): Promise<Record<string, unknown>> {
    const result = await this.engine.view(context);
    const eventGate = gate(context.event, context.now);
    // A canceled or never-started event has nothing to reveal: writeups need a real start.
    const ended = eventGate.kind === "scoring_ended" && hasStarted(context.event, context.now);
    const problems = Array.isArray(result.problems) ? result.problems : [];
    const safeProblems = await Promise.all(
      problems.map(async (raw) => {
        const problem = participantProblem(object(raw), eventGate.kind, ended);
        const job = context.jobs.find((candidate) => candidate.problemId === problem.problemId);
        problem.provider = "docker";
        problem.jobId = job?.jobId ?? problem.jobId;
        problem.eventStartsAt = context.event.startsAt;
        problem.eventEndsAt = context.event.endsAt;
        problem.expiresAt = context.event.expiresAt;
        // The participant contract has no organizer-stop state; "DELETED" renders as stopped.
        problem.status = job?.status === "STOPPED" ? "DELETED" : (job?.status ?? "PENDING");
        problem.stackOutputs =
          job?.status === "COMPLETE" && eventGate.kind === "ok" && this.surfaceLink
            ? { Web: await this.surfaceLink(job, context.team) }
            : {};
        return problem;
      }),
    );
    return {
      ...result,
      team: {
        teamId: context.team.teamId,
        eventId: context.event.eventId,
        teamName: context.team.displayName,
        teamNameSetByCompetitor: true,
      },
      problems: safeProblems,
      eventGate,
    };
  }
  authorizeSurface(jobId: string, keyHash: string): Job {
    const job = this.store.job(jobId);
    const team = this.store.team(job.teamId);
    if (digest(team.loginKey) !== keyHash) throw new HostError(401, "Team access was revoked.");
    assertPlaying(this.currentEvent(job.eventId), this.now());
    if (job.status !== "COMPLETE") throw new HostError(409, "Environment is not running.");
    return job;
  }
}

/** `deployments/<jobId>/stop|restart` (POST) and `deployments/<jobId>` (DELETE). */
function jobOperation(parts: readonly string[], method: string): JobOperation | undefined {
  if (parts[0] !== "deployments") return undefined;
  if (parts.length === 2 && method === "DELETE") return "teardown";
  if (parts.length === 3 && method === "POST" && parts[2] === "stop") return "stop";
  if (parts.length === 3 && method === "POST" && parts[2] === "restart") return "restart";
  return undefined;
}

/** Explicit, explained refusals: the host console disables the same combinations. */
function assertJobOperation(event: HostedEvent, job: Job, operation: JobOperation): void {
  if (operation === "teardown") {
    if (event.status === "ARCHIVED")
      throw new HostError(409, "An archived event has no environments to remove.");
    if (job.status === "DELETED")
      throw new HostError(409, "This environment has already been removed.");
    return;
  }
  if (operation === "stop") {
    if (!["DEPLOYING", "READY", "ENDED"].includes(event.status))
      throw new HostError(409, "Environments of this event can no longer be stopped.");
    if (job.status !== "COMPLETE")
      throw new HostError(409, "Only a running environment can be stopped.");
    return;
  }
  if (!["DEPLOYING", "READY"].includes(event.status))
    throw new HostError(
      409,
      "Environments can be restarted only while the event is being prepared or is ready.",
    );
  if (!["COMPLETE", "STOPPED", "FAILED", "DELETED"].includes(job.status))
    throw new HostError(409, "This environment is still changing; wait for it to settle.");
}
