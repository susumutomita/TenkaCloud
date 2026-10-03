import { afterEach, expect, test } from "bun:test";
import { fakeFlag } from "./fake-aws";
import { type CreatedEvent, progressionFixture } from "./progression-fixture";

const fixtures: Awaited<ReturnType<typeof progressionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const result = await progressionFixture();
  fixtures.push(result);
  return result;
}
const configuration = {
  gateProblemId: "hello-world",
  unlockTargetIds: ["ac26-crypto-battle"],
  defaultPolicy: "required",
  completionBonus: 50,
};
function alpha(event: CreatedEvent) {
  const team = event.teams[0];
  if (!team) throw new Error("No team");
  return team;
}
function beta(event: CreatedEvent) {
  const team = event.teams[1];
  if (!team) throw new Error("No team");
  return team;
}
function problems(body: Record<string, unknown>) {
  return body.problems as Record<string, unknown>[];
}
function progression(body: Record<string, unknown>) {
  return body.progression as { gateCompleted: boolean; lockedProblemIds: string[] };
}
async function solve(f: Awaited<ReturnType<typeof fixture>>, event: CreatedEvent, nonce?: string) {
  const team = alpha(event);
  const job = f.store
    .jobs(event.eventId, team.teamId)
    .find((job) => job.problemId === "hello-world");
  if (!job) throw new Error("Missing job");
  const stack = JSON.parse(job.unit ?? "{}").stackName as string;
  return f.request(
    "/portal/me/submit-flag",
    "POST",
    { problemId: "hello-world", flag: fakeFlag(stack) },
    team.teamLoginKey,
    nonce,
  );
}

test("HTTP gate configuration, participant metadata, access, bonus, isolation and real SQLite reopen", async () => {
  const f = await fixture(),
    event = await f.create(),
    other = await f.create("other");
  const a = alpha(event),
    b = beta(event),
    path = `/events/${event.eventId}/progression-gate`;
  expect((await f.request(path, "PUT", configuration)).status).toBe(409);
  await f.flag(true);
  expect((await f.request(path, "PUT", configuration)).status).toBe(200);
  await f.request(`/events/${other.eventId}/progression-gate`, "PUT", configuration);
  const locked = await f.request("/portal/me", "GET", undefined, a.teamLoginKey);
  expect(progression(locked.body)).toMatchObject({
    gateCompleted: false,
    lockedProblemIds: ["ac26-crypto-battle"],
  });
  const battle = problems(locked.body).find((p) => p.problemId === "ac26-crypto-battle");
  expect(battle?.instructions).toBe("");
  expect(battle?.scoring).toBeUndefined();
  expect(battle?.i18n).toBeUndefined();
  for (const [route, method, body] of [
    ["/portal/me/coordination/projection", "GET", undefined],
    ["/portal/me/coordination/op", "POST", { op: { kind: "ready" } }],
    ["/portal/me/submit-flag", "POST", { problemId: "ac26-crypto-battle", flag: "x" }],
    ["/portal/me/problems/ac26-crypto-battle/hints/one/reveal", "POST", {}],
  ] as const) {
    const blocked = await f.request(route, method, body, a.teamLoginKey);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("challenge_prerequisite_not_met");
  }
  const solved = await solve(f, event, "gate-solve-0001");
  expect(solved.status).toBe(200);
  expect(solved.body.totalScore).toBe(150);
  expect(f.store.team(a.teamId).score).toBe(150);
  expect(
    progression((await f.request("/portal/me", "GET", undefined, a.teamLoginKey)).body)
      .gateCompleted,
  ).toBe(true);
  expect(
    progression((await f.request("/portal/me", "GET", undefined, b.teamLoginKey)).body)
      .gateCompleted,
  ).toBe(false);
  expect(
    progression((await f.request("/portal/me", "GET", undefined, alpha(other).teamLoginKey)).body)
      .gateCompleted,
  ).toBe(false);
  expect(
    (await f.request("/portal/me/coordination/projection", "GET", undefined, a.teamLoginKey))
      .status,
  ).toBe(200);
  await f.request(path, "DELETE");
  await f.request(path, "PUT", { ...configuration, completionBonus: 900 });
  await f.flag(false);
  expect((await f.request(path)).body.progressionGate).toMatchObject({ completionBonus: 900 });
  expect((await f.request(path, "DELETE")).status).toBe(409);
  expect((await f.request(path, "PUT", configuration)).status).toBe(409);
  expect(
    (await f.request("/portal/me/coordination/projection", "GET", undefined, b.teamLoginKey))
      .status,
  ).toBe(200);
  await f.flag(true);
  await f.restart();
  expect(f.store.team(a.teamId).score).toBe(150);
  expect(f.store.team(a.teamId).scoreEvents.filter((e) => e.source === "gate_bonus")).toHaveLength(
    1,
  );
  expect(
    progression((await f.request("/portal/me", "GET", undefined, a.teamLoginKey)).body)
      .gateCompleted,
  ).toBe(true);
  expect((await solve(f, event, "gate-solve-0001")).status).toBe(200);
  expect(f.store.team(a.teamId).score).toBe(150);
});

