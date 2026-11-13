import { expect, test } from "bun:test";
import type { BattleDeploymentIO } from "../integration/simulator-battle-deployment";
import {
  type BattleRound,
  observeBattleDisruption,
  observeHealthyBattle,
} from "../integration/simulator-battle-observation";

const round: BattleRound = {
  adminOrigin: "http://127.0.0.1:8011",
  participantOrigin: "http://127.0.0.1:8012",
  organizerToken: "organizer",
  eventId: "event",
  teams: [
    { teamId: "alpha", jobId: "job-alpha", teamLoginKey: "alpha-key" },
    { teamId: "beta", jobId: "job-beta", teamLoginKey: "beta-key" },
  ],
};
const epoch = Date.parse("2026-11-12T17:00:00Z");
const stamp = (n: number) => new Date(epoch + n).toISOString();
interface Options {
  unknownBaseline?: boolean;
  clock?: "stale" | "backward";
  foreignEndpoint?: boolean;
  foreignJob?: boolean;
  staleScore?: boolean;
  unseenOldScore?: boolean;
  futureScore?: boolean;
  fireError?: boolean;
  foreignReceipt?: boolean;
  foreignAudit?: boolean;
  delayed?: boolean;
}
interface Call {
  path: string;
  token: string;
  method: string;
  body: unknown;
}
function state(active: boolean, disrupted: boolean, token: string, o: Options) {
  const loss = active && disrupted && token === "alpha-key";
  if (!active && o.unknownBaseline)
    return {
      problems: [
        {
          problemId: "hello-world-battle",
          applicationStatus: { overall: "unknown", healthyCount: 0, totalCount: 0 },
        },
      ],
    };
  const checked = { stale: 0, backward: -1000 }[o.clock ?? "stale"];
  const observedAt = o.clock ? checked : 1000;
  return {
    problems: [
      {
        problemId: "hello-world-battle",
        applicationStatus: {
          overall: loss ? "degraded" : "healthy",
          healthyCount: loss ? 1 : 2,
          totalCount: 2,
          checkedAt: stamp(active ? observedAt : 0),
        },
      },
    ],
  };
}
function scoreTime(active: boolean, o: Options) {
  if (!active || o.staleScore) return stamp(0);
  if (o.unseenOldScore) return stamp(-1000);
  if (o.futureScore) return stamp(2000);
  return stamp(1000);
}
function scores(active: boolean, disrupted: boolean, token: string, o: Options) {
  const loss = active && disrupted && token === "alpha-key";
  return {
    entries: [
      {
        jobId: o.foreignJob ? "foreign" : `job-${token.split("-")[0]}`,
        problemId: "hello-world-battle",
        source: "uptime",
        points: loss ? -100 : 100,
        result: loss ? "wrong" : "ok",
        occurredAt: scoreTime(active, o),
      },
    ],
  };
}
function endpoints(token: string, o: Options) {
  return {
    teamId: o.foreignEndpoint ? "foreign" : token.split("-")[0],
    endpoints: ["frontend", "api"].map((slot) => ({
      slot,
      registrationLocator: { kind: "simulator", url: `simulator://${token}/${slot}` },
    })),
  };
}
function readResponse(
  path: string,
  active: boolean,
  disrupted: boolean,
  token: string,
  o: Options,
) {
  if (path.endsWith("/schedule")) return {};
  if (path.endsWith("/state")) return state(active, disrupted, token, o);
  if (path.endsWith("/endpoints")) return endpoints(token, o);
  return undefined;
}
function effectResponse(path: string, o: Options) {
  if (path.endsWith("/fire")) {
    if (o.fireError) throw new Error("Ambiguous transport loss");
    return { status: "accepted", affectedTeamIds: [o.foreignReceipt ? "foreign" : "alpha"] };
  }
  if (path.includes("/audit"))
    return {
      items: [
        {
          requestId: "request-one",
          targetTeamIds: ["alpha"],
          executions: [{ teamId: o.foreignAudit ? "foreign" : "alpha", status: "revert_due" }],
        },
      ],
    };
  return undefined;
}
function fixture(o: Options = {}) {
  let active = false,
    disrupted = false,
    now = 0;
  const calls: Call[] = [];
  const io: BattleDeploymentIO = {
    now: () => now,
    sleep: async () => {
      now += 120_000;
    },
    request: async (origin, path, token, method, body) => {
      expect([round.adminOrigin, round.participantOrigin]).toContain(origin);
      calls.push({ path, token, method, body });
      const read = readResponse(path, active, disrupted, token, o);
      if (read !== undefined) return read;
      if (path.endsWith("/score-events")) {
        const response = scores(active, disrupted, token, o);
        if (active && o.delayed) now += 240_000;
        return response;
      }
      if (/\/endpoints\/(frontend|api)$/u.test(path)) {
        active = true;
        return {};
      }
      const result = effectResponse(path, o);
      if (path.endsWith("/fire")) {
        active = true;
        disrupted = true;
      }
      if (result !== undefined) return result;
      throw new Error(`Unexpected route ${path}`);
    },
  };
  return {
    calls,
    healthy: () => observeHealthyBattle(round, io, () => epoch),
    disrupt: () => observeBattleDisruption(round, "request-one", io, () => epoch),
    io,
  };
}
test("healthy observer registers only owned server locators and requires fresh scores", async () => {
  const f = fixture();
  expect(await f.healthy()).toMatchObject({
    endpointHealthObserved: true,
    scoringObserved: true,
    acceptancePassed: false,
  });
  const registrations = f.calls.filter((c) => c.method === "POST");
  expect(registrations).toHaveLength(4);
  for (const c of registrations) {
    const slot = c.path.split("/").at(-1);
    expect(c.body).toEqual({ url: `simulator://${c.token}/${slot}` });
  }
  expect(f.calls[0]).toMatchObject({
    path: "/events/event/schedule",
    token: "organizer",
    method: "PATCH",
    body: { startNow: true },
  });
});
for (const [label, options] of [
  ["stale observation", { clock: "stale" }],
  ["backward observation", { clock: "backward" }],
  ["foreign score job", { foreignJob: true }],
  ["stale score", { staleScore: true }],
  ["post-I/O timeout", { delayed: true }],
] as const) {
  test(`healthy observer rejects ${label}`, async () => {
    await expect(fixture(options).healthy()).rejects.toThrow("not confirmed");
  });
}
test("foreign endpoint team blocks registration", async () => {
  const f = fixture({ foreignEndpoint: true });
  await expect(f.healthy()).rejects.toThrow("Owned original endpoint");
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});
test("disruption is fired once and verifies target loss with healthy peer", async () => {
  const f = fixture();
  expect(await f.disrupt()).toMatchObject({
    kind: "target-score-loss-peer-healthy",
    acceptancePassed: false,
    automaticRevertVerified: false,
  });
  const fires = f.calls.filter((c) => c.path.endsWith("/fire"));
  expect(fires).toHaveLength(1);
  expect(fires[0]?.body).toMatchObject({
    requestId: "request-one",
    targetTeamIds: ["alpha"],
    scope: "team",
  });
});
for (const [label, options, message] of [
  ["ambiguous fire", { fireError: true }, "Ambiguous transport loss"],
  ["foreign receipt", { foreignReceipt: true }, "Unexpected disruption targets"],
  ["foreign audit", { foreignAudit: true }, "ownership mismatch"],
  ["delayed final I/O", { delayed: true }, "not confirmed"],
] as const) {
  test(`disruption rejects ${label} without retrying fire`, async () => {
    const f = fixture(options);
    await expect(f.disrupt()).rejects.toThrow(message);
    expect(f.calls.filter((c) => c.path.endsWith("/fire"))).toHaveLength(1);
  });
}
test("duplicate owned job identity fails before side effects", async () => {
  const f = fixture();
  const teams = round.teams.map((t) => ({ ...t, jobId: "same-job" }));
  await expect(observeHealthyBattle({ ...round, teams }, f.io)).rejects.toThrow("distinct owned");
  expect(f.calls).toHaveLength(0);
});

for (const options of [{ unseenOldScore: true }, { futureScore: true }]) {
  test(`healthy rejects uncorrelated score ${JSON.stringify(options)}`, async () => {
    await expect(fixture(options).healthy()).rejects.toThrow("not confirmed");
  });
  test(`disruption rejects uncorrelated score ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await expect(f.disrupt()).rejects.toThrow("not confirmed");
    expect(f.calls.filter((c) => c.path.endsWith("/fire"))).toHaveLength(1);
  });
}

test("healthy permits actual production unknown baseline before registration", async () => {
  expect(await fixture({ unknownBaseline: true }).healthy()).toMatchObject({
    scoringObserved: true,
    acceptancePassed: false,
  });
});
test("disruption refuses unknown baseline before firing", async () => {
  const f = fixture({ unknownBaseline: true });
  await expect(f.disrupt()).rejects.toThrow("observed baseline");
  expect(f.calls.filter((c) => c.path.endsWith("/fire"))).toHaveLength(0);
});
