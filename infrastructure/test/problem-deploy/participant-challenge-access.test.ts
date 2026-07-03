import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProgressionView,
  clearTenantFlagCacheForTest,
  getPrerequisiteBlock,
  getPrerequisiteBlockByEventId,
  isProblemSolvedForWriteup,
  releaseSolvedWriteups,
} from "../../lib/problem-deploy/handlers/participant-handler/challenge-access";
import type { EventGate } from "../../lib/problem-deploy/handlers/participant-handler/event-gate";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

/**
 * Issue #2283: challenge access 判定の単一箇所 (participant 側 enforcement)。
 * flag OFF (既定) で全許可 / required team の lock / off team の bypass / 完了後の unlock を
 * 検証する。 DDB は tenant FLAGS 行の GetCommand (+ byEventId 経路の event GET) だけ読む。
 */

const send = vi.fn();
const shared = {
  ddb: { send },
  tableName: "TestDeployments",
  eventsTableName: "TestEvents",
} as unknown as ParticipantSharedResources;

const config = {
  gateProblemId: "hello-world-battle",
  unlockTargetIds: ["stackstack-battle"],
  defaultPolicy: "required" as const,
  teamOverrides: { "team-adv": { policy: "off" as const, completionBonus: 0 } },
};

const gate: EventGate = {
  scoringLocked: false,
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: undefined,
  status: "READY",
  scoreboardFreezeMinutes: undefined,
  progressionGate: config,
};

const teamItems = (over: { gateScore?: number; teamId?: string; flagSubmitted?: boolean }) => [
  {
    PK: "DEPLOYMENT#job-gate",
    problemId: "hello-world-battle",
    tenantId: "tenant-test",
    teamId: over.teamId ?? "team-beginner",
    score: over.gateScore ?? 0,
    flagSubmitted: over.flagSubmitted,
  },
  {
    PK: "DEPLOYMENT#job-target",
    problemId: "stackstack-battle",
    tenantId: "tenant-test",
    teamId: over.teamId ?? "team-beginner",
    score: 0,
  },
];

function mockFlags(flags: Record<string, boolean> | "error") {
  send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetCommand && cmd.input.Key?.SK === "FLAGS") {
      if (flags === "error") return Promise.reject(new Error("ddb boom"));
      return Promise.resolve({ Item: { flags } });
    }
    if (cmd instanceof GetCommand && cmd.input.Key?.SK === "META") {
      return Promise.resolve({
        Item: { status: "READY", startsAt: "2026-01-01T00:00:00.000Z", progressionGate: config },
      });
    }
    throw new Error("unexpected command");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // module-level の tenant flag TTL cache を破棄 (テスト間で ON/OFF が漏れないように)。
  clearTenantFlagCacheForTest();
});

describe("getPrerequisiteBlock", () => {
  it("should block a locked target for a required team when the flag is ON", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0 }),
      "stackstack-battle",
      gate,
    );

    expect(block).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should allow everything when the tenant flag is OFF (default), even with a stored config", async () => {
    mockFlags({});

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0 }),
      "stackstack-battle",
      gate,
    );

    expect(block).toBeUndefined();
  });

  it("should allow when no progression gate is configured on the event", async () => {
    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0 }),
      "stackstack-battle",
      { ...gate, progressionGate: undefined },
    );

    expect(block).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("should allow the gate challenge itself (only unlock targets are locked)", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0 }),
      "hello-world-battle",
      gate,
    );

    expect(block).toBeUndefined();
    // 無料判定で落ちるので flag の DDB read も発生しない。
    expect(send).not.toHaveBeenCalled();
  });

  it("should unlock the target after the gate is completed (score > 0)", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 100 }),
      "stackstack-battle",
      gate,
    );

    expect(block).toBeUndefined();
  });

  it("should unlock the target for a flag-kind gate after flagSubmitted", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0, flagSubmitted: true }),
      "stackstack-battle",
      gate,
    );

    expect(block).toBeUndefined();
  });

  it("should bypass the gate for a team whose override policy is off", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0, teamId: "team-adv" }),
      "stackstack-battle",
      gate,
    );

    expect(block).toBeUndefined();
  });

  it("should allow (flag OFF fallback) when the flag read fails", async () => {
    mockFlags("error");

    const block = await getPrerequisiteBlock(
      shared,
      teamItems({ gateScore: 0 }),
      "stackstack-battle",
      gate,
    );

    expect(block).toBeUndefined();
  });

  it("should ignore stale DELETED gate rows when judging completion (live row wins)", async () => {
    mockFlags({ challengePrerequisiteGate: true });
    // 旧 (完了済) の DELETED 行 + 未完了の live 行: 完了判定は live 行で行う → locked。
    const items = [
      {
        PK: "DEPLOYMENT#job-gate-old",
        problemId: "hello-world-battle",
        tenantId: "tenant-test",
        teamId: "team-beginner",
        status: "DELETED",
        score: 999,
      },
      ...teamItems({ gateScore: 0 }),
    ];

    const block = await getPrerequisiteBlock(shared, items, "stackstack-battle", gate);

    expect(block).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should keep the target unlocked after a completed gate is torn down (latch on DELETED row)", async () => {
    mockFlags({ challengePrerequisiteGate: true });
    // 完了済 Gate を teardown した状態: Gate 行は DELETED で gateCompletedAt 済、 live 行なし。
    // durable latch を拾って unlock を維持する (= teardown で unlock target を再 lock しない)。
    const items = [
      {
        PK: "DEPLOYMENT#job-gate-done",
        problemId: "hello-world-battle",
        tenantId: "tenant-test",
        teamId: "team-beginner",
        status: "DELETED",
        score: 0,
        gateCompletedAt: "2026-07-02T00:00:00.000Z",
      },
      {
        PK: "DEPLOYMENT#job-target",
        problemId: "stackstack-battle",
        tenantId: "tenant-test",
        teamId: "team-beginner",
        score: 0,
      },
    ];

    const block = await getPrerequisiteBlock(shared, items, "stackstack-battle", gate);

    expect(block).toBeUndefined();
  });

  it("should treat a latched gateCompletedAt as completed even at score 0", async () => {
    mockFlags({ challengePrerequisiteGate: true });
    const items = teamItems({ gateScore: 0 }).map((i) =>
      i.problemId === "hello-world-battle"
        ? { ...i, gateCompletedAt: "2026-07-02T00:00:00.000Z" }
        : i,
    );

    const block = await getPrerequisiteBlock(shared, items, "stackstack-battle", gate);

    expect(block).toBeUndefined();
  });
});