test("OFF completion and config removal retain event/team/problem ledger across redeployment", async () => {
  const f = await fixture(),
    event = await f.create(),
    a = alpha(event),
    path = `/events/${event.eventId}/progression-gate`;
  await f.flag(true);
  await f.request(path, "PUT", configuration);
  await f.flag(false);
  await solve(f, event);
  expect(f.store.team(a.teamId).score).toBe(100);
  await f.flag(true);
  expect(f.store.team(a.teamId).score).toBe(150);
  const job = f.store.jobs(event.eventId, a.teamId).find((j) => j.problemId === "hello-world");
  if (!job) throw new Error("Missing job");
  await f.request(`/events/${event.eventId}/deployments/${job.jobId}`, "DELETE");
  await f.service.drain();
  await f.request(`/events/${event.eventId}/deployments/${job.jobId}/restart`, "POST", {});
  await f.service.drain();
  await f.request(path, "DELETE");
  await f.restart();
  await f.request(path, "PUT", configuration);
  expect(
    progression((await f.request("/portal/me", "GET", undefined, a.teamLoginKey)).body)
      .gateCompleted,
  ).toBe(true);
  expect(f.store.team(a.teamId).score).toBe(150);
});

test("stored malformed and cross-event configs fail closed; OFF still allows Admin repair", async () => {
  const f = await fixture(),
    event = await f.create(),
    other = await f.create("other");
  await f.flag(true);
  expect(
    (
      await f.request(`/events/${event.eventId}/progression-gate`, "PUT", {
        ...configuration,
        teamOverrides: { [alpha(other).teamId]: { policy: "off" } },
      })
    ).status,
  ).toBe(400);
  const stored = f.store.event(event.eventId);
  f.store.statement("UPDATE host_events SET body=? WHERE id=?").run(
    JSON.stringify({
      ...stored,
      progressionGate: { ...configuration, defaultPolicy: "invalid" },
    }),
    event.eventId,
  );
  expect((await f.request("/portal/me", "GET", undefined, alpha(event).teamLoginKey)).status).toBe(
    503,
  );
  expect((await solve(f, event)).status).toBe(503);
  await f.restart();
  expect((await f.request("/portal/me", "GET", undefined, alpha(event).teamLoginKey)).status).toBe(
    503,
  );
  const detail = await f.request(`/events/${event.eventId}`);
  expect(detail.body.progressionGateError).toBe("invalid_progression_gate");
  expect(detail.body.progressionGate).toBeUndefined();
  await f.flag(false);
  expect((await f.request("/portal/me", "GET", undefined, alpha(event).teamLoginKey)).status).toBe(
    200,
  );
  expect((await f.flag(true)).status).toBe(200);
  expect(
    (await f.request(`/events/${event.eventId}/progression-gate`, "PUT", configuration)).status,
  ).toBe(200);
});

test("metadata and flag/hint scoring revalidate gate after asynchronous runtime boundaries", async () => {
  const f = await fixture(),
    event = await f.create(),
    a = alpha(event);
  await f.flag(true);
  const reverse = {
    ...configuration,
    gateProblemId: "ac26-crypto-battle",
    unlockTargetIds: ["hello-world"],
  };
  const view = f.engine.view.bind(f.engine);
  f.engine.view = async (context) => {
    const result = await view(context);
    f.store.putEvent({ ...f.store.event(event.eventId), progressionGate: reverse as never });
    return result;
  };
  const me = await f.request("/portal/me", "GET", undefined, a.teamLoginKey);
  expect(problems(me.body).find((p) => p.problemId === "hello-world")?.stackOutputs).toEqual({});
  expect(problems(me.body).find((p) => p.problemId === "hello-world")?.instructions).toBe("");
  f.engine.view = view;
  await f.request(`/events/${event.eventId}/progression-gate`, "DELETE");
  const submit = f.engine.submit.bind(f.engine);
  f.engine.submit = async (context, body) => {
    const result = await submit(context, body);
    f.store.putEvent({ ...f.store.event(event.eventId), progressionGate: reverse as never });
    return result;
  };
  expect((await solve(f, event)).status).toBe(409);
  expect(f.store.team(a.teamId).score).toBe(0);
  f.engine.submit = submit;
  await f.request(`/events/${event.eventId}/progression-gate`, "DELETE");
  const hint = f.engine.hint.bind(f.engine);
  f.engine.hint = async (context, problemId, hintId) => {
    const result = await hint(context, problemId, hintId);
    f.store.putEvent({ ...f.store.event(event.eventId), progressionGate: reverse as never });
    return result;
  };
  const result = await f.request(
    "/portal/me/problems/hello-world/hints/hint-1/reveal",
    "POST",
    {},
    a.teamLoginKey,
  );
  expect(result.status).toBe(409);
  expect(f.store.team(a.teamId).score).toBe(0);
});

