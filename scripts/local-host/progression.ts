import {
  CHALLENGE_PREREQUISITE_GATE_FLAG,
  computeLockedProblemIds,
  isGateCompleted,
  type ProgressionGateConfig,
  ProgressionGateConfigSchema,
  resolveTeamGatePolicy,
} from "@tenkacloud/problem-sdk/internal";
import { HostError, type HostedEvent, type Team } from "./model";
import { projectedScore } from "./score";
import type { HostStore } from "./store";

interface Completion {
  completed_at: string;
  bonus_points: number | null;
}

/** The host owns one competition tenant. Every completion is still scoped to event and team. */
export class HostProgression {
  constructor(
    private readonly store: HostStore,
    private readonly now: () => number,
  ) {}

  enabled(): boolean {
    return this.store.featureFlags()[CHALLENGE_PREREQUISITE_GATE_FLAG] === true;
  }

  private configuration(event: HostedEvent): ProgressionGateConfig | undefined {
    if (event.progressionGate === undefined) return undefined;
    const parsed = ProgressionGateConfigSchema.safeParse(event.progressionGate);
    if (!parsed.success || this.invalidReference(event, parsed.data))
      throw new HostError(
        503,
        "Stored progression gate is invalid. An organizer must repair it.",
        "invalid_progression_gate",
      );
    return parsed.data;
  }

  configurationValid(event: HostedEvent): boolean {
    if (event.progressionGate === undefined) return true;
    const parsed = ProgressionGateConfigSchema.safeParse(event.progressionGate);
    return parsed.success && !this.invalidReference(event, parsed.data);
  }

  private invalidReference(event: HostedEvent, config: ProgressionGateConfig): string | undefined {
    const problems = new Set(event.problems.map((problem) => problem.problemId));
    if (!problems.has(config.gateProblemId)) return "gate_problem_not_in_event";
    if (config.unlockTargetIds.some((id) => !problems.has(id))) return "unlock_target_not_in_event";
    const teams = new Set(this.store.teams(event.eventId).map((team) => team.teamId));
    if (Object.keys(config.teamOverrides ?? {}).some((id) => !teams.has(id)))
      return "unknown_override_team";
    return undefined;
  }

  /** PUT and DELETE preserve the completion ledger, including when replacing the gate problem. */
  configure(event: HostedEvent, raw: unknown, remove = false): unknown {
    if (!this.enabled())
      throw new HostError(409, "Progression gate is disabled.", "feature_disabled");
    if (event.status === "ARCHIVED")
      throw new HostError(409, "An archived event cannot be edited.");
    const parsed = remove ? undefined : ProgressionGateConfigSchema.safeParse(raw);
    if (parsed && !parsed.success)
      throw new HostError(400, "Invalid progression gate.", "invalid_progression_gate");
    const config = parsed?.success ? parsed.data : undefined;
    const invalid = config && this.invalidReference(event, config);
    if (invalid) throw new HostError(400, invalid, "invalid_progression_gate");
    const removed = event.progressionGate !== undefined;
    event.progressionGate = config;
    event.updatedAt = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      this.store.putEvent(event);
      this.captureEvent(event.eventId);
    });
    return remove ? { removed } : { progressionGate: config };
  }

  private completion(team: Team, problemId: string): Completion | undefined {
    const row = this.store
      .statement(
        "SELECT completed_at,bonus_points FROM host_problem_completions WHERE event_id=? AND team_id=? AND problem_id=?",
      )
      .get(team.eventId, team.teamId, problemId) as Completion | null | undefined;
    return row ?? undefined;
  }

  view(team: Team) {
    if (!this.enabled()) return undefined;
    const event = this.store.event(team.eventId);
    const config = this.configuration(event);
    if (!config) return undefined;
    const completed = this.completion(team, config.gateProblemId) !== undefined;
    return {
      gateProblemId: config.gateProblemId,
      gateCompleted: completed,
      ...resolveTeamGatePolicy(config, team.teamId),
      lockedProblemIds: [...computeLockedProblemIds(config, team.teamId, completed)],
    };
  }

  allowed(team: Team, problemId: string): boolean {
    return !this.view(team)?.lockedProblemIds.includes(problemId);
  }

  assertAccess(team: Team, problemId: string): void {
    if (!this.allowed(team, problemId))
      throw new HostError(
        409,
        "Complete the prerequisite challenge first.",
        "challenge_prerequisite_not_met",
      );
  }

  captureAllEvents(): void {
    for (const event of this.store.events())
      if (this.configurationValid(event)) this.captureEvent(event.eventId);
  }

  /** Call inside the transaction that writes the score, including automatic scoring ticks. */
  captureEvent(eventId: string): void {
    for (const team of this.store.teams(eventId)) this.captureTeam(team);
  }

  /** Record completion even without a configured gate or with the feature disabled. */
  captureTeam(team: Team): void {
    const completed = new Set(
      (
        this.store
          .statement(
            "SELECT problem_id FROM host_problem_completions WHERE event_id=? AND team_id=?",
          )
          .all(team.eventId, team.teamId) as { problem_id: string }[]
      ).map((row) => row.problem_id),
    );
    const scores = new Map<string, number>();
    for (const event of team.scoreEvents
      .filter((event) => !completed.has(event.problemId))
      .reverse()
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
      if (event.source === "gate_bonus") continue;
      const score = (scores.get(event.problemId) ?? 0) + event.points;
      scores.set(event.problemId, score);
      if (
        !isGateCompleted({ score, flagSubmitted: event.source === "flag" && event.result === "ok" })
      )
        continue;
      this.store
        .statement(
          "INSERT OR IGNORE INTO host_problem_completions(event_id,team_id,problem_id,completed_at) VALUES (?,?,?,?)",
        )
        .run(team.eventId, team.teamId, event.problemId, event.occurredAt);
    }
    if (!this.enabled()) return;
    const config = this.configuration(this.store.event(team.eventId));
    if (!config) return;
    const completion = this.completion(team, config.gateProblemId);
    if (!completion || completion.bonus_points !== null) return;
    const { completionBonus } = resolveTeamGatePolicy(config, team.teamId);
    this.store
      .statement(
        "UPDATE host_problem_completions SET bonus_points=? WHERE event_id=? AND team_id=? AND problem_id=? AND bonus_points IS NULL",
      )
      .run(completionBonus, team.eventId, team.teamId, config.gateProblemId);
    if (!completionBonus) return;
    const jobId = this.store.jobId(team.eventId, team.teamId, config.gateProblemId);
    if (!jobId) throw new HostError(503, "Completed gate has no deployment.");
    const scoreEvents: Team["scoreEvents"] = [
      {
        jobId,
        problemId: config.gateProblemId,
        source: "gate_bonus",
        points: completionBonus,
        result: "ok",
        occurredAt: new Date(this.now()).toISOString(),
      },
      ...team.scoreEvents,
    ];
    this.store.putTeam({
      ...team,
      scoreEvents,
      score: projectedScore(this.store.event(team.eventId), scoreEvents).total,
    });
  }
}

/** Locked metadata retains only the card identity; no instructions, hints or runtime capabilities. */
export function lockedProblem(problem: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [
      "problemId",
      "jobId",
      "name",
      "status",
      "provider",
      "category",
      "difficulty",
      "score",
      "eventStartsAt",
      "eventEndsAt",
      "expiresAt",
    ]
      .filter((key) => key in problem)
      .map((key) => [key, problem[key]])
      .concat([
        ["instructions", ""],
        ["stackOutputs", {}],
      ]),
  );
}
