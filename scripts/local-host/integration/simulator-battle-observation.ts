import { z } from "zod";
import { type BattleDeploymentIO, battleDeploymentIO } from "./simulator-battle-deployment";

export interface BattleRound {
  readonly adminOrigin: string;
  readonly participantOrigin: string;
  readonly organizerToken: string;
  readonly eventId: string;
  readonly teams: readonly { teamId: string; teamLoginKey: string; jobId: string }[];
}
const problem = "hello-world-battle";
const stateSchema = z.object({
  problems: z.array(
    z.object({
      problemId: z.string(),
      applicationStatus: z
        .object({
          overall: z.string(),
          healthyCount: z.number(),
          totalCount: z.number(),
          checkedAt: z.iso.datetime().optional(),
        })
        .optional(),
    }),
  ),
});
const scoreSchema = z.object({
  entries: z.array(
    z.object({
      jobId: z.string(),
      problemId: z.string(),
      source: z.string(),
      points: z.number(),
      result: z.string(),
      occurredAt: z.iso.datetime(),
    }),
  ),
});
const endpointSchema = z.object({
  teamId: z.string(),
  endpoints: z.array(
    z.object({
      slot: z.string(),
      registrationLocator: z.object({ kind: z.literal("simulator"), url: z.string().min(1) }),
    }),
  ),
});
const auditSchema = z.object({
  items: z.array(
    z.object({
      requestId: z.string(),
      targetTeamIds: z.array(z.string()),
      executions: z.array(z.object({ teamId: z.string(), status: z.string() })),
    }),
  ),
});
type Scores = z.infer<typeof scoreSchema>["entries"];
const scoreKey = (entry: Scores[number]) => JSON.stringify(entry);
function validateRound(round: BattleRound) {
  if (
    round.teams.length !== 2 ||
    new Set(round.teams.map((t) => t.teamId)).size !== 2 ||
    new Set(round.teams.map((t) => t.jobId)).size !== 2 ||
    new Set(round.teams.map((t) => t.teamLoginKey)).size !== 2
  )
    throw new Error("Two distinct owned teams/jobs required.");
  if (
    ![round.eventId, ...round.teams.flatMap((t) => [t.teamId, t.jobId])].every((v) =>
      /^[A-Za-z0-9_-]{1,128}$/u.test(v),
    ) ||
    !round.organizerToken ||
    round.teams.some((t) => !t.teamLoginKey)
  )
    throw new Error("Invalid owned round identity.");
}
async function snapshot(round: BattleRound, io: BattleDeploymentIO) {
  return Promise.all(
    round.teams.map(async (team) => {
      const view = stateSchema.parse(
        await io.request(
          round.participantOrigin,
          `/portal/me/problems/${problem}/state`,
          team.teamLoginKey,
          "GET",
        ),
      );
      const rows = view.problems.filter((p) => p.problemId === problem);
      if (rows.length !== 1) throw new Error("Original Battle state missing.");
      const scores = scoreSchema.parse(
        await io.request(
          round.participantOrigin,
          "/portal/me/score-events",
          team.teamLoginKey,
          "GET",
        ),
      ).entries;
      return { status: rows[0]?.applicationStatus, scores };
    }),
  );
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function fresh(
  round: BattleRound,
  before: Snapshot,
  now: Snapshot,
  disrupted: boolean,
  watermark: number,
) {
  return round.teams.every((team, index) => {
    const row = now[index],
      prior = before[index];
    if (!row?.status?.checkedAt || !prior) return false;
    const priorTime = prior.status?.checkedAt ? Date.parse(prior.status.checkedAt) : watermark;
    const threshold = Math.max(priorTime, watermark);
    const loss = disrupted && index === 0;
    const s = row.status;
    const checkedAt = Date.parse(row.status.checkedAt);
    const old = new Set(prior.scores.map(scoreKey));
    const scored = row.scores.some(
      (e) =>
        e.jobId === team.jobId &&
        e.problemId === problem &&
        e.source === "uptime" &&
        e.points === (loss ? -100 : 100) &&
        e.result === (loss ? "wrong" : "ok") &&
        Date.parse(e.occurredAt) > threshold &&
        Date.parse(e.occurredAt) <= checkedAt &&
        !old.has(scoreKey(e)),
    );
    return (
      s.overall === (loss ? "degraded" : "healthy") &&
      s.healthyCount === (loss ? 1 : 2) &&
      s.totalCount === 2 &&
      checkedAt > threshold &&
      scored
    );
  });
}
async function applied(round: BattleRound, requestId: string, io: BattleDeploymentIO) {
  const rows = auditSchema
    .parse(
      await io.request(
        round.adminOrigin,
        `/events/${round.eventId}/disruptions/audit?limit=200`,
        round.organizerToken,
        "GET",
      ),
    )
    .items.filter((r) => r.requestId === requestId);
  if (rows.length === 0) return false;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.targetTeamIds.length !== 1 ||
    row.targetTeamIds[0] !== round.teams[0]?.teamId ||
    row.executions.length !== 1 ||
    row.executions[0]?.teamId !== round.teams[0]?.teamId
  )
    throw new Error("Disruption ownership mismatch.");
  const status = row.executions[0]?.status;
  if (["failed", "skipped", "recovery_required"].includes(status ?? ""))
    throw new Error("Disruption failed or ambiguous.");
  return status === "revert_due";
}
async function waitObservation(
  round: BattleRound,
  before: Snapshot,
  io: BattleDeploymentIO,
  watermark: number,
  requestId?: string,
) {
  const end = io.now() + 240_000;
  while (io.now() < end) {
    const current = await snapshot(round, io);
    const audit = requestId ? await applied(round, requestId, io) : true;
    if (io.now() >= end) break;
    if (audit && fresh(round, before, current, requestId !== undefined, watermark)) return;
    await io.sleep(1000);
  }
  throw new Error("Fresh owned Battle health/score not confirmed.");
}
/** Real production APIs only; no test scheduler ticks or runtime clock replacement. */
export async function observeHealthyBattle(
  round: BattleRound,
  io: BattleDeploymentIO = battleDeploymentIO,
  wallNow: () => number = Date.now,
) {
  validateRound(round);
  const watermark = wallNow();
  if (!Number.isSafeInteger(watermark) || watermark <= 0)
    throw new Error("Valid observation wall time required.");
  await io.request(
    round.adminOrigin,
    `/events/${round.eventId}/schedule`,
    round.organizerToken,
    "PATCH",
    { startNow: true },
  );
  const before = await snapshot(round, io);
  for (const team of round.teams) {
    const path = `/portal/me/problems/${problem}/endpoints`;
    const view = endpointSchema.parse(
      await io.request(round.participantOrigin, path, team.teamLoginKey, "GET"),
    );
    if (
      view.teamId !== team.teamId ||
      view.endpoints.length !== 2 ||
      !["frontend", "api"].every(
        (slot) => view.endpoints.filter((e) => e.slot === slot).length === 1,
      )
    )
      throw new Error("Owned original endpoint slots missing.");
    for (const endpoint of view.endpoints)
      await io.request(
        round.participantOrigin,
        `${path}/${endpoint.slot}`,
        team.teamLoginKey,
        "POST",
        { url: endpoint.registrationLocator.url },
      );
  }
  await waitObservation(round, before, io, watermark);
  return {
    kind: "fresh-two-team-healthy-uptime-score",
    acceptancePassed: false,
    endpointHealthObserved: true,
    scoringObserved: true,
  };
}
export async function observeBattleDisruption(
  round: BattleRound,
  requestId: string,
  io: BattleDeploymentIO = battleDeploymentIO,
  wallNow: () => number = Date.now,
) {
  validateRound(round);
  const watermark = wallNow();
  if (!Number.isSafeInteger(watermark) || watermark <= 0)
    throw new Error("Valid observation wall time required.");
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId))
    throw new Error("Unique disruption request required.");
  const before = await snapshot(round, io);
  if (before.some((row) => !row.status?.checkedAt))
    throw new Error("Disruption requires an observed baseline.");
  const receipt = z
    .object({ status: z.literal("accepted"), affectedTeamIds: z.array(z.string()) })
    .parse(
      await io.request(
        round.adminOrigin,
        `/events/${round.eventId}/disruptions/fire`,
        round.organizerToken,
        "POST",
        {
          problemId: problem,
          disruptionId: "frontend-down",
          scope: "team",
          targetTeamIds: [round.teams[0]?.teamId],
          requestId,
          timing: "immediate",
        },
      ),
    );
  if (receipt.affectedTeamIds.length !== 1 || receipt.affectedTeamIds[0] !== round.teams[0]?.teamId)
    throw new Error("Unexpected disruption targets.");
  await waitObservation(round, before, io, watermark, requestId);
  return {
    kind: "target-score-loss-peer-healthy",
    acceptancePassed: false,
    participantRepairVerified: false,
    automaticRevertVerified: false,
    perSlotHealthVerified: false,
  };
}
