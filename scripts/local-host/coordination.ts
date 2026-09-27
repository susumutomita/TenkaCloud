import {
  createMatch,
  type LocalMatch,
  type MatchTransition,
  transitionMatch,
} from "./coordination-core";
import { type Gate, gate, HostError, type HostedEvent, object, type Problem } from "./model";
import type { ApiRequest, ApiResponse, HostingService } from "./service";
import { digest } from "./store";

/** SaaS coordination parity (coordination-handler.ts's isScoringActive): a move outside the
 * scoring window is a 422 rejection, not the 409 the flag-submission gate uses. */
const moveRejection: Record<Exclude<Gate["kind"], "ok">, string> = {
  scoring_not_started: "event_ended",
  scoring_ended: "event_ended",
  scoring_locked: "scoring_locked",
};

/** Called under HostingService's event queue; SQLite commits state and every affected score together. */
export class LocalCoordination {
  constructor(private readonly host: HostingService) {}
  private problem(event: HostedEvent): Problem | undefined {
    return event.problems.find((problem) => problem.runtime === "coordination");
  }
  private plugin(problem: Problem) {
    const plugin = this.host.engine.coordinationPlugin?.(problem);
    if (!plugin) throw new HostError(503, "Coordination runtime is unavailable.");
    return plugin;
  }
  private elapsed(event: HostedEvent): number {
    let end = event.endsAt ? Date.parse(event.endsAt) : Infinity;
    if (event.scoringLocked && event.scoringLockedAt)
      end = Math.min(end, Date.parse(event.scoringLockedAt));
    return Math.max(
      0,
      Math.min(this.host.now(), end) -
        Date.parse(event.startsAt ?? event.createdAt) -
        (event.coordinationPausedMs ?? 0),
    );
  }
  private load(event: HostedEvent, problem: Problem): LocalMatch {
    const saved = this.host.store.coordination(event.eventId, problem.problemId);
    if (saved) return JSON.parse(saved) as LocalMatch;
    const teams = this.host.store.teams(event.eventId);
    return createMatch(this.plugin(problem), {
      eventId: event.eventId,
      teamIds: teams.map((team) => team.teamId).sort((a, b) => a.localeCompare(b)),
      teamNames: Object.fromEntries(teams.map((team) => [team.teamId, team.displayName])),
    });
  }
  private save(event: HostedEvent, problem: Problem, result: MatchTransition): void {
    const serialized = JSON.stringify(result.match);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024)
      throw new HostError(503, "Coordination state exceeds the local runtime limit.");
    this.host.store.putCoordination(event.eventId, problem.problemId, serialized);
    const occurredAt = new Date(
      Math.min(this.host.now(), event.endsAt ? Date.parse(event.endsAt) : Infinity),
    ).toISOString();
    for (const [teamId, delta] of Object.entries(result.deltas)) {
      if (!delta) continue;
      const team = this.host.store.team(teamId);
      const jobId = this.host.store.jobId(event.eventId, teamId, problem.problemId);
      if (!jobId) throw new HostError(503, "Coordination roster has no deployment.");
      this.host.store.putTeam({
        ...team,
        score: team.score + delta,
        scoreEvents: [
          {
            jobId,
            problemId: problem.problemId,
            source: "coordination",
            points: delta,
            result: delta > 0 ? "ok" : "wrong",
            occurredAt,
          },
          ...team.scoreEvents,
        ],
      });
    }
  }
  accountUnlock(event: HostedEvent, locked: boolean): void {
    if (
      !this.problem(event) ||
      locked ||
      !event.scoringLocked ||
      !event.scoringLockedAt ||
      !event.startsAt
    )
      return;
    const end = Math.min(this.host.now(), event.endsAt ? Date.parse(event.endsAt) : Infinity);
    const start = Math.max(Date.parse(event.scoringLockedAt), Date.parse(event.startsAt));
    event.coordinationPausedMs = (event.coordinationPausedMs ?? 0) + Math.max(0, end - start);
  }
  assertSchedule(event: HostedEvent, body: Record<string, unknown>): void {
    if (!this.problem(event) || !event.startsAt || Date.parse(event.startsAt) > this.host.now())
      return;
    if (typeof body.endsAt === "string" && Date.parse(body.endsAt) < this.host.now())
      throw new HostError(
        409,
        "A running Battle cannot end in the past. Use End Event to stop now.",
      );
    if (body.startNow || (body.startsAt !== undefined && body.startsAt !== event.startsAt))
      throw new HostError(
        409,
        "A running Battle's start time cannot change. Create a new event to start over.",
      );
  }
  advance(event: HostedEvent): void {
    const problem = this.problem(event);
    if (
      !problem ||
      !event.startsAt ||
      Date.parse(event.startsAt) > this.host.now() ||
      !["READY", "ENDED"].includes(event.status) ||
      event.scoringLocked
    )
      return;
    const plugin = this.plugin(problem);
    const result = transitionMatch(
      plugin,
      this.load(event, problem),
      this.host.store.teams(event.eventId).map((team) => team.teamId),
      this.elapsed(event),
    );
    this.host.store.transaction(() => this.save(event, problem, result));
  }
  private authorize(request: ApiRequest) {
    const projection =
      request.method === "GET" && request.path === "/portal/me/coordination/projection";
    const move = request.method === "POST" && request.path === "/portal/me/coordination/op";
    if (!projection && !move) throw new HostError(404, "Unknown coordination endpoint.");
    const team = this.host.store.authenticateTeam(request.token);
    const event = this.host.store.event(team.eventId);
    const problem = this.problem(event);
    if (!problem) throw new HostError(404, "No coordination Battle in this event.");
    const job = this.host.store
      .jobs(event.eventId, team.teamId)
      .find((item) => item.problemId === problem.problemId);
    if (job?.status !== "COMPLETE" || job.operation)
      throw new HostError(409, "This team's Battle is not running.");
    if (move) {
      const result = gate(event, this.host.now());
      if (result.kind !== "ok") {
        const error = moveRejection[result.kind];
        throw new HostError(422, error, error);
      }
    } else if (gate(event, this.host.now()).kind === "scoring_not_started")
      throw new HostError(409, "The event has not started.");
    const body = move ? object(request.body) : {};
    if ("teamId" in body || "eventId" in body)
      throw new HostError(400, "Identity comes from the authenticated team key.");
    if (move) object(body.op);
    return { team, event, problem, move, body };
  }
  request(request: ApiRequest): ApiResponse {
    const { team, event, problem, move, body } = this.authorize(request);
    const fingerprint = digest(JSON.stringify({ path: request.path, body }));
    if (request.nonce) {
      if (!/^[A-Za-z0-9_-]{8,128}$/u.test(request.nonce))
        throw new HostError(400, "Invalid Idempotency-Key.");
      const receipt = this.host.store.receipt(team.teamId, request.nonce, fingerprint);
      if (receipt) return receipt;
    }
    this.advance(event);
    const plugin = this.plugin(problem);
    const match = this.load(event, problem);
    if (!move)
      return { status: 200, body: { projection: plugin.projectForTeam(match.state, team.teamId) } };
    const result = transitionMatch(
      plugin,
      match,
      this.host.store.teams(event.eventId).map((item) => item.teamId),
      this.elapsed(event),
      { teamId: team.teamId, op: body.op },
    );
    const response: ApiResponse = result.rejection
      ? { status: 422, body: { error: result.rejection } }
      : {
          status: 200,
          body: { projection: plugin.projectForTeam(result.match.state, team.teamId) },
        };
    this.host.store.transaction(() => {
      this.save(event, problem, result);
      if (request.nonce)
        this.host.store.putReceipt(
          team.teamId,
          request.nonce,
          fingerprint,
          response.status,
          response.body,
        );
    });
    return response;
  }
}
