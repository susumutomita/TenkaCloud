import { timingSafeEqual } from "node:crypto";
import {
  type RegistrationConfigInput,
  RegistrationConfigSchema,
  type RegistrationProgress,
  registrationEventActive,
  registrationSecretSchema,
  validRegistrationSelection,
} from "@tenkacloud/problem-sdk/internal/event-registration";
import { z } from "zod";
import { randomToken } from "./auth";
import { HostError, type HostedEvent, type Job, object, type Problem, type Team } from "./model";
import type { ApiRequest, ApiResponse } from "./service";
import { digest, type HostStore } from "./store";

export const REGISTRATION_FLAG = "registration";
const HOST_TENANT = "local-host";
const route =
  /^\/portal\/registration\/local-host\/([0-9A-HJKMNP-TV-Z]{26})\/(info|claim|status)$/u;
const claimInput = z.object({ receipt: registrationSecretSchema }).strict();
const poolSchema = z
  .array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/))
  .min(1)
  .max(99);
interface RegistrationRow {
  event_id: string;
  enabled: 0 | 1;
  invitation_hash: string;
  closes_at: string;
  pool: string;
}
interface Registration extends RegistrationRow {
  teamIds: string[];
}
interface Claim {
  team_id: string;
  login_hash: string;
  claimed_at: string;
}

