import { createHash } from "node:crypto";
import { z } from "zod";
import { pluginStateSchemaVersion } from "../../../../scripts/lib/coordination-state-schema.js";
import type { LocalMatch } from "../../../../scripts/local-host/coordination-core.js";
import {
  coordinationHeadKey,
  type NativeCoordinationArtifact,
  NativeCoordinationError,
  type NativeCoordinationResponse,
  type NativeCoordinationRun,
  type NativeSchedulePatch,
} from "./domain/coordination.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";

/** Shared native behavior, independent of the persistence provider. */
export const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export const closedStatuses = new Set(["ENDED", "TEARDOWN", "ARCHIVED"]);
interface Operation {
  readonly key: string;
  readonly hash: string;
  readonly op: unknown;
}
export const matchSchema = z.object({
  state: z.unknown().refine((value) => value !== undefined),
  matchSecret: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.number().int().nonnegative(),
  stateSchemaVersion: z.number().int().positive(),
  scores: z.record(z.number().finite()),
});

export function jsonBytes(value: unknown): Buffer {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      ["bigint", "function", "symbol"].includes(typeof item)
    )
      throw new NativeCoordinationError(503, "coordination_state_invalid");
    return item;
  });
  if (text === undefined) throw new NativeCoordinationError(503, "coordination_state_invalid");
  return Buffer.from(text, "utf8");
}

export function assertArtifact(artifact: NativeCoordinationArtifact): void {
  coordinationHeadKey("00000000000000000000000000", artifact.problemId);
  digestSchema.parse(artifact.artifactDigest);
  if (
    artifact.pluginKey !== `plugins/${artifact.artifactDigest}.mjs` ||
    !/^catalogs\/[a-f0-9]{64}\.json$/u.test(artifact.catalogKey)
  )
    throw new NativeCoordinationError(503, "coordination_artifact_invalid");
  if (
    !Number.isSafeInteger(artifact.stateBudget.bytesPerTeam) ||
    artifact.stateBudget.bytesPerTeam < 1 ||
    !Number.isSafeInteger(artifact.stateBudget.baseBytes) ||
    artifact.stateBudget.baseBytes < 0
  )
    throw new NativeCoordinationError(503, "coordination_state_budget_invalid");
}

export function assertPin(run: NativeCoordinationRun, artifact: NativeCoordinationArtifact): void {
  if (
    run.artifactDigest !== artifact.artifactDigest ||
    run.pluginKey !== artifact.pluginKey ||
    run.catalogKey !== artifact.catalogKey ||
    run.match.stateSchemaVersion !== pluginStateSchemaVersion(artifact.plugin)
  )
    throw new NativeCoordinationError(409, "coordination_artifact_changed");
}

export function assertSelected(event: EventRecord, problemId: string): void {
  if (!event.problems.some((problem) => problem.problemId === problemId))
    throw new NativeCoordinationError(404, "coordination_not_configured");
}

export function assertOpen(event: EventRecord, now: number): void {
  if (
    !["DRAFT", "DEPLOYING", "READY"].includes(event.status) ||
    event.expiresAt <= Math.floor(now / 1000)
  )
    throw new NativeCoordinationError(409, "event_closed");
}

export function checkedRoster(event: EventRecord, teams: readonly TeamRecord[]) {
  if (
    teams.length !== event.teamCount ||
    teams.length < 1 ||
    teams.length > 48 ||
    new Set(teams.map((team) => team.teamId)).size !== teams.length ||
    teams.some((team) => team.eventId !== event.eventId)
  )
    throw new NativeCoordinationError(409, "coordination_roster_invalid");
  return teams
    .map((team) => ({ teamId: team.teamId, teamName: team.displayName ?? team.internalSlug }))
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
}

export function assertRoster(
  run: NativeCoordinationRun,
  roster: NativeCoordinationRun["roster"],
): void {
  if (
    JSON.stringify(run.roster.map((team) => team.teamId)) !==
    JSON.stringify(roster.map((team) => team.teamId))
  )
    throw new NativeCoordinationError(409, "coordination_roster_changed");
}

export function assertParticipantGate(event: EventRecord, now: number, move: boolean): void {
  if (!event.startsAt || now < Date.parse(event.startsAt))
    throw new NativeCoordinationError(
      move ? 422 : 409,
      move ? "event_ended" : "scoring_not_started",
    );
  if (
    move &&
    (closedStatuses.has(event.status) ||
      (event.endsAt !== undefined && now >= Date.parse(event.endsAt)))
  )
    throw new NativeCoordinationError(422, "event_ended");
  if (move && event.scoringLocked) throw new NativeCoordinationError(422, "scoring_locked");
}

export function validateOperation(operation: Operation): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(operation.key) || !/^[a-f0-9]{64}$/u.test(operation.hash))
    throw new NativeCoordinationError(400, "invalid_operation_key");
}

export function projection(
  artifact: NativeCoordinationArtifact,
  run: NativeCoordinationRun,
  teamId: string,
): NativeCoordinationResponse {
  return {
    status: 200,
    body: { projection: artifact.plugin.projectForTeam(structuredClone(run.match.state), teamId) },
    revision: run.revision,
  };
}

export function matchDigest(match: LocalMatch): string {
  return hash(
    jsonBytes({
      state: match.state,
      stateSchemaVersion: match.stateSchemaVersion,
      matchSecret: match.matchSecret,
      scores: match.scores,
    }),
  );
}

export function elapsed(event: EventRecord, run: NativeCoordinationRun, now: number): number {
  const start = Date.parse(event.startsAt ?? new Date(now).toISOString());
  const end = Math.min(
    now,
    event.endsAt ? Date.parse(event.endsAt) : Infinity,
    event.scoringLocked ? (run.clock.lockedAt ?? now) : Infinity,
  );
  return Math.max(run.clock.elapsedMs, Math.max(0, end - start - run.clock.pausedMs));
}

export function scheduledClock(
  event: EventRecord,
  run: NativeCoordinationRun,
  patch: NativeSchedulePatch,
  now: number,
): NativeCoordinationRun["clock"] {
  let pausedMs = run.clock.pausedMs;
  let lockedAt = run.clock.lockedAt;
  if (patch.scoringLocked === true && !event.scoringLocked) lockedAt = now;
  if (patch.scoringLocked === false && event.scoringLocked && lockedAt !== undefined) {
    pausedMs += Math.max(
      0,
      Math.min(now, event.endsAt ? Date.parse(event.endsAt) : Infinity) -
        Math.max(lockedAt, Date.parse(event.startsAt ?? new Date(now).toISOString())),
    );
    lockedAt = undefined;
  }
  return {
    pausedMs,
    ...(lockedAt === undefined ? {} : { lockedAt }),
    elapsedMs: elapsed(event, run, now),
  };
}

export function assertSchedule(event: EventRecord, patch: NativeSchedulePatch, now: number): void {
  if (
    event.startsAt &&
    Date.parse(event.startsAt) <= now &&
    patch.startsAt !== undefined &&
    patch.startsAt !== event.startsAt
  )
    throw new NativeCoordinationError(409, "coordination_start_already_fixed");
  if (event.status === "ARCHIVED") throw new NativeCoordinationError(409, "event_closed");
}

export function nextTime(event: EventRecord, now: number): string {
  return new Date(Math.max(now, Date.parse(event.updatedAt) + 1)).toISOString();
}

export function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
