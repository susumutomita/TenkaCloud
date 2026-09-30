import { afterEach, expect, test } from "bun:test";
import { fakeFlag } from "./fake-aws";
import { createOrganizerSession } from "./organizer-fixture";
import { createParticipantAwsFixture } from "./participant-aws-fixture";
import { progressionFixture } from "./progression-fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const config = {
  gateProblemId: "hello-world",
  unlockTargetIds: ["ac26-crypto-battle"],
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

test("gate policy uses current organizer roles and audit rollback, including canonical paths", async () => {
  const { f, event, path } = await fixture();
  const operator = await createOrganizerSession(
    f.service,
    f.adminToken,
    "gate-operator",
    "Operator",
  );
  const viewer = await createOrganizerSession(f.service, f.adminToken, "gate-viewer", "Viewer");
  expect((await f.request("/feature-flags", "PUT", { key: "audit", enabled: true })).status).toBe(
    200,
  );
  expect((await f.flag(true)).status).toBe(200);
  expect((await f.request(path, "GET", undefined, viewer.token)).status).toBe(200);
  expect((await f.request(path, "PUT", config, viewer.token)).status).toBe(403);
  expect(
    (
      await f.request(
        "/feature-flags",
        "PUT",
        { key: "challengePrerequisiteGate", enabled: false },
        operator.token,
      )
    ).status,
  ).toBe(403);
  expect((await f.request(path, "PUT", config, operator.token)).status).toBe(200);
  const entries = f.service.audit.list(
    new URLSearchParams({ action: "progression.updated" }),
  ).items;
  expect(entries[0]).toMatchObject({
    outcome: "succeeded",
    actorKind: "organizer",
    actorRole: "Operator",
    resourceKind: "event",
    target: event.eventId,
  });
  f.store.database.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON host_audit_records BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
  );
  for (const route of [
    path,
    path.replace("progression-gate", "%70rogression-gate"),
    path.replace("/events/", "/events//"),
  ])
    expect(
      (await f.request(route, "PUT", { ...config, completionBonus: 900 }, operator.token)).status,
    ).toBe(503);
  expect((await f.request(path, "DELETE", undefined, operator.token)).status).toBe(503);
  expect(f.store.event(event.eventId).progressionGate).toMatchObject({ completionBonus: 50 });
  f.store.database.exec("DROP TRIGGER fail_audit");
  expect((await f.request(path, "DELETE", undefined, operator.token)).status).toBe(200);
  expect(f.store.event(event.eventId).progressionGate).toBeUndefined();
});

test("gate bonus projects the signed ledger once instead of adding to a floored total", async () => {
  const { f, event, team, path } = await fixture();
  await f.flag(true);
  await f.request(path, "PUT", config);
  for (let attempt = 0; attempt < 21; attempt++) {
    const wrong = await f.request(
      "/portal/me/submit-flag",
      "POST",
      { problemId: "hello-world", flag: `wrong-${attempt}` },
      team.teamLoginKey,
    );
    expect(wrong.status).toBe(200);
    expect(wrong.body.totalScore).toBe(0);
  }
  const job = f.store
    .jobs(event.eventId, team.teamId)
    .find((job) => job.problemId === "hello-world");
  if (!job) throw new Error("Missing job");
  const stack = JSON.parse(job.unit ?? "{}").stackName as string;
  const solved = await f.request(
    "/portal/me/submit-flag",
    "POST",
    { problemId: "hello-world", flag: fakeFlag(stack) },
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
    { problemId: "hello-world", flag: fakeFlag(stack) },
    team.teamLoginKey,
    "signed-ledger-bonus",
  );
  expect(replay.body.totalScore).toBe(45);
});

for (const stage of [
  "initial",
  "competitor",
  "participant_viewer",
  "federation",
  "token_body",
] as const) {
  test(`a gate change at ${stage} withholds pending AWS console credentials`, async () => {
    const f = await createParticipantAwsFixture();
    cleanups.push(f.close);
    const event = f.store.event(f.eventId);
    const problem = event.problems[0];
    if (!problem) throw new Error("Missing problem");
    f.store.putEvent({
      ...event,
      problems: [...event.problems, { ...problem, problemId: "gate" }],
      progressionGate: {
        gateProblemId: "gate",
        unlockTargetIds: [problem.problemId],
        defaultPolicy: "required",
      },
    });
    if (stage === "initial") f.store.setFeatureFlag("challengePrerequisiteGate", true);
    else
      f.controls.before = async (current) => {
        if (current === stage) f.store.setFeatureFlag("challengePrerequisiteGate", true);
      };
    const denied = await f.access();
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("challenge_prerequisite_not_met");
    expect(denied.body.loginUrl).toBeUndefined();
    expect(denied.body.credentials).toBeUndefined();
    if (stage === "initial") expect(f.calls).toHaveLength(0);
  });
}
