import { randomInt } from "node:crypto";
import {
  type DisruptionFireRequest,
  DisruptionFireRequestSchema,
  evaluateDisruptionTriggers,
  type FiredDisruption,
  type ProblemDisruptionEntry,
  type ProblemPhaseEntry,
  triggerMatches,
} from "@tenkacloud/problem-sdk/internal";
import type { AuditOperation, AuditRecord } from "./audit-record";
import {
  declaredDisruptions,
  disruptionParameters,
  pinDisruption,
  unsupportedDisruption,
} from "./disruption-catalog";
import type { DisruptionRequest, DisruptionTarget } from "./disruption-model";
import { DisruptionRunner } from "./disruption-runner";
import { DisruptionStore } from "./disruption-store";
import { assertPlaying, HostError, type HostedEvent, type Job, type Team } from "./model";
import type { ApiRequest, ApiResponse, HostingService } from "./service";
import type { OrganizerPrincipal } from "./store";
import { digest } from "./store";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const iso = (time: number) => new Date(time).toISOString();
const executionAuditId = (id: string) =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;

/** One host process owns durable requests and polls only the retained command targets. */
export class LocalDisruptions {
  readonly store: DisruptionStore;
  private readonly runner: DisruptionRunner;
  constructor(private readonly host: HostingService) {
    this.store = new DisruptionStore(host.store);
    this.runner = new DisruptionRunner(
      this.store,
      () => host.engine.disruptionAdapter?.(),
      host.now,
      (target, requestId, injecting) => this.assertTarget(target, requestId, injecting),
      (row) => this.observeResult(row),
    );
  }
  recover(): void {
    this.runner.recover();
  }
  async tick(): Promise<void> {
    // Cleanup is serviced before new trigger work, including after event end.
    await this.runner.tick();
    for (const event of this.host.store.events())
      this.host.store.transaction(() => this.captureTriggers(event));
    await this.runner.tick();
  }
  async drain(): Promise<void> {
    await this.runner.drain();
  }
  route(
    event: HostedEvent,
    parts: string[],
    request: ApiRequest,
    principal: OrganizerPrincipal,
    operation: AuditOperation | undefined,
  ): ApiResponse | undefined {
    if (parts[0] !== "disruptions") return undefined;
    const command = `${request.method} ${parts.slice(1).join("/")}`;
    if (command === "GET ")
      return {
        status: 200,
        body: {
          entries: event.problems.flatMap((problem) =>
            declaredDisruptions(problem).disruptions.map((disruption) => ({
              problemId: problem.problemId,
              disruption: {
                ...disruption,
                description: disruption.description ?? "",
                unavailableReason: unsupportedDisruption(disruption),
              },
            })),
          ),
        },
      };
    if (command === "POST fire") {
      const organizerId = principal.userId;
      if (!organizerId) throw new HostError(403, "An organizer identity is required.");
      const parsed = DisruptionFireRequestSchema.safeParse(request.body);
      if (!parsed.success)
        throw new HostError(400, "Invalid disruption request.", "invalid_disruption_request");
      const existing = this.store.request(event.eventId, parsed.data.requestId);
      const row = existing
        ? this.host.store.transaction(() => this.enqueue(event, parsed.data, organizerId))
        : this.host.audit.accept(operation, [], () =>
            this.enqueue(
              event,
              parsed.data,
              organizerId,
              undefined,
              this.host.store.featureFlags().audit ? operation : undefined,
            ),
          );
      return {
        status: 202,
        body: {
          auditId: row.auditId,
          firedAt: row.firedAt,
          affectedTeamIds: row.targetTeamIds,
          status: "accepted",
        },
      };
    }
    if (command === "GET audit") return { status: 200, body: this.audit(event, request.query) };
    if (command === "GET recurring") {
      const queued = new Set(
        this.store
          .executions(event.eventId)
          .filter((row) => row.status === "queued")
          .map((row) => row.requestId),
      );
      return {
        status: 200,
        body: {
          items: this.store
            .requests(event.eventId)
            .filter(
              (row) =>
                !row.cancelled && row.input.timing === "recurring" && queued.has(row.requestId),
            )
            .map((row) => ({
              ...row.input,
              firedBy: row.firedBy,
              firedAt: row.firedAt,
              affectedTeamIds: row.targetTeamIds,
              endsAt: iso(row.endsAt),
            })),
        },
      };
    }
    if (
      request.method === "POST" &&
      parts.length === 4 &&
      parts[1] === "recurring" &&
      parts[3] === "cancel"
    ) {
      this.host.audit.commit(operation, () => {
        const row = this.store.request(event.eventId, parts[2] ?? "");
        if (!row) throw new HostError(404, "Disruption request not found.");
        this.store.putRequest({ ...row, cancelled: true });
        for (const execution of this.store.executions(event.eventId))
          if (execution.requestId === row.requestId && execution.status === "queued")
            this.store.putExecution({
              ...execution,
              status: "skipped",
              reason: "The organizer cancelled this request.",
              updatedAt: this.host.now(),
            });
      });
      return { status: 200, body: { ok: true } };
    }
    throw new HostError(404, "Unknown disruption endpoint.");
  }
  private audit(event: HostedEvent, query: URLSearchParams) {
    const limit = Number(query.get("limit") ?? 50);
    const offset = Number(query.get("cursor") ?? 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new HostError(400, "Invalid history pagination.");
    const requests = this.store.requests(event.eventId);
    const executions = this.store.executions(event.eventId);
    return {
      items: requests.slice(offset, offset + limit).map((row) => ({
        ...row.input,
        auditId: row.auditId,
        firedBy: row.firedBy,
        firedAt: row.firedAt,
        targetTeamIds: row.targetTeamIds,
        parameters: row.parameters,
        cancelled: row.cancelled,
        scheduledFor: iso(row.dueAt),
        executions: executions
          .filter((execution) => execution.requestId === row.requestId)
          .map((execution) => ({
            id: execution.id,
            teamId: execution.teamId,
            tick: execution.tick,
            status: execution.status,
            dueAt: iso(execution.dueAt),
            updatedAt: iso(execution.updatedAt),
            ...("reason" in execution ? { reason: execution.reason } : {}),
            ...("revertAt" in execution ? { revertAt: iso(execution.revertAt) } : {}),
            ...(execution.status === "revert_command_completed"
              ? { reason: "The revert command completed. Frontend health has not been verified." }
              : {}),
          })),
      })),
      ...(offset + limit < requests.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }
  private teams(event: HostedEvent, input: DisruptionFireRequest): Team[] {
    const teams = this.host.store
      .teams(event.eventId)
      .sort((a, b) => a.teamId.localeCompare(b.teamId));
    if (input.scope === "all") return teams;
    if (input.scope === "team") {
      const selected = new Set(input.targetTeamIds);
      if (
        selected.size !== input.targetTeamIds?.length ||
        teams.filter((team) => selected.has(team.teamId)).length !== selected.size
      )
        throw new HostError(
          400,
          "Targets must be distinct teams in this event.",
          "invalid_targets",
        );
      return teams.filter((team) => selected.has(team.teamId));
    }
    const count = input.randomCount ?? 0;
    if (count > teams.length)
      throw new HostError(
        400,
        "The random target count exceeds this event's teams.",
        "invalid_targets",
      );
    for (let index = teams.length - 1; index > 0; index -= 1) {
      const other = randomInt(index + 1);
      const left = teams[index];
      const right = teams[other];
      if (left && right) {
        teams[index] = right;
        teams[other] = left;
      }
    }
    return teams.slice(0, count);
  }
  private enqueue(
    event: HostedEvent,
    input: DisruptionFireRequest,
    firedBy: string,
    triggerDueAt?: number,
    acceptedAudit?: AuditOperation,
  ): DisruptionRequest {
    const fingerprint = digest(JSON.stringify(canonical(input)));
    const existing = this.store.request(event.eventId, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new HostError(
          409,
          "This request ID was already used for a different payload.",
          "request_conflict",
        );
      return existing;
    }
    assertPlaying(event, this.host.now());
    if (!this.host.engine.disruptionAdapter?.())
      throw new HostError(503, "AWS disruptions are not configured.", "aws_not_configured");
    const problem = event.problems.find((each) => each.problemId === input.problemId);
    const declaration =
      problem &&
      declaredDisruptions(problem).disruptions.find((each) => each.id === input.disruptionId);
    if (!problem || !declaration)
      throw new HostError(
        404,
        "This disruption is not declared by the event's pinned problem.",
        "unknown_disruption",
      );
    const parameters = disruptionParameters(declaration, input.parameters ?? {});
    const teams = this.teams(event, input);
    if (!teams.length)
      throw new HostError(409, "The disruption has no target teams.", "no_targets");
    const targets = teams.map((team) => {
      const jobId = this.host.store.jobId(event.eventId, team.teamId, problem.problemId);
      if (!jobId) throw new HostError(409, "A target has no deployment.", "no_deployment");
      return pinDisruption({
        problem,
        declaration,
        parameters,
        team,
        job: this.host.store.job(jobId),
      });
    });
    const { interval, dueAt, count } = requestSchedule(input, this.host.now(), triggerDueAt);
    const row: DisruptionRequest = {
      eventId: event.eventId,
      requestId: input.requestId,
      fingerprint,
      input,
      auditId: digest(`${event.eventId}:${input.requestId}`).slice(0, 32),
      firedBy,
      firedAt: iso(this.host.now()),
      targetTeamIds: teams.map((team) => team.teamId),
      parameters,
      dueAt,
      endsAt: dueAt + interval * (count - 1),
      cancelled: false,
      ...(acceptedAudit ? { acceptedAudit } : {}),
    };
    this.store.putRequest(row);
    for (let tick = 1; tick <= count; tick += 1)
      for (const target of targets)
        this.store.putExecution({
          id: digest(`${event.eventId}:${input.requestId}:${tick}:${target.teamId}`).slice(0, 32),
          eventId: event.eventId,
          requestId: input.requestId,
          tick,
          teamId: target.teamId,
          dueAt: dueAt + (tick - 1) * interval,
          target,
          updatedAt: this.host.now(),
          status: "queued",
        });
    return row;
  }
  private observeResult(row: import("./disruption-model").DisruptionExecution): void {
    const accepted = this.store.request(row.eventId, row.requestId)?.acceptedAudit;
    if (!accepted) return;
    let phase: AuditRecord["phase"];
    let outcome: AuditRecord["outcome"];
    let reason: AuditRecord["reason"] | undefined;
    switch (row.status) {
      case "failed":
      case "skipped":
        phase = "result";
        outcome = "failed";
        reason = "operation_failed";
        break;
      case "inject_unknown":
        phase = "result";
        outcome = "unknown";
        break;
      case "revert_due":
        phase = "result";
        outcome = row.injectOutcome === "completed" ? "succeeded" : "failed";
        if (outcome === "failed") reason = "operation_failed";
        break;
      case "recovery_required":
        phase = "cleanup";
        outcome = "unknown";
        break;
      case "revert_command_completed":
        phase = "cleanup";
        outcome = "succeeded";
        reason = "unverified";
        break;
      default:
        return;
    }
    this.host.audit.observe({
      ...accepted,
      action: "disruption.operation",
      resource: { kind: "disruption", id: executionAuditId(row.id) },
      phase,
      outcome,
      ...(reason ? { reason } : {}),
    });
  }
  private assertTarget(target: DisruptionTarget, requestId: string, injecting: boolean): void {
    const job = this.host.store.job(target.jobId);
    const team = this.host.store.team(target.teamId);
    if (
      job.eventId !== target.eventId ||
      job.teamId !== target.teamId ||
      digest(job.unit ?? "") !== target.unitHash ||
      job.deployedAt !== target.deployedAt ||
      job.operation ||
      team.aws?.accountId !== target.accountId ||
      `arn:aws:iam::${team.aws.accountId}:role/${team.aws.roleName}` !== target.roleArn
    )
      throw new HostError(
        409,
        "The original deployment generation is unavailable.",
        "stale_target",
      );
    if (injecting) {
      const request = this.store.request(target.eventId, requestId);
      if (!request || request.cancelled || job.status !== "COMPLETE")
        throw new HostError(409, "The disruption can no longer inject.", "cancelled");
      assertPlaying(this.host.store.event(target.eventId), this.host.now());
    }
  }
  /** Called inside the same SQLite transaction as the score/phase transition that caused it. */
  captureTriggers(event: HostedEvent): void {
    try {
      assertPlaying(event, this.host.now());
    } catch {
      return;
    }
    if (!this.host.engine.disruptionAdapter?.()) return;
    for (const job of this.host.store.jobs(event.eventId)) {
      if (job.status !== "COMPLETE" || job.operation || !job.deployedAt) continue;
      const problem = event.problems.find((each) => each.problemId === job.problemId);
      if (!problem || job.definition !== problem.definition) continue;
      this.captureJobTriggers(event, job, declaredDisruptions(problem));
    }
  }
  private captureJobTriggers(
    event: HostedEvent,
    job: Job,
    { disruptions, phases }: ReturnType<typeof declaredDisruptions>,
  ): void {
    if (!job.deployedAt) return;
    const context = {
      scoreAfter: this.host.store.team(job.teamId).score,
      elapsedMin: (this.host.now() - job.deployedAt) / 60_000,
      phases,
    };
    for (const trigger of evaluateDisruptionTriggers(disruptions, context, new Set())) {
      const triggerIdentity = `${job.jobId}:${job.deployedAt}:${digest(job.unit ?? "")}:${trigger.disruptionId}`;
      const requestId = `trigger-${digest(triggerIdentity).slice(0, 48)}`;
      if (this.store.request(event.eventId, requestId)) continue;
      const declaration = disruptions.find((each) => each.id === trigger.disruptionId);
      if (!declaration || unsupportedDisruption(declaration)) continue;
      const dueAt = triggerDueAt(
        declaration,
        trigger,
        phases,
        job.deployedAt,
        this.host.now(),
        context.scoreAfter,
      );
      this.enqueue(
        event,
        {
          problemId: job.problemId,
          disruptionId: trigger.disruptionId,
          requestId,
          scope: "team",
          targetTeamIds: [job.teamId],
          parameters: { ...trigger.parameters },
          timing: trigger.recurrence ? "recurring" : "immediate",
          ...(trigger.recurrence ?? {}),
        },
        `metadata:${trigger.triggerKind}`,
        dueAt,
      );
    }
  }
}

function requestSchedule(input: DisruptionFireRequest, now: number, triggerDueAt?: number) {
  const interval = input.timing === "recurring" ? (input.intervalMinutes ?? 1) * 60_000 : 0;
  const dueAt =
    triggerDueAt ??
    now + (input.timing === "scheduled" ? (input.afterMinutes ?? 1) * 60_000 : interval);
  return { interval, dueAt, count: input.timing === "recurring" ? (input.maxFires ?? 1) : 1 };
}

function triggerDueAt(
  declaration: ProblemDisruptionEntry,
  trigger: FiredDisruption,
  phases: readonly ProblemPhaseEntry[],
  deployedAt: number,
  now: number,
  scoreAfter: number,
): number {
  const elapsedMin = (now - deployedAt) / 60_000;
  const phase = [...phases]
    .sort((a, b) => a.afterMinutes - b.afterMinutes)
    .filter((each) => each.afterMinutes <= elapsedMin)
    .at(-1);
  const matched = declaration.triggers?.find(
    (condition) =>
      condition.kind === trigger.triggerKind &&
      triggerMatches(condition, { elapsedMin, scoreAfter, phases }, phase?.name),
  );
  if (matched?.kind === "after-deploy") return deployedAt + matched.afterMinutes * 60_000;
  if (matched?.kind === "phase-entered" && phase) return deployedAt + phase.afterMinutes * 60_000;
  return now;
}