test("enabling the gate during an awaited scorer never loses the newly committed bonus", async () => {
  const f = await fixture(),
    event = await f.create(),
    a = alpha(event);
  await f.flag(true);
  await f.request(`/events/${event.eventId}/progression-gate`, "PUT", configuration);
  await f.flag(false);
  await solve(f, event);
  const waiting = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const submit = f.engine.submit.bind(f.engine);
  f.engine.submit = async (context, body) => {
    const result = await submit(context, body);
    entered.resolve(undefined);
    await waiting.promise;
    return result;
  };
  const inFlight = solve(f, event);
  await entered.promise;
  expect((await f.flag(true)).status).toBe(200);
  waiting.resolve(undefined);
  expect((await inFlight).body.error).toBe("scoring_state_changed");
  expect(f.store.team(a.teamId).score).toBe(150);
  expect(f.store.team(a.teamId).scoreEvents.filter((e) => e.source === "gate_bonus")).toHaveLength(
    1,
  );
});

test("hint receipts cannot disclose a reveal after the problem becomes locked", async () => {
  const f = await fixture(),
    event = await f.create(),
    a = alpha(event);
  const path = "/portal/me/problems/hello-world/hints/hint-1/reveal";
  const first = await f.request(path, "POST", {}, a.teamLoginKey, "hint-receipt-0001");
  expect(first.status).toBe(200);
  await f.flag(true);
  await f.request(`/events/${event.eventId}/progression-gate`, "PUT", {
    ...configuration,
    gateProblemId: "ac26-crypto-battle",
    unlockTargetIds: ["hello-world"],
  });
  const replay = await f.request(path, "POST", {}, a.teamLoginKey, "hint-receipt-0001");
  expect(replay.status).toBe(409);
  expect(replay.body.error).toBe("challenge_prerequisite_not_met");
});

test("a score and its gate bonus roll back together if the bonus write fails", async () => {
  const f = await fixture(),
    event = await f.create(),
    a = alpha(event);
  await f.flag(true);
  await f.request(`/events/${event.eventId}/progression-gate`, "PUT", configuration);
  const put = f.store.putTeam.bind(f.store);
  f.store.putTeam = (team) => {
    if (team.scoreEvents.some((each) => each.source === "gate_bonus"))
      throw new Error("Injected SQLite write failure");
    put(team);
  };
  expect((await solve(f, event)).status).toBe(500);
  expect(f.store.team(a.teamId).score).toBe(0);
  expect(
    progression((await f.request("/portal/me", "GET", undefined, a.teamLoginKey)).body)
      .gateCompleted,
  ).toBe(false);
  f.store.putTeam = put;
  expect((await solve(f, event)).status).toBe(200);
  expect(f.store.team(a.teamId).score).toBe(150);
});

test("zero bonus is settled once, and team policy override opens only that team", async () => {
  const f = await fixture(),
    event = await f.create(),
    a = alpha(event),
    b = beta(event);
  await f.flag(true);
  const config = {
    ...configuration,
    completionBonus: 0,
    teamOverrides: { [b.teamId]: { policy: "off" } },
  };
  await f.request(`/events/${event.eventId}/progression-gate`, "PUT", config);
  expect(
    (await f.request("/portal/me/coordination/projection", "GET", undefined, b.teamLoginKey))
      .status,
  ).toBe(200);
  expect(
    (await f.request("/portal/me/coordination/projection", "GET", undefined, a.teamLoginKey))
      .status,
  ).toBe(409);
  await solve(f, event);
  await f.request(`/events/${event.eventId}/progression-gate`, "PUT", {
    ...config,
    completionBonus: 50,
  });
  expect(f.store.team(a.teamId).score).toBe(100);
  await f.restart();
  expect(f.store.team(a.teamId).score).toBe(100);
});

test("automatic Battle scoring skips locked teams without a later catch-up award", async () => {
  const f = await fixture();
  f.engine.coordinationPlugin = () => ({
    initialState: (ctx) => Object.fromEntries(ctx.teamIds.map((id) => [id, 0])),
    tickOnRequest: true,
    tick: (state) =>
      Object.fromEntries(
        Object.entries(state as Record<string, number>).map(([id, value]) => [id, value + 10]),
      ),
    validateOp: () => ({ ok: true }),
    applyOp: (state) => state,
    projectForTeam: (state, teamId) => ({ score: (state as Record<string, number>)[teamId] }),
    teamScores: (state) => state as Record<string, number>,
  });
  const event = await f.create(),
    a = alpha(event),
    b = beta(event);
  await f.flag(true);
  await f.request(`/events/${event.eventId}/progression-gate`, "PUT", {
    ...configuration,
    teamOverrides: { [b.teamId]: { policy: "off" } },
  });
  await f.request("/portal/me", "GET", undefined, a.teamLoginKey);
  expect(f.store.team(a.teamId).score).toBe(0);
  expect(f.store.team(b.teamId).score).toBe(10);
  await f.flag(false);
  await f.request("/portal/me", "GET", undefined, a.teamLoginKey);
  expect(f.store.team(a.teamId).score).toBe(10);
  expect(f.store.team(b.teamId).score).toBe(20);
  await f.flag(true);
  await f.request("/portal/me", "GET", undefined, a.teamLoginKey);
  expect(f.store.team(a.teamId).score).toBe(10);
  expect(f.store.team(b.teamId).score).toBe(30);
});
