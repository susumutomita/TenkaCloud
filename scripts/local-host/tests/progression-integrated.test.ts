import { afterEach, expect, test } from "bun:test";
import {
  legacyAuditSnapshot,
  rejectLegacyAuditWrites,
  seedLegacyAudit,
} from "./audit-retirement-fixture";
import { GATE_PROBLEM, progressionFixture } from "./progression-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const config = {
  gateProblemId: GATE_PROBLEM,
  unlockTargetIds: ["crypto-battle"],
  defaultPolicy: "required",
  completionBonus: 50,
};
async function fixture() {
  const f = await progressionFixture();
  cleanups.push(f.close);
  const event = await f.create();
  const team = event.teams[0];
  if (!team) throw new Error("Missing team");
  return { f, event, team, path: `/events/${event.eventId}/progression-gate` };
}

test("gate policy writes are atomic, including canonical paths", async () => {
  const { f, event, path } = await fixture();
  seedLegacyAudit(f.store);
  rejectLegacyAuditWrites(f.store);
  const legacy = legacyAuditSnapshot(f.store);
  expect((await f.flag(true)).status).toBe(200);
  expect((await f.request(path, "GET", undefined, "invalid")).status).toBe(401);
  expect((await f.request(path, "PUT", config, "invalid")).status).toBe(401);
  expect((await f.request(path, "GET")).status).toBe(200);
  expect((await f.request(path, "PUT", config)).status).toBe(200);
  f.store.database.exec(
    "CREATE TRIGGER fail_gate BEFORE UPDATE ON host_events BEGIN SELECT RAISE(ABORT, 'test gate persistence failure'); END;",
  );
  for (const route of [
    path,
    path.replace("progression-gate", "%70rogression-gate"),
    path.replace("/events/", "/events//"),
  ])
    expect((await f.request(route, "PUT", { ...config, completionBonus: 900 })).status).toBe(500);
  expect((await f.request(path, "DELETE")).status).toBe(500);
  expect(f.store.event(event.eventId).progressionGate).toMatchObject({ completionBonus: 50 });
  f.store.database.exec("DROP TRIGGER fail_gate");
  expect((await f.request(path, "DELETE")).status).toBe(200);
  expect(f.store.event(event.eventId).progressionGate).toBeUndefined();
  expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
});

test("gate bonus projects the signed ledger once instead of adding to a floored total", async () => {
  const { f, event, team, path } = await fixture();
  seedLegacyAudit(f.store);
  rejectLegacyAuditWrites(f.store);
  const legacy = legacyAuditSnapshot(f.store);
  await f.flag(true);
  await f.request(path, "PUT", config);
  for (let attempt = 0; attempt < 21; attempt++) {
    const wrong = await f.request(
      "/portal/me/submit-flag",
      "POST",
      { problemId: GATE_PROBLEM, flag: `wrong-${attempt}` },
      team.teamLoginKey,
    );
    expect(wrong.status).toBe(200);
    expect(wrong.body.totalScore).toBe(0);
  }
  const flag = await f.exerciseFlag(event, team.teamId);
  const solved = await f.request(
    "/portal/me/submit-flag",
    "POST",
    { problemId: GATE_PROBLEM, flag },
    team.teamLoginKey,
    "signed-ledger-bonus",
  );
  expect(solved.status).toBe(200);
  expect(solved.body.totalScore).toBe(45);
  expect(f.store.team(team.teamId).score).toBe(45);
  expect(
    f.store.team(team.teamId).scoreEvents.filter((entry) => entry.source === "gate_bonus"),
  ).toHaveLength(1);
  await f.restart();
  expect(f.store.team(team.teamId).score).toBe(45);
  const replay = await f.request(
    "/portal/me/submit-flag",
    "POST",
    { problemId: GATE_PROBLEM, flag },
    team.teamLoginKey,
    "signed-ledger-bonus",
  );
  expect(replay.body.totalScore).toBe(45);
  expect(legacyAuditSnapshot(f.store)).toEqual(legacy);
});