function matches(secret: string, expected: string): boolean {
  const actual = Buffer.from(digest(secret));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function fail(code: string, status = 409): never {
  throw new HostError(status, code, code);
}

/** Atomic allocation of existing host teams. The public receipt never follows a rotated key. */
export class HostRegistration {
  constructor(
    private readonly store: HostStore,
    private readonly now: () => number,
  ) {}

  featureEnabled(): boolean {
    return this.store.featureFlags()[REGISTRATION_FLAG] === true;
  }

  private registration(eventId: string): Registration | undefined {
    const row = this.store
      .statement(
        "SELECT event_id,enabled,invitation_hash,closes_at,pool FROM host_registrations WHERE event_id=?",
      )
      .get(eventId) as RegistrationRow | null | undefined;
    if (!row) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(row.pool);
    } catch {
      fail("registration_unavailable", 503);
    }
    const pool = poolSchema.safeParse(raw);
    if (
      !pool.success ||
      new Set(pool.data).size !== pool.data.length ||
      !Number.isFinite(Date.parse(row.closes_at))
    )
      fail("registration_unavailable", 503);
    return { ...row, teamIds: pool.data };
  }

  private claim(eventId: string, receipt: string): Claim | undefined {
    return (
      (this.store
        .statement(
          "SELECT team_id,login_hash,claimed_at FROM host_registration_claims WHERE event_id=? AND receipt_hash=?",
        )
        .get(eventId, digest(receipt)) as Claim | null | undefined) ?? undefined
    );
  }

  private claimedTeams(eventId: string): string[] {
    return (
      this.store
        .statement(
          "SELECT team_id FROM host_registration_claims WHERE event_id=? ORDER BY claimed_at,team_id",
        )
        .all(eventId) as { team_id: string }[]
    ).map((row) => row.team_id);
  }

  summary(eventId: string, canConfigure = true) {
    const event = this.store.event(eventId);
    const registration = this.registration(eventId);
    const claimedTeamIds = this.claimedTeams(eventId);
    return {
      tenantId: HOST_TENANT,
      featureEnabled: this.featureEnabled(),
      canConfigure,
      enabled:
        this.featureEnabled() &&
        registration?.enabled === 1 &&
        registrationEventActive(event, this.now()) &&
        Date.parse(registration.closes_at) > this.now(),
      closesAt: registration?.closes_at,
      capacity: registration?.teamIds.length ?? 0,
      claimed: claimedTeamIds.length,
      claimedTeamIds,
      teamIds: registration?.teamIds ?? [],
    };
  }

  configure(eventId: string, input: unknown) {
    const parsed = RegistrationConfigSchema.safeParse(input);
    if (!parsed.success) fail("invalid_request", 400);
    return this.store.transaction(() => this.configureInTransaction(eventId, parsed.data));
  }

  private configureInTransaction(eventId: string, input: RegistrationConfigInput) {
    if (!this.featureEnabled()) fail("feature_disabled");
    const event = this.store.event(eventId);
    if (!registrationEventActive(event, this.now())) fail("closed");
    const previous = this.registration(eventId);
    const selection = input.enabled
      ? input
      : previous && { teamIds: previous.teamIds, closesAt: previous.closes_at };
    if (!selection) return this.summary(eventId);
    if (input.enabled) this.validatePool(event, input);
    if (this.claimedTeams(eventId).some((id) => !selection.teamIds.includes(id)))
      fail("invalid_pool");
    const invitation = input.enabled ? randomToken() : undefined;
    const invitationHash = invitation ? digest(invitation) : previous?.invitation_hash;
    if (!invitationHash) fail("registration_unavailable", 503);
    this.store
      .statement(
        "INSERT INTO host_registrations(event_id,enabled,invitation_hash,closes_at,pool) VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET enabled=excluded.enabled,invitation_hash=excluded.invitation_hash,closes_at=excluded.closes_at,pool=excluded.pool",
      )
      .run(
        eventId,
        input.enabled ? 1 : 0,
        invitationHash,
        selection.closesAt,
        JSON.stringify(selection.teamIds),
      );
    return { ...this.summary(eventId), ...(invitation ? { invitation } : {}) };
  }

  private validatePool(
    event: HostedEvent,
    input: Extract<RegistrationConfigInput, { enabled: true }>,
  ): void {
    if (!validRegistrationSelection(event, input.teamIds, input.closesAt, this.now()))
      fail("invalid_pool");
    for (const id of input.teamIds) {
      const team = this.poolTeam(event, id);
      if (!registrationSecretSchema.safeParse(team.loginKey).success) fail("login_key_missing");
      if (this.progress(event, team).state !== "ready") fail("not_ready");
    }
  }

  private poolTeam(event: HostedEvent, teamId: string): Team {
    const team = this.store.teams(event.eventId).find((team) => team.teamId === teamId);
    if (!team) fail("invalid_pool");
    return team;
  }

  /** Runtime ownership is local and strongly read: Docker and Battle require no AWS account. */
  private progress(
    event: HostedEvent,
    team: Team,
  ): Omit<RegistrationProgress, "eventName" | "teamId" | "teamLoginKey"> {
    const jobs = this.store.jobs(event.eventId, team.teamId);
    const states = event.problems.map((problem) =>
      this.jobState(
        team,
        problem,
        jobs.find((job) => job.problemId === problem.problemId),
      ),
    );
    const total = states.length;
    const ready = event.status === "READY" ? states.filter((state) => state === "ready").length : 0;
    if (!total || states.includes("unprepared")) return { state: "unprepared", ready, total };
    if (states.includes("failed")) return { state: "failed", ready, total };
    if (states.includes("preparing") || event.status !== "READY")
      return { state: "preparing", ready, total };
    return { state: "ready", ready, total };
  }

  private jobState(
    team: Team,
    problem: Problem,
    job: Job | undefined,
  ): RegistrationProgress["state"] {
    if (!job) return "unprepared";
    if (job.definition !== problem.definition) return "failed";
    if (problem.runtime === "cloudformation" && !this.cloudAccountMatches(team, job.unit))
      return "failed";
    if (job.operation || job.status === "PENDING" || job.status === "IN_PROGRESS")
      return "preparing";
    return job.status === "COMPLETE" && job.unit ? "ready" : "failed";
  }

  private cloudAccountMatches(team: Team, unit: string | null): boolean {
    if (!team.aws || !unit) return false;
    try {
      const value = object(JSON.parse(unit));
      return (
        value.kind === "cloudformation" &&
        value.accountId === team.aws.accountId &&
        value.roleArn === `arn:aws:iam::${team.aws.accountId}:role/${team.aws.roleName}`
      );
    } catch {
      return false;
    }
  }

  request(request: ApiRequest): ApiResponse {
    const matched = request.method === "POST" && route.exec(request.path);
    if (!matched || !registrationSecretSchema.safeParse(request.token).success)
      fail("not_found", 404);
    const eventId = matched[1],
      action = matched[2];
    if (!eventId) fail("not_found", 404);
    const input = action === "claim" ? claimInput.safeParse(request.body) : undefined;
    if (input && !input.success) fail("invalid_request", 400);
    const body = this.store.transaction(() => {
      if (action === "status") return this.receiptStatus(eventId, request.token);
      const registration = this.registration(eventId);
      if (!registration || !matches(request.token, registration.invitation_hash))
        fail("not_found", 404);
      const event = this.store.event(eventId);
      if (action === "info") return this.info(event, registration);
      if (!input?.success) fail("invalid_request", 400);
      return this.claimInTransaction(event, registration, input.data.receipt);
    });
    return { status: 200, body };
  }

  private info(event: HostedEvent, registration: Registration) {
    const remaining = Math.max(
      0,
      registration.teamIds.length - this.claimedTeams(event.eventId).length,
    );
    const availableState = remaining ? "open" : "full";
    return {
      name: event.name,
      state: this.isOpen(event, registration) ? availableState : "closed",
      remaining,
    };
  }

  private isOpen(event: HostedEvent, registration: Registration): boolean {
    return (
      this.featureEnabled() &&
      registration.enabled === 1 &&
      registrationEventActive(event, this.now()) &&
      Date.parse(registration.closes_at) > this.now()
    );
  }

  private claimInTransaction(
    event: HostedEvent,
    registration: Registration,
    receipt: string,
  ): RegistrationProgress {
    if (this.claim(event.eventId, receipt)) return this.status(event, receipt);
    if (!this.featureEnabled()) fail("feature_disabled");
    if (!this.isOpen(event, registration)) fail("closed");
    const occupied = this.claimedTeams(event.eventId);
    const available = registration.teamIds.filter((id) => !occupied.includes(id));
    if (!available.length) fail("full");
    const team = available
      .map((id) => this.poolTeam(event, id))
      .find((candidate) => this.progress(event, candidate).state === "ready");
    if (!team) fail("not_ready");
    if (!registrationSecretSchema.safeParse(team.loginKey).success) fail("login_key_missing");
    this.store
      .statement(
        "INSERT INTO host_registration_claims(event_id,receipt_hash,team_id,login_hash,claimed_at) VALUES (?,?,?,?,?)",
      )
      .run(
        event.eventId,
        digest(receipt),
        team.teamId,
        digest(team.loginKey),
        new Date(this.now()).toISOString(),
      );
    return this.status(event, receipt);
  }

  private receiptStatus(eventId: string, receipt: string): RegistrationProgress {
    if (!this.claim(eventId, receipt)) fail("not_found", 404);
    return this.status(this.store.event(eventId), receipt);
  }

  private status(event: HostedEvent, receipt: string): RegistrationProgress {
    const claim = this.claim(event.eventId, receipt);
    if (!claim) fail("not_found", 404);
    const team = this.poolTeam(event, claim.team_id);
    if (!claim.login_hash || !matches(team.loginKey, claim.login_hash)) fail("receipt_revoked");
    if (!registrationEventActive(event, this.now())) fail("closed");
    const progress = this.progress(event, team);
    return {
      eventName: event.name,
      teamId: team.teamId,
      ...progress,
      ...(progress.state === "ready" ? { teamLoginKey: team.loginKey } : {}),
    };
  }
}
