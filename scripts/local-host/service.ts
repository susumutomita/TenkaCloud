import { id, issueSession, SerialQueue, secret } from "./auth";
import {
  assertPlaying,
  type Context,
  gate,
  HostError,
  type HostedEvent,
  type Job,
  object,
  type RuntimeEngine,
  type Team,
  text,
} from "./model";
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
const MAX_JOBS = 40;
/** The local adapter retains the existing admin/participant HTTP contracts. */
export class HostingService {
  private readonly queue = new SerialQueue();
  private readonly tasks = new Set<Promise<void>>();
  private readonly busyEvents = new Set<string>();
  surfaceLink?: (job: Job, team: Team) => Promise<string>;
  closeSurface?: (jobId: string) => Promise<void>;
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
  async admin(request: ApiRequest): Promise<ApiResponse> {
    if (request.path === "/host/login" && request.method === "POST") {
      return ok(issueSession(this.store, this.masterKey, object(request.body).key, this.now()));
    }
    if (request.path === "/host/logout" && request.method === "POST") {
      // A revocation handle only revokes itself and works after its access token expires.
      const body = object(request.body);
      this.store.revokeSession(text(body.refreshToken, "refreshToken", 128));
      return ok({ revoked: true });
    }
    this.store.authenticateAdmin(request.token, this.now());
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
    if (request.path === "/events") {
      if (request.method === "GET")
        return ok({
          items: this.store.events().map((event) => this.summary(this.currentEvent(event.eventId))),
        });
      if (request.method === "POST") return this.createEvent(object(request.body));
    }
    const parts = request.path.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "events" || !parts[1] || !eventPattern.test(parts[1]))
      throw new HostError(404, "Unknown host endpoint.");
    const eventId = parts[1];
    if (parts.length === 2 && request.method === "GET")
      return ok(this.detail(this.currentEvent(eventId), request.query));
    return this.queue.run(eventId, async () =>
      this.mutateEvent(this.currentEvent(eventId), parts.slice(2), request),
    );
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
        loginKey: secret(),
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
    const command = parts.join("/");
    if (this.busyEvents.has(event.eventId))
      throw new HostError(409, "An environment operation is already in progress.");
    if (request.method === "POST" && command === "deploy")
      return this.deploy(event, object(request.body));
    if (request.method === "DELETE" && command === "") return this.teardown(event);
    if (request.method === "PATCH" && command === "schedule")
      return this.schedule(event, object(request.body));
    if (request.method === "POST" && command === "end") {
      if (event.status !== "READY") throw new HostError(409, "Only a ready event can end.");
      event.status = "ENDED";
      event.endsAt = new Date(this.now()).toISOString();
      this.saveEvent(event);
      return ok({
        endsAt: event.endsAt,
        updatedDeployments: this.store.jobs(event.eventId).length,
      });
    }
    if (command === "lock-scoring" && ["POST", "DELETE"].includes(request.method)) {
      if (!["READY", "ENDED"].includes(event.status))
        throw new HostError(409, "Event is not lockable.");
      event.scoringLocked = request.method === "POST";
      event.scoringLockedAt = event.scoringLocked ? new Date(this.now()).toISOString() : undefined;
      this.saveEvent(event);
      return ok({ scoringLocked: event.scoringLocked, scoringLockedAt: event.scoringLockedAt });
    }
    if (command === "archive" && request.method === "POST") {
      if (!["DRAFT", "ENDED", "TEARDOWN"].includes(event.status))
        throw new HostError(409, "Event is not archivable.");
      if (this.store.jobs(event.eventId).some((job) => job.unit))
        throw new HostError(409, "Tear down all environments before archiving.");
      event.status = "ARCHIVED";
      this.saveEvent(event);
      return ok({ archivedAt: event.updatedAt });
    }
    if (command === "notifications" && request.method === "POST") {
      const body = object(request.body);
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
    if (
      parts.length === 3 &&
      parts[0] === "teams" &&
      parts[2] === "rotate-login-key" &&
      request.method === "POST"
    ) {
      const team = this.store.team(parts[1] ?? "");
      if (team.eventId !== event.eventId) throw new HostError(404, "Team not found in this event.");
      team.loginKey = secret();
      this.store.putTeam(team);
      return ok({
        kind: "ok",
        teamId: team.teamId,
        teamLoginKey: team.loginKey,
        rotatedAt: new Date(this.now()).toISOString(),
      });
    }
    throw new HostError(404, "This operation is not available in local hosting.");
  }
  private saveEvent(event: HostedEvent): void {
    event.updatedAt = new Date(this.now()).toISOString();
    this.store.putEvent(event);
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
  private deploy(event: HostedEvent, body: Record<string, unknown>): ApiResponse {
    if (!["DRAFT", "DEPLOYING"].includes(event.status))
      throw new HostError(409, "This event has already been deployed.");
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
    const occupied = new Set(
      this.store
        .jobs()
        .filter((job) => job.status !== "DELETED")
        .map((job) => job.offset),
    );
    const targets: Job[] = [];
    for (const team of teams)
      for (const problem of event.problems) {
        const previous = existing.find(
          (job) => job.teamId === team.teamId && job.problemId === problem.problemId,
        );
        if (previous?.status === "COMPLETE") continue;
        if (previous) {
          targets.push(previous);
          continue;
        }
        const slot = Array.from({ length: MAX_JOBS }, (_, index) => (index + 1) * 1000).find(
          (offset) => !occupied.has(offset),
        );
        if (slot === undefined)
          throw new HostError(422, "No free runtime slots. Tear down another event first.");
        occupied.add(slot);
        targets.push({
          jobId: id(this.now()),
          eventId: event.eventId,
          teamId: team.teamId,
          problemId: problem.problemId,
          definition: problem.definition,
          offset: slot,
          status: "PENDING",
          unit: null,
        });
      }
    event.status = "DEPLOYING";
    this.store.transaction(() => {
      this.saveEvent(event);
      for (const job of targets) this.store.putJob(job);
    });
    this.launch(event.eventId, async () => {
      for (const original of targets) {
        const job = this.store.job(original.jobId);
        try {
          if (job.unit) {
            await this.closeSurface?.(job.jobId);
            await this.engine.stop(job);
            job.unit = null;
            this.store.putJob(job);
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
          job.error = error instanceof Error ? error.message.slice(0, 2000) : "Runtime failed.";
        }
        this.store.putJob(job);
      }
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
  private teardown(event: HostedEvent): ApiResponse {
    event.status = "TEARDOWN";
    event.endsAt ??= new Date(this.now()).toISOString();
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
          job.error =
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "Cleanup failed; ownership retained.";
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
    const task = Promise.resolve()
      .then(operation)
      .catch((error) => {
        this.log(
          `Local-host operation failed for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.tasks.delete(task);
        this.busyEvents.delete(eventId);
      });
    this.tasks.add(task);
  }
  async drain(): Promise<void> {
    await Promise.all([...this.tasks]);
  }
  async recover(): Promise<void> {
    for (const job of this.store.jobs()) {
      if (job.status === "DELETED") continue;
      if (!job.unit) {
        if (["PENDING", "IN_PROGRESS"].includes(job.status)) {
          job.status = "FAILED";
          job.error =
            "Startup was interrupted before runtime ownership was acquired. Retry deployment.";
          this.store.putJob(job);
        }
        continue;
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
        job.error =
          error instanceof Error ? error.message.slice(0, 2000) : "Runtime recovery failed.";
      }
      this.store.putJob(job);
    }
    for (const event of this.store.events()) {
      const jobs = this.store.jobs(event.eventId);
      if (["DEPLOYING", "READY"].includes(event.status)) {
        const recovered =
          jobs.length === event.problems.length * this.store.teams(event.eventId).length &&
          jobs.every((job) => job.status === "COMPLETE");
        event.status = recovered ? "READY" : "DEPLOYING";
        this.saveEvent(event);
      }
    }
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
    return this.queue.run(team.eventId, async () => {
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
      const problemId = hintMatch ? decodeURIComponent(hintMatch[1] ?? "") : String(body.problemId);
      if (!current.jobs.some((job) => job.problemId === problemId && job.status === "COMPLETE"))
        throw new HostError(409, "This team's problem environment is not running.");
      const result = hintMatch
        ? await this.engine.hint(current, problemId, decodeURIComponent(hintMatch[2] ?? ""))
        : await this.engine.submit(current, body);
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
          this.store.putReceipt(
            fresh.teamId,
            request.nonce,
            fingerprint,
            result.status,
            result.body,
          );
      });
      return ok(result.body, result.status);
    });
  }
  private async participantRead(context: Context, path: string): Promise<ApiResponse> {
    switch (path) {
      case "/portal/me":
        return ok(await this.teamView(context));
      case "/portal/me/score-events":
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
      case "/portal/leaderboard/score-events": {
        const cutoff = this.freezeCutoff(context.event);
        return ok({
          eventId: context.event.eventId,
          teams: this.store.teams(context.event.eventId).map((team) => ({
            teamId: team.teamId,
            teamName: team.displayName,
            isMyTeam: team.teamId === context.team.teamId,
            events: team.scoreEvents.filter(
              (event) => cutoff === null || Date.parse(event.occurredAt) < cutoff,
            ),
          })),
        });
      }
      default:
        throw new HostError(404, "Unknown participant endpoint.");
    }
  }
  private freezeCutoff(event: HostedEvent): number | null {
    if (!event.endsAt || event.scoreboardFreezeMinutes === 0 || event.status === "ENDED")
      return null;
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
      entries: entries.map((entry, index) => {
        if (index > 0 && entry.score !== entries[index - 1]?.score) rank = index + 1;
        return { ...entry, rank };
      }),
    };
  }
  private async teamView(context: Context): Promise<Record<string, unknown>> {
    const result = await this.engine.view(context);
    const eventGate = gate(context.event, context.now);
    const ended = eventGate.kind === "scoring_ended";
    const problems = Array.isArray(result.problems) ? result.problems : [];
    const safeProblems = await Promise.all(
      problems.map(async (raw) => {
        const problem = { ...object(raw) };
        const job = context.jobs.find((candidate) => candidate.problemId === problem.problemId);
        delete problem.lifecycle; // Competition environments are host-owned, never participant-resettable.
        delete problem.recommended;
        const notice =
          "> 競技モードでは、問題環境の起動・停止は主催者が行います。問題文の「起動」操作は不要です。競技中は「アクセス先 URL」の Web を開いてください。\n\n";
        if (typeof problem.instructions === "string")
          problem.instructions = notice + problem.instructions;
        if (problem.i18n) {
          const english = { ...object(object(problem.i18n).en) };
          if (typeof english.instructions === "string") {
            english.instructions =
              "> In competition mode, the organizer starts and stops your environment. Skip the problem's Start instruction and open Web under Access URLs during the event.\n\n" +
              english.instructions;
          }
          problem.i18n = { en: english };
        }
        if (!ended) {
          delete problem.writeup;
          if (problem.i18n) {
            const english = { ...object(object(problem.i18n).en) };
            delete english.writeup;
            problem.i18n = { en: english };
          }
        }
        if (eventGate.kind === "scoring_not_started") {
          problem.instructions = "";
          delete problem.i18n;
        }
        problem.provider = "docker";
        problem.jobId = job?.jobId ?? problem.jobId;
        problem.eventStartsAt = context.event.startsAt;
        problem.eventEndsAt = context.event.endsAt;
        problem.expiresAt = context.event.expiresAt;
        problem.status = job?.status ?? "PENDING";
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
