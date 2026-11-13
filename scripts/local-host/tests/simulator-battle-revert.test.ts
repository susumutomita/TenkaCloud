import { expect, test } from "bun:test";
import type { BattleDeploymentIO } from "../integration/simulator-battle-deployment";
import type { BattleRound } from "../integration/simulator-battle-observation";
import {
  observeAutomaticBattleRevert,
  requireOriginalRevertDeclaration,
} from "../integration/simulator-battle-revert";
import { parseBattleRehearsalOptions } from "../integration/simulator-battle-selection";

const start = Date.parse("2026-11-12T07:00:00Z");
const due = start + 600_000;
const iso = (n: number) => new Date(n).toISOString();
const round: BattleRound = {
  adminOrigin: "http://127.0.0.1:8001",
  participantOrigin: "http://127.0.0.1:8002",
  organizerToken: "organizer",
  eventId: "event",
  teams: [
    { teamId: "alpha", teamLoginKey: "alpha-key", jobId: "job-alpha" },
    { teamId: "beta", teamLoginKey: "beta-key", jobId: "job-beta" },
  ],
};
interface Options {
  deadline?: number;
  transition?: Record<string, unknown>;
  targetTeamIds?: string[];
  staleHealth?: boolean;
  staleScore?: boolean;
  foreignScore?: boolean;
  peerLoss?: boolean;
  earlyHealthy?: boolean;
  timeout?: boolean;
  delayedFinalScore?: boolean;
}
function audit(now: number, initial: boolean, o: Options) {
  const status = now >= due && !o.timeout ? "revert_command_completed" : "revert_due";
  return {
    items: [
      {
        requestId: "request-one",
        targetTeamIds: o.targetTeamIds ?? ["alpha"],
        executions: [
          {
            id: "execution-one",
            teamId: "alpha",
            status,
            revertAt: iso(o.deadline ?? due),
            updatedAt: iso(due),
            ...(!initial ? o.transition : {}),
          },
        ],
      },
    ],
  };
}
function health(now: number, token: string, o: Options) {
  const isPeer = token === "beta-key";
  const recovered = (now >= due && !o.timeout) || o.earlyHealthy;
  const ok = isPeer ? !(o.peerLoss && now >= due) : recovered;
  return {
    problems: [
      {
        problemId: "hello-world-battle",
        applicationStatus: {
          overall: ok ? "healthy" : "degraded",
          healthyCount: ok ? 2 : 1,
          totalCount: 2,
          checkedAt: iso(o.staleHealth ? start : now + 1),
        },
      },
    ],
  };
}
function scores(now: number, token: string, o: Options) {
  return {
    entries: [
      {
        jobId: o.foreignScore ? "foreign" : `job-${token.split("-")[0]}`,
        problemId: "hello-world-battle",
        source: "uptime",
        points: 100,
        result: "ok",
        occurredAt: iso(o.staleScore ? due : now + 1),
      },
    ],
  };
}
/** Virtual response timestamps only: these tests do not establish real elapsed-time acceptance. */
function fixture(o: Options = {}) {
  let now = start + 1000;
  let audits = 0;
  const calls: string[] = [];
  const io: BattleDeploymentIO = {
    now: () => now - start,
    sleep: async () => {
      now += 300_000;
    },
    request: async (_origin, path, token, method) => {
      calls.push(path);
      expect(method).toBe("GET");
      if (path.includes("/audit")) return audit(now, audits++ === 0, o);
      if (path.endsWith("/state")) return health(now, token, o);
      if (path.endsWith("/score-events")) {
        const response = scores(now, token, o);
        if (o.delayedFinalScore) now += 300_000;
        return response;
      }
      throw new Error(`Unexpected route: ${path}`);
    },
  };
  return {
    calls,
    run: () => observeAutomaticBattleRevert(round, "request-one", start, io, () => now),
  };
}

test("natural revert observer needs completed command plus fresh exact-job health and scores", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    kind: "natural-revert-command-and-fresh-health-score",
    acceptancePassed: false,
    strictInjectionIntervalProven: false,
    peerContinuity: "sampled",
    revertAt: iso(due),
  });
  expect(f.calls.filter((p) => p.endsWith("/score-events"))).toHaveLength(2);
  expect(f.calls.some((p) => /fire|terminal|credentials/u.test(p))).toBe(false);
});

