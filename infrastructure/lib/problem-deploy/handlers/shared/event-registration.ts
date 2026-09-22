import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DeploymentsRepository } from "../../control-data/deployments-repository.js";
import type { DeploymentRecord } from "../../control-data/domain/deployments.js";
import type { EventRegistration } from "../../control-data/domain/event-registration.js";
import type { EventRecord, EventsRepository } from "../../control-data/domain/events.js";
import type { TeamsRepository } from "../../control-data/domain/teams.js";

export interface RegistrationDeps {
  events: Pick<EventsRepository, "getEvent" | "updateRegistration">;
  teams: Pick<TeamsRepository, "getTeam">;
  deployments: Pick<
    DeploymentsRepository,
    "listByTenantAndEvent" | "listByTeamLoginKey" | "getDeployment"
  >;
}

export class RegistrationError extends Error {
  constructor(
    readonly code: "not_found" | "closed" | "full" | "conflict" | "invalid_pool" | "not_ready",
  ) {
    super(code);
  }
}

export const registrationDigest = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

function secretMatches(secret: string, digest: string): boolean {
  const actual = Buffer.from(registrationDigest(secret));
  const expected = Buffer.from(digest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function activeEvent(event: EventRecord | undefined, now: number): event is EventRecord {
  return (
    !!event &&
    ["DRAFT", "DEPLOYING", "READY"].includes(event.status) &&
    event.expiresAt > Math.floor(now / 1000) &&
    (!event.endsAt || Date.parse(event.endsAt) > now)
  );
}

export function registrationSummary(event: EventRecord, now = Date.now()) {
  const registration = event.registration;
  return {
    tenantId: event.tenantId,
    enabled: Boolean(
      registration?.enabled && activeEvent(event, now) && Date.parse(registration.closesAt) > now,
    ),
    closesAt: registration?.closesAt,
    capacity: registration?.teamIds.length ?? 0,
    claimed: registration?.claims.length ?? 0,
    claimedTeamIds: registration?.claims.map((claim) => claim.teamId) ?? [],
    teamIds: registration?.teamIds ?? [],
  };
}

/** Opening never creates AWS accounts/resources. Only an explicit, verified event pool is used. */
export async function configureRegistration(
  deps: RegistrationDeps,
  tenantId: string,
  eventId: string,
  input: { enabled: false } | { enabled: true; closesAt: string; teamIds: string[] },
  now = Date.now(),
) {
  const event = await deps.events.getEvent(tenantId, eventId, true);
  if (!event) throw new RegistrationError("not_found");
  if (!activeEvent(event, now)) throw new RegistrationError("closed");
  const previous = event.registration;
  const selection = input.enabled ? input : previous;
  if (!selection) return registrationSummary(event, now);
  const { teamIds, closesAt } = selection;
  if (input.enabled) await validatePool(deps, event, teamIds, closesAt, now);
  if (previous?.claims.some((claim) => !teamIds.includes(claim.teamId))) {
    throw new RegistrationError("invalid_pool");
  }
  const invitation = randomBytes(32).toString("base64url");
  const registration: EventRegistration = {
    version: (previous?.version ?? 0) + 1,
    enabled: input.enabled,
    closesAt,
    teamIds,
    invitationHash:
      previous && !input.enabled ? previous.invitationHash : registrationDigest(invitation),
    claims: previous?.claims ?? [],
  };
  const outcome = await deps.events.updateRegistration({
    tenantId,
    eventId,
    expectedVersion: previous?.version ?? 0,
    registration,
    now: new Date(now).toISOString(),
  });
  if (outcome !== "updated") throw new RegistrationError("conflict");
  return {
    ...registrationSummary({ ...event, registration }, now),
    ...(input.enabled ? { invitation } : {}),
  };
}

async function validatePool(
  deps: RegistrationDeps,
  event: EventRecord,
  teamIds: readonly string[],
  closesAt: string,
  now: number,
) {
  if (
    !teamIds.length ||
    teamIds.length > 99 ||
    new Set(teamIds).size !== teamIds.length ||
    !Number.isFinite(Date.parse(closesAt)) ||
    Date.parse(closesAt) <= now ||
    Date.parse(closesAt) > event.expiresAt * 1000 ||
    (event.endsAt && Date.parse(closesAt) > Date.parse(event.endsAt))
  ) {
    throw new RegistrationError("invalid_pool");
  }
  const teams = await Promise.all(
    teamIds.map((id) => deps.teams.getTeam(event.tenantId, event.eventId, id)),
  );
  if (
    teams.some(
      (team) =>
        !team?.teamLoginKey || !team.awsAccountId || team.expiresAt <= Math.floor(now / 1000),
    ) ||
    new Set(teams.map((team) => team?.awsAccountId)).size !== teams.length
  ) {
    throw new RegistrationError("invalid_pool");
  }
  // Each slot must already have a deployment request for every problem. This reuses
  // verified-account, ExternalId and quota checks in the existing deploy pipeline.
  const deployments = await deps.deployments.listByTenantAndEvent(event.tenantId, event.eventId);
  const checks = teamIds.map((teamId, index) =>
    summarizeDeployments(
      deployments,
      event,
      teamId,
      now,
      teams[index]?.awsAccountId,
      teams[index]?.teamLoginKey,
    ),
  );
  if (checks.some((state) => state.state === "unprepared"))
    throw new RegistrationError("not_ready");
}

export async function inspectRegistration(
  deps: RegistrationDeps,
  tenantId: string,
  eventId: string,
  invitation: string,
  now = Date.now(),
) {
  const { event, registration } = await authorizedInvitation(deps, tenantId, eventId, invitation);
  let state = registration.claims.length >= registration.teamIds.length ? "full" : "open";
  if (!activeEvent(event, now) || !registration.enabled || Date.parse(registration.closesAt) <= now)
    state = "closed";
  return {
    name: event.name,
    state,
    remaining: Math.max(0, registration.teamIds.length - registration.claims.length),
  };
}

async function authorizedInvitation(
  deps: RegistrationDeps,
  tenantId: string,
  eventId: string,
  invitation: string,
) {
  const event = await deps.events.getEvent(tenantId, eventId, true);
  if (!event?.registration || !secretMatches(invitation, event.registration.invitationHash)) {
    throw new RegistrationError("not_found");
  }
  return { event, registration: event.registration };
}

/** A browser-generated 256-bit receipt makes retry/reload idempotent, without storing PII. */
export async function claimRegistration(
  deps: RegistrationDeps,
  tenantId: string,
  eventId: string,
  invitation: string,
  receipt: string,
  now = Date.now(),
) {
  const receiptHash = registrationDigest(receipt);
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 12; attempt++) {
    const { event, registration } = await authorizedInvitation(deps, tenantId, eventId, invitation);
    const attemptTime = now + Math.max(0, Date.now() - startedAt);
    if (registration.claims.some((claim) => claim.receiptHash === receiptHash)) {
      return registrationStatus(deps, tenantId, eventId, receipt, attemptTime);
    }
    if (
      !activeEvent(event, attemptTime) ||
      !registration.enabled ||
      Date.parse(registration.closesAt) <= attemptTime
    ) {
      throw new RegistrationError("closed");
    }
    const occupied = new Set(registration.claims.map((claim) => claim.teamId));
    const teamId = registration.teamIds.find((id) => !occupied.has(id));
    if (!teamId) throw new RegistrationError("full");
    const updated = await deps.events.updateRegistration({
      tenantId,
      eventId,
      expectedVersion: registration.version,
      now: new Date(attemptTime).toISOString(),
      registration: {
        ...registration,
        version: registration.version + 1,
        claims: [
          ...registration.claims,
          { receiptHash, teamId, claimedAt: new Date(attemptTime).toISOString() },
        ],
      },
    });
    if (updated === "updated")
      return registrationStatus(deps, tenantId, eventId, receipt, attemptTime);
    // A shared invitation can produce up to 99 simultaneous claims. Jitter separates
    // competing writers instead of making them collide again in synchronized rounds.
    // Keep retries bounded (at most about 3 seconds of waiting) and recheck deadlines.
    if (attempt < 11) {
      const delay = randomInt(10, Math.min(400, 20 * 2 ** attempt) + 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new RegistrationError("conflict");
}

function latestDeployments(
  deployments: readonly DeploymentRecord[],
  event: EventRecord,
  teamId: string,
) {
  return event.problems.map(
    (problem) =>
      deployments
        .filter(
          (row) =>
            row.tenantId === event.tenantId &&
            row.eventId === event.eventId &&
            row.teamId === teamId &&
            row.problemId === problem.problemId,
        )
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId),
        )[0],
  );
}

function summarizeDeployments(
  deployments: readonly DeploymentRecord[],
  event: EventRecord,
  teamId: string,
  now: number,
  awsAccountId: string | undefined,
  teamLoginKey: string | undefined,
) {
  const jobs = latestDeployments(deployments, event, teamId);
  const usable = (job: (typeof jobs)[number]) =>
    !!job &&
    !!awsAccountId &&
    job.awsAccountId === awsAccountId &&
    !!teamLoginKey &&
    job.teamLoginKey === teamLoginKey &&
    !job.teardownRequestedAt &&
    job.expiresAt > Math.floor(now / 1000);
  // During force redeploy, the eventually consistent team index can still expose
  // the previous COMPLETE rows. The strongly read event must leave DEPLOYING
  // before those rows can count as ready or release a participant credential.
  const ready =
    event.status === "DEPLOYING"
      ? 0
      : jobs.filter((job) => usable(job) && job?.status === "COMPLETE").length;
  let state = ready === jobs.length ? "ready" : "preparing";
  if (
    jobs.some(
      (job) =>
        !usable(job) ||
        !["COMPLETE", "PENDING", "APPROVAL_PENDING", "IN_PROGRESS"].includes(job?.status ?? ""),
    )
  )
    state = "failed";
  if (!jobs.length || jobs.some((job) => !job)) state = "unprepared";
  return { state, ready, total: jobs.length };
}

export async function registrationStatus(
  deps: RegistrationDeps,
  tenantId: string,
  eventId: string,
  receipt: string,
  now = Date.now(),
) {
  const event = await deps.events.getEvent(tenantId, eventId, true);
  const claim = event?.registration?.claims.find((item) =>
    secretMatches(receipt, item.receiptHash),
  );
  if (!event || !claim) throw new RegistrationError("not_found");
  if (!activeEvent(event, now)) throw new RegistrationError("closed");
  const team = await deps.teams.getTeam(tenantId, eventId, claim.teamId);
  if (!team?.teamLoginKey) throw new RegistrationError("not_found");
  if (team.expiresAt <= Math.floor(now / 1000)) throw new RegistrationError("closed");
  // Poll only the reserved team's existing index; do not read the entire event
  // once per waiting participant. summarizeDeployments still checks tenant/event/team.
  const jobs = await deps.deployments.listByTeamLoginKey(team.teamLoginKey);
  let progress = summarizeDeployments(
    jobs,
    event,
    claim.teamId,
    now,
    team.awsAccountId,
    team.teamLoginKey,
  );
  if (progress.state === "ready") {
    // READY is reconciled from another eventually consistent index. Confirm only
    // each problem's latest candidate against its primary row before releasing
    // the key; force redeploy deletes the old row when it creates its replacement.
    const candidates = latestDeployments(jobs, event, claim.teamId).filter((job) => !!job);
    const confirmed = await Promise.all(
      candidates.map(async (candidate) => {
        const current = await deps.deployments.getDeployment(candidate.jobId, {
          consistentRead: true,
          expectedTeamLoginKey: team.teamLoginKey,
        });
        return current?.jobId === candidate.jobId && current.problemId === candidate.problemId
          ? current
          : undefined;
      }),
    );
    progress = summarizeDeployments(
      confirmed.filter((job) => !!job),
      event,
      claim.teamId,
      now,
      team.awsAccountId,
      team.teamLoginKey,
    );
    // A deleted index candidate can precede visibility of its replacement. Keep
    // polling for the new row instead of treating this transient gap as terminal.
    if (progress.state === "unprepared") progress.state = "preparing";
  }
  return {
    eventName: event.name,
    teamId: claim.teamId,
    ...progress,
    ...(progress.state === "ready" ? { teamLoginKey: team.teamLoginKey } : {}),
  };
}