describe("getPrerequisiteBlockByEventId", () => {
  it("should fetch the event gate itself and block a locked target", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const block = await getPrerequisiteBlockByEventId(
      shared,
      teamItems({ gateScore: 0 }),
      "stackstack-battle",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );

    expect(block).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should allow legacy deployments without an eventId", async () => {
    const block = await getPrerequisiteBlockByEventId(
      shared,
      teamItems({ gateScore: 0 }),
      "stackstack-battle",
      undefined,
    );

    expect(block).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("buildProgressionView", () => {
  it("should describe locked targets and policy for a required team", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const view = await buildProgressionView(shared, teamItems({ gateScore: 0 }), gate);

    expect(view).toEqual({
      gateProblemId: "hello-world-battle",
      gateCompleted: false,
      policy: "required",
      completionBonus: 0,
      lockedProblemIds: ["stackstack-battle"],
    });
  });

  it("should report gateCompleted with an empty locked list after first points", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const view = await buildProgressionView(shared, teamItems({ gateScore: 100 }), gate);

    expect(view).toMatchObject({ gateCompleted: true, lockedProblemIds: [] });
  });

  it("should expose the off policy with nothing locked for a bypass team", async () => {
    mockFlags({ challengePrerequisiteGate: true });

    const view = await buildProgressionView(
      shared,
      teamItems({ gateScore: 0, teamId: "team-adv" }),
      gate,
    );

    expect(view).toMatchObject({ policy: "off", lockedProblemIds: [] });
  });

  it("should be undefined when the tenant flag is OFF (wire shape unchanged)", async () => {
    mockFlags({});
    expect(await buildProgressionView(shared, teamItems({ gateScore: 0 }), gate)).toBeUndefined();
  });

  it("should be undefined when the event has no gate config", async () => {
    expect(
      await buildProgressionView(shared, teamItems({ gateScore: 0 }), {
        ...gate,
        progressionGate: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("writeup release policy (#2191)", () => {
  const problem = {
    jobId: "job-sqli",
    problemId: "sqli-demo",
    region: "ap-northeast-1",
    awsAccountId: "123456789012",
    status: "COMPLETE" as const,
    stackOutputs: {},
    expiresAt: 0,
    score: 100,
    deployLog: { cursor: "", entries: [] },
    scoring: { kind: "flag" as const, points: 100, flagSubmitted: true },
  };
  const writeups = {
    "sqli-demo": { ja: "JA explanation", en: "EN explanation" },
  };

  it("never releases a writeup while the cloud event is running", () => {
    const problems = [problem];
    expect(releaseSolvedWriteups(problems, writeups, false)).toBe(problems);
    expect(releaseSolvedWriteups(problems, writeups, false)[0]).not.toHaveProperty("writeup");
  });

  it("releases both locales after event end only for a solved problem", () => {
    const released = releaseSolvedWriteups([problem], writeups, true);
    expect(released[0]).toMatchObject({
      writeup: "JA explanation",
      i18n: { en: { writeup: "EN explanation" } },
    });

    const unsolved = { ...problem, scoring: { ...problem.scoring, flagSubmitted: false } };
    expect(releaseSolvedWriteups([unsolved], writeups, true)[0]).not.toHaveProperty("writeup");
  });

  it("requires all multi-flag checkpoints to be solved", () => {
    expect(
      isProblemSolvedForWriteup({
        ...problem,
        scoring: {
          kind: "multi-flag",
          points: 200,
          flags: [
            { id: "a", label: "A", points: 100, solved: true },
            { id: "b", label: "B", points: 100, solved: false },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isProblemSolvedForWriteup({
        ...problem,
        scoring: {
          kind: "multi-flag",
          points: 200,
          flags: [
            { id: "a", label: "A", points: 100, solved: true },
            { id: "b", label: "B", points: 100, solved: true },
          ],
        },
      }),
    ).toBe(true);
  });
});