const failures: [string, Options, string][] = [
  [
    "early completed command",
    { transition: { status: "revert_command_completed" } },
    "Early revert transition",
  ],
  ["shortened failed-injection deadline", { deadline: start + 10_000 }, "Normal pending"],
  ["excessively late deadline", { deadline: start + 900_000 }, "Normal pending"],
  ["foreign target", { targetTeamIds: ["foreign"] }, "ownership mismatch"],
  ["changed execution", { transition: { id: "different" } }, "execution changed"],
  ["changed deadline", { transition: { revertAt: iso(due + 1) } }, "execution changed"],
  ["failed execution", { transition: { status: "failed" } }, "failed or unknown"],
  ["unknown revert", { transition: { status: "recovery_required" } }, "failed or unknown"],
  ["stale health", { staleHealth: true }, "not confirmed"],
  ["stale score", { staleScore: true }, "not confirmed"],
  ["foreign score", { foreignScore: true }, "not confirmed"],
  ["peer health loss", { peerLoss: true }, "Peer health lost"],
  ["manual early recovery", { earlyHealthy: true }, "Unrepaired target"],
  ["pending forever", { timeout: true }, "not confirmed"],
  [
    "final score response exceeds observation deadline",
    { delayedFinalScore: true },
    "not confirmed",
  ],
];
for (const [label, options, message] of failures) {
  test(`reject ${label}`, async () => {
    await expect(fixture(options).run()).rejects.toThrow(message);
  });
}

function declaration(afterSeconds = 600, unavailableReason?: string) {
  return {
    problemId: "hello-world-battle",
    disruption: {
      id: "frontend-down",
      unavailableReason,
      action: { kind: "ssm-run-command", revert: { afterSeconds } },
    },
  };
}
function declarationIO(entries: unknown[]): BattleDeploymentIO {
  return {
    now: () => 0,
    sleep: async () => {
      throw new Error("No sleep expected");
    },
    request: async (origin, path, token, method) => {
      expect([origin, path, token, method]).toEqual([
        round.adminOrigin,
        "/events/event/disruptions",
        "organizer",
        "GET",
      ]);
      return { entries };
    },
  };
}
test("pinned original supported 600-second declaration is required before firing", async () => {
  await expect(
    requireOriginalRevertDeclaration(round, declarationIO([declaration()])),
  ).resolves.toBeUndefined();
  await expect(requireOriginalRevertDeclaration(round, declarationIO([]))).rejects.toThrow();
  await expect(
    requireOriginalRevertDeclaration(round, declarationIO([declaration(), declaration()])),
  ).rejects.toThrow();
  await expect(
    requireOriginalRevertDeclaration(round, declarationIO([declaration(60)])),
  ).rejects.toThrow();
  await expect(
    requireOriginalRevertDeclaration(round, declarationIO([declaration(600, "unsupported")])),
  ).rejects.toThrow();
});

test("other catalog entries do not impose their interval or action on original Battle", async () => {
  const entries = [
    declaration(),
    { ...declaration(30), problemId: "other-problem" },
    { problemId: "other-problem", disruption: { id: "no-action" } },
    {
      problemId: "hello-world-battle",
      disruption: { id: "other-action", action: { kind: "custom" } },
    },
  ];
  await expect(
    requireOriginalRevertDeclaration(round, declarationIO(entries)),
  ).resolves.toBeUndefined();
});

test("automatic revert CLI requires explicit deployment and disruption without manual repair", () => {
  expect(() => parseBattleRehearsalOptions(["--observe-automatic-revert"])).toThrow(
    "Explicit rehearsal",
  );
  expect(() =>
    parseBattleRehearsalOptions(["--run-two-team-deploy", "--observe-automatic-revert"]),
  ).toThrow("Automatic revert requires");
  expect(() =>
    parseBattleRehearsalOptions([
      "--run-two-team-deploy",
      "--observe-disruption",
      "--observe-automatic-revert",
      "--repair-through-participant",
    ]),
  ).toThrow("Automatic revert requires");
  const selected = parseBattleRehearsalOptions([
    "--run-two-team-deploy",
    "--observe-disruption",
    "--observe-automatic-revert",
  ]);
  expect(selected["observe-automatic-revert"]).toBe(true);
  expect(selected["repair-through-participant"]).toBe(false);
  expect(parseBattleRehearsalOptions(["--run-two-team-deploy"])["observe-automatic-revert"]).toBe(
    false,
  );
});
