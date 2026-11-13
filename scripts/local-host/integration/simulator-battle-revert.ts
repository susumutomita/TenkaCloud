import { z } from "zod";
import { type BattleDeploymentIO, battleDeploymentIO } from "./simulator-battle-deployment";
import type { BattleRound } from "./simulator-battle-observation";

const auditSchema = z.object({
  items: z.array(
    z.object({
      requestId: z.string(),
      targetTeamIds: z.array(z.string()),
      executions: z.array(
        z.object({
          id: z.string(),
          teamId: z.string(),
          status: z.string(),
          revertAt: z.iso.datetime(),
          updatedAt: z.iso.datetime(),
        }),
      ),
    }),
  ),
});
const stateSchema = z.object({
  problems: z.array(
    z.object({
      problemId: z.string(),
      applicationStatus: z.object({
        overall: z.string(),
        healthyCount: z.number(),
        totalCount: z.number(),
        checkedAt: z.iso.datetime(),
      }),
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
const problem = "hello-world-battle";
type Execution = z.infer<typeof auditSchema>["items"][number]["executions"][number];

export async function requireOriginalRevertDeclaration(round: BattleRound, io: BattleDeploymentIO) {
  const catalog = z
    .object({
      entries: z.array(
        z.object({
          problemId: z.string(),
          disruption: z.object({
            id: z.string(),
            unavailableReason: z.string().optional(),
            action: z
              .object({
                kind: z.string(),
                revert: z.object({ afterSeconds: z.number() }).optional(),
              })
              .optional(),
          }),
        }),
      ),
    })
    .parse(
      await io.request(
        round.adminOrigin,
        `/events/${round.eventId}/disruptions`,
        round.organizerToken,
        "GET",
      ),
    );
  const own = catalog.entries.filter(
    (e) => e.problemId === problem && e.disruption.id === "frontend-down",
  );
  if (
    own.length !== 1 ||
    own[0]?.disruption.unavailableReason ||
    own[0]?.disruption.action?.kind !== "ssm-run-command" ||
    own[0]?.disruption.action?.revert?.afterSeconds !== 600
  )
    throw new Error("Original supported 600-second declaration required.");
}
async function execution(
  round: BattleRound,
  requestId: string,
  io: BattleDeploymentIO,
): Promise<Execution> {
  const rows = auditSchema
    .parse(
      await io.request(
        round.adminOrigin,
        `/events/${round.eventId}/disruptions/audit?limit=200`,
        round.organizerToken,
        "GET",
      ),
    )
    .items.filter((row) => row.requestId === requestId);
  const row = rows[0];
  const own = row?.executions[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.targetTeamIds.length !== 1 ||
    row.targetTeamIds[0] !== round.teams[0]?.teamId ||
    row.executions.length !== 1 ||
    !own ||
    own.teamId !== round.teams[0]?.teamId
  )
    throw new Error("Revert audit ownership mismatch.");
  return own;
}
async function health(round: BattleRound, io: BattleDeploymentIO) {
  return Promise.all(
    round.teams.map(async (team) => {
      const rows = stateSchema
        .parse(
          await io.request(
            round.participantOrigin,
            `/portal/me/problems/${problem}/state`,
            team.teamLoginKey,
            "GET",
          ),
        )
        .problems.filter((p) => p.problemId === problem);
      if (rows.length !== 1 || !rows[0]) throw new Error("Original Battle health required.");
      return rows[0].applicationStatus;
    }),
  );
}
type Health = Awaited<ReturnType<typeof health>>[number];
function healthy(s: Health | undefined) {
  return s?.overall === "healthy" && s.healthyCount === 2 && s.totalCount === 2;
}
function degraded(s: Health | undefined) {
  return s?.overall === "degraded" && s.healthyCount === 1 && s.totalCount === 2;
}
async function freshScores(round: BattleRound, after: number, io: BattleDeploymentIO) {
  const results = await Promise.all(
    round.teams.map(async (team) => {
      const rows = scoreSchema.parse(
        await io.request(
          round.participantOrigin,
          "/portal/me/score-events",
          team.teamLoginKey,
          "GET",
        ),
      ).entries;
      return rows.some(
        (e) =>
          e.jobId === team.jobId &&
          e.problemId === problem &&
          e.source === "uptime" &&
          e.points === 100 &&
          e.result === "ok" &&
          Date.parse(e.occurredAt) > after,
      );
    }),
  );
  return results.every(Boolean);
}
function validateTransition(current: Execution, initial: Execution, now: number) {
  if (current.id !== initial.id || current.revertAt !== initial.revertAt)
    throw new Error("Revert execution changed.");
  if (
    !["revert_due", "reverting", "revert_pending", "revert_command_completed"].includes(
      current.status,
    )
  )
    throw new Error("Revert outcome is failed or unknown.");
  if (current.status !== "revert_due" && now < Date.parse(initial.revertAt))
    throw new Error("Early revert transition.");
  if (
    current.status === "revert_command_completed" &&
    Date.parse(current.updatedAt) < Date.parse(initial.revertAt)
  )
    throw new Error("Early revert completion.");
}

/** Read-only observation. Production wall clock and scheduler are never replaced by the CLI. */
export async function observeAutomaticBattleRevert(
  round: BattleRound,
  requestId: string,
  beforeFireWallTime: number,
  io: BattleDeploymentIO = battleDeploymentIO,
  wallNow: () => number = Date.now,
) {
  if (
    round.teams.length !== 2 ||
    new Set(round.teams.map((t) => t.teamId)).size !== 2 ||
    new Set(round.teams.map((t) => t.jobId)).size !== 2
  )
    throw new Error("Two owned distinct teams/jobs required.");
  const initial = await execution(round, requestId, io);
  const deadline = Date.parse(initial.revertAt);
  validateInitial(initial, beforeFireWallTime);
  const first = await health(round, io);
  if (!degraded(first[0]) || !healthy(first[1]) || wallNow() >= deadline)
    throw new Error("Unrepaired target and healthy peer required before deadline.");
  const monotonicEnd = io.now() + Math.max(0, deadline - wallNow()) + 240_000;
  while (io.now() < monotonicEnd) {
    const current = await execution(round, requestId, io);
    validateTransition(current, initial, wallNow());
    const statuses = await health(round, io);
    if (!healthy(statuses[1])) throw new Error("Peer health lost.");
    if (wallNow() < deadline && !degraded(statuses[0]))
      throw new Error("Target recovered before scheduled revert.");
    const complete = await recovered(round, current, statuses, io);
    if (io.now() >= monotonicEnd) break;
    if (complete)
      return {
        kind: "natural-revert-command-and-fresh-health-score",
        acceptancePassed: false,
        strictInjectionIntervalProven: false,
        peerContinuity: "sampled",
        revertAt: initial.revertAt,
      };
    await io.sleep(1000);
  }
  throw new Error("Automatic revert and fresh health/score were not confirmed.");
}
async function recovered(
  round: BattleRound,
  current: Execution,
  statuses: Health[],
  io: BattleDeploymentIO,
) {
  if (current.status !== "revert_command_completed") return false;
  const after = Date.parse(current.updatedAt);
  return (
    statuses.every((s) => healthy(s) && Date.parse(s.checkedAt) > after) &&
    (await freshScores(round, after, io))
  );
}

function validateInitial(initial: Execution, beforeFireWallTime: number) {
  const deadline = Date.parse(initial.revertAt);
  if (
    !Number.isFinite(beforeFireWallTime) ||
    deadline < beforeFireWallTime + 600_000 ||
    deadline > beforeFireWallTime + 840_000 ||
    initial.status !== "revert_due"
  )
    throw new Error("Normal pending 600-second revert not established.");
}
