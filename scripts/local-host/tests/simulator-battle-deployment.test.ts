import { expect, test } from "bun:test";
import {
  type BattleDeploymentIO,
  rehearseBattleDeployment,
} from "../integration/simulator-battle-deployment";

function scenario(
  options: {
    existingAccount?: boolean;
    failedVerify?: boolean;
    lostRegistration?: boolean;
    lostDeploy?: boolean;
    foreign?: boolean;
    changedCleanup?: boolean;
    failedCleanup?: boolean;
    lostCreate?: boolean;
  } = {},
) {
  let time = 0;
  let deleted = false;
  let stops = 0;
  const calls: string[] = [];
  const teams = [
    { teamId: "alpha", teamLoginKey: "key-alpha" },
    { teamId: "beta", teamLoginKey: "key-beta" },
  ];
  const jobView = () => {
    const deletedStatus = options.failedCleanup ? "FAILED" : "DELETED";
    return {
      deploymentsByProblem: {
        "hello-world-battle": teams.map((t) => ({
          teamId: options.foreign && !deleted ? "foreign" : t.teamId,
          jobId: `${t.teamId}-${options.changedCleanup && deleted ? "changed" : "job"}`,
          status: deleted ? deletedStatus : "COMPLETE",
        })),
      },
    };
  };
  const accountResponse = (path: string, method: string) => {
    if (method === "GET") return { items: options.existingAccount ? [{}] : [] };
    if (path.endsWith("/verify"))
      return { awsAccountId: "000000000000", verified: !options.failedVerify };
    if (options.lostRegistration) throw new Error("registration response lost");
    return { awsAccountId: "000000000000" };
  };
  const createEvent = () => {
    if (options.lostCreate) throw new Error("create response lost");
    return { eventId: "owned", teams };
  };
  const io: BattleDeploymentIO = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    async request(_origin, path, _token, method) {
      calls.push(`${method} ${path}`);
      if (path === "/host/login") return { idToken: "organizer" };
      if (path.startsWith("/admin/competitor-accounts")) return accountResponse(path, method);
      if (path === "/events") return createEvent();
      if (path.endsWith("/deploy")) {
        if (options.lostDeploy) throw new Error("deploy response lost");
        return {};
      }
      if (method === "DELETE") {
        deleted = true;
        return {};
      }
      return jobView();
    },
  };
  const fixture = {
    ownedLocalState: true as const,
    host: {
      adminOrigin: "http://127.0.0.1:9001",
      participantOrigin: "http://127.0.0.1:9002",
      organizerKey: "key",
    },
    stop: async () => {
      stops++;
    },
  };
  return { io, fixture, calls, stops: () => stops };
}
test("new production-route lifecycle observes two jobs, callback then owned cleanup", async () => {
  const f = scenario();
  const result = await rehearseBattleDeployment(f.fixture, f.io, async (round) => {
    expect(round.teams.map((t) => t.jobId)).toEqual(["alpha-job", "beta-job"]);
    expect(f.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });
  expect(result.acceptancePassed).toBe(false);
  expect(result.runtimeCleanupVerified).toBe(false);
  expect(f.calls.filter((c) => c.endsWith("/deploy"))).toHaveLength(1);
  expect(f.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /events/owned"]);
  expect(f.stops()).toBe(1);
});
test("ambiguous deploy is never retried and owned event is cleaned", async () => {
  const f = scenario({ lostDeploy: true });
  await expect(rehearseBattleDeployment(f.fixture, f.io)).rejects.toThrow("incomplete");
  expect(f.calls.filter((c) => c.endsWith("/deploy"))).toHaveLength(1);
  expect(f.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
  expect(f.stops()).toBe(1);
});
test("unknown create never triggers a guessed event deletion or retry", async () => {
  const f = scenario({ lostCreate: true });
  await expect(rehearseBattleDeployment(f.fixture, f.io)).rejects.toThrow("incomplete");
  expect(f.calls.filter((c) => c === "POST /events")).toHaveLength(1);
  expect(f.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  expect(f.stops()).toBe(1);
});
test("foreign job blocks observation and still cleans owned event", async () => {
  const f = scenario({ foreign: true });
  let observed = false;
  await expect(
    rehearseBattleDeployment(f.fixture, f.io, async () => {
      observed = true;
    }),
  ).rejects.toThrow("incomplete");
  expect(observed).toBe(false);
  expect(f.stops()).toBe(1);
});
test("observer failure does not skip logical cleanup or fixture stop", async () => {
  const f = scenario();
  await expect(
    rehearseBattleDeployment(f.fixture, f.io, async () => {
      throw new Error("observer");
    }),
  ).rejects.toThrow("incomplete");
  expect(f.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
  expect(f.stops()).toBe(1);
});
for (const option of [{ changedCleanup: true }, { failedCleanup: true }]) {
  test(`unverified cleanup remains failure ${JSON.stringify(option)}`, async () => {
    const f = scenario(option);
    await expect(rehearseBattleDeployment(f.fixture, f.io)).rejects.toThrow("incomplete");
    expect(f.stops()).toBe(1);
  });
}

for (const option of [
  { existingAccount: true },
  { failedVerify: true },
  { lostRegistration: true },
]) {
  test(`account setup fails closed without event or retry ${JSON.stringify(option)}`, async () => {
    const f = scenario(option);
    await expect(rehearseBattleDeployment(f.fixture, f.io)).rejects.toThrow("incomplete");
    expect(f.calls).not.toContain("POST /events");
    expect(f.calls.filter((c) => c === "POST /admin/competitor-accounts").length).toBe(
      option.existingAccount ? 0 : 1,
    );
    expect(f.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(f.stops()).toBe(1);
  });
}
test("account registration and verification precede event creation", async () => {
  const f = scenario();
  await rehearseBattleDeployment(f.fixture, f.io);
  expect(f.calls.slice(0, 5)).toEqual([
    "POST /host/login",
    "GET /admin/competitor-accounts",
    "POST /admin/competitor-accounts",
    "POST /admin/competitor-accounts/000000000000/verify",
    "POST /events",
  ]);
});
