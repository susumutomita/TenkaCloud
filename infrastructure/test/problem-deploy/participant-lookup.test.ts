import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTargetAccessCapability } from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-access";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

function buildShared(scoring: ParticipantSharedResources["problemsScoring"] = {}): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: scoring,
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#JOB1",
  SK: "META",
  GSI2PK: "TEAMKEY#KEY1",
  GSI2SK: "2026-05-04T15:00:00.000Z",
  jobId: "JOB1",
  problemId: "security-battle-royale",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-security-battle-royale-alpha",
  teamLoginKey: "SECRET_DO_NOT_LEAK",
  status: "COMPLETE",
  createdAt: "2026-05-04T15:00:00.000Z",
  updatedAt: "2026-05-04T15:01:00.000Z",
  expiresAt: 1_700_000_000,
  stackOutputs: JSON.stringify({ FrontendUrl: "https://x.example.com" }),
  ...over,
});

describe("lookupTeamByLoginKey (Phase 2c team scope)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should Query GSI2 with TEAMKEY#<key> (no Limit; fetch all rows in team scope)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    await lookupTeamByLoginKey(shared, "KEY1");

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe("GSI2");
    expect(cmd.input.KeyConditionExpression).toContain("GSI2PK = :pk");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TEAMKEY#KEY1");
    // team scope なので Limit は付けない (= team の全 problems を 1 query で取る)
    expect(cmd.input.Limit).toBeUndefined();
  });

  it("正常系: team + problems[] を返し、operator 内部情報 / teamLoginKey を漏らさない", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view).toBeDefined();
    expect(view?.team.teamName).toBe("Alpha");
    expect(view?.team.teamNameSetByCompetitor).toBe(false);
    expect(view?.problems).toHaveLength(1);
    expect(view?.problems[0]?.jobId).toBe("JOB1");
    expect(view?.problems[0]?.problemId).toBe("security-battle-royale");
    expect(view?.problems[0]?.region).toBe("ap-northeast-1");
    expect(view?.problems[0]?.status).toBe("COMPLETE");
    expect(view?.problems[0]?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });

    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET_DO_NOT_LEAK");
    expect(json).not.toContain("tenantId");
    expect(json).not.toContain("namePrefix");
    // awsAccountId は SSO Credentials (AWS Console switch role) で必要なため公開する
    // (= AWS account id は機密ではない、IAM trust policy / CFn template にも露出する)。
    expect(view?.problems[0]?.awsAccountId).toBe("999999999999");
  });

  it("displayTeamName が DDB にあれば team.teamName はそれを優先し teamNameSetByCompetitor=true", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ teamName: "operator-slug", displayTeamName: "わたしたちのチーム" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.team.teamName).toBe("わたしたちのチーム");
    expect(view?.team.teamNameSetByCompetitor).toBe(true);
  });

  // Issue #607: createdAt を portal API に露出 (= phase countdown timeline で使う)。
  it("Issue #607: should echo problem.createdAt into ParticipantProblemView", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.createdAt).toBe("2026-05-04T15:00:00.000Z");
  });

  it("deployLog should return participant-facing terminal lines from DDB progress", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          status: "IN_PROGRESS",
          buildId: "DeployCodeBuild:abc123",
          stackId:
            "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-secret-team/stack-id",
          updatedAt: "2026-05-04T15:02:00.000Z",
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    const log = view?.problems[0]?.deployLog;
    expect(log?.cursor).toBe("2026-05-04T15:02:00.000Z");
    expect(log?.entries.map((entry) => entry.message)).toEqual([
      "Deployment job was queued.",
      "Build runner started.",
      "CloudFormation stack creation is in progress.",
      "Deployment is still running.",
    ]);
    expect(JSON.stringify(log)).not.toContain("DeployCodeBuild:abc123");
    expect(JSON.stringify(log)).not.toContain("tc-secret-team");
  });

  it("deployLog should include the failure reason in the terminal lines", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          status: "FAILED",
          failureReason: "CREATE_FAILED: VPC limit",
          updatedAt: "2026-05-04T15:03:00.000Z",
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.deployLog.entries.at(-1)).toMatchObject({
      level: "error",
      message: "Deployment failed: CREATE_FAILED: VPC limit",
      source: "deployment",
    });
  });

  it("should propagate eventId / teamId columns from the Phase 2a path into team", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ eventId: "EV1", teamId: "T1" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.team.eventId).toBe("EV1");
    expect(view?.team.teamId).toBe("T1");
  });

  it("旧 jobId-based deployment (eventId / teamId 無し) は team.eventId/teamId が undefined", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.team.eventId).toBeUndefined();
    expect(view?.team.teamId).toBeUndefined();
  });

  it("該当行が無ければ undefined", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const view = await lookupTeamByLoginKey(shared, "NOSUCHKEY");
    expect(view).toBeUndefined();
  });

  it("全行が DELETING / DELETED は undefined (sparse 化が崩れた場合の防御)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "DELETING" }), sampleRow({ jobId: "JOB2", status: "DELETED" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view).toBeUndefined();
  });

  /* Issue #2675: server-side 401 diagnostic. The client response stays identical
     (undefined → 401) for every miss reason; only a warn line distinguishes them,
     and it never carries the plaintext key. */
  describe("Issue #2675: 401 diagnostic log", () => {
    const readWarn = (warn: ReturnType<typeof vi.spyOn>): Record<string, unknown> =>
      JSON.parse(warn.mock.calls[0]?.[0] as string);

    it("should log reason=no_rows and still return undefined when the key matches no rows", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const view = await lookupTeamByLoginKey(shared, "SECRET_DO_NOT_LEAK");
        expect(view).toBeUndefined();
        const parsed = readWarn(warn);
        expect(parsed).toMatchObject({ event: "portal.login.unauthorized", reason: "no_rows" });
        expect(warn.mock.calls[0]?.[0]).not.toContain("SECRET_DO_NOT_LEAK");
      } finally {
        warn.mockRestore();
      }
    });

    it("should log reason=all_deleted and still return undefined when every row is torn down", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({
        Items: [sampleRow({ status: "DELETING" }), sampleRow({ jobId: "JOB2", status: "DELETED" })],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const view = await lookupTeamByLoginKey(shared, "KEY1");
        expect(view).toBeUndefined();
        expect(readWarn(warn).reason).toBe("all_deleted");
      } finally {
        warn.mockRestore();
      }
    });

    it("should log reason=no_live_sample and still return undefined when all rows are lifecycle-expired", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({
        Items: [
          sampleRow({ status: "EXPIRED" }),
          sampleRow({ jobId: "JOB2", status: "AUTO_DELETED" }),
        ],
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const view = await lookupTeamByLoginKey(shared, "KEY1");
        expect(view).toBeUndefined();
        expect(readWarn(warn).reason).toBe("no_live_sample");
      } finally {
        warn.mockRestore();
      }
    });

    it("should not emit any diagnostic line on a successful lookup", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await lookupTeamByLoginKey(shared, "KEY1")).toBeDefined();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("should build problems[] from live rows only for teams partially DELETED", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ jobId: "JOB1", problemId: "p1", status: "COMPLETE" }),
        sampleRow({ jobId: "JOB2", problemId: "p2", status: "DELETED" }),
        sampleRow({ jobId: "JOB3", problemId: "p3", status: "PENDING" }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems).toHaveLength(2);
    expect(view?.problems.map((p) => p.problemId).sort()).toEqual(["p1", "p3"]);
  });

  it("status=FAILED のみ failureReason を露出する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "FAILED", failureReason: "VPC limit" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.failureReason).toBe("VPC limit");
  });

  it("status=COMPLETE で failureReason が DDB 側に残っていても露出しない", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "COMPLETE", failureReason: "stale data" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.failureReason).toBeUndefined();
  });

  it("壊れた stackOutputs JSON は空 object として返す (best-effort)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ stackOutputs: "not-json" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.stackOutputs).toEqual({});
  });

  it("should strip the flagOutputKey value from stackOutputs for flag-form problems (prevent answer leak)", async () => {
    const scoring = {
      "security-battle-royale": {
        kind: "flag" as const,
        flagOutputKey: "FlagAnswer",
        points: 100,
      },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          stackOutputs: JSON.stringify({
            FrontendUrl: "https://x.example.com",
            FlagAnswer: "the-secret-answer",
          }),
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });
    expect(view?.problems[0]?.scoring?.kind).toBe("flag");
    expect(view?.problems[0]?.scoring?.points).toBe(100);
  });

  describe("multi-flag scoring view (Issue #1796)", () => {
    const multiScoring = {
      "security-battle-royale": {
        kind: "multi-flag" as const,
        flags: [
          { id: "ep01", label: "Ep01", flagOutputKey: "AnswerFlagEp01", points: 300 },
          { id: "ep02", label: "Ep02", flagOutputKey: "AnswerFlagEp02", points: 200 },
        ],
      },
    };

    it("should strip every sub-flag flagOutputKey from stackOutputs (prevent answer leak)", async () => {
      const { shared, ddbSend } = buildShared(multiScoring);
      ddbSend.mockResolvedValueOnce({
        Items: [
          sampleRow({
            stackOutputs: JSON.stringify({
              FrontendUrl: "https://x.example.com",
              AnswerFlagEp01: "secret-1",
              AnswerFlagEp02: "secret-2",
            }),
          }),
        ],
      });

      const view = await lookupTeamByLoginKey(shared, "KEY1");
      expect(view?.problems[0]?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });
      const json = JSON.stringify(view);
      expect(json).not.toContain("secret-1");
      expect(json).not.toContain("secret-2");
    });

    it("should report the summed points and per-flag solved state from a String Set", async () => {
      const { shared, ddbSend } = buildShared(multiScoring);
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ solvedFlagIds: new Set(["ep01"]) })] });

      const scoring = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems[0]?.scoring;
      expect(scoring?.kind).toBe("multi-flag");
      expect(scoring?.points).toBe(500); // 300 + 200
      expect(scoring?.flags).toEqual([
        { id: "ep01", label: "Ep01", points: 300, solved: true },
        { id: "ep02", label: "Ep02", points: 200, solved: false },
      ]);
    });

    it("should derive solved state from a plain string array too (row drift)", async () => {
      const { shared, ddbSend } = buildShared(multiScoring);
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ solvedFlagIds: ["ep02"] })] });

      const scoring = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems[0]?.scoring;
      expect(scoring?.flags?.map((f) => f.solved)).toEqual([false, true]);
    });

    it("should mark all flags unsolved when solvedFlagIds is absent", async () => {
      const { shared, ddbSend } = buildShared(multiScoring);
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

      const scoring = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems[0]?.scoring;
      expect(scoring?.flags?.every((f) => !f.solved)).toBe(true);
    });
  });

  it("should include score / lastScoredAt / lastResult / scoring in the problem view", async () => {
    const scoring = {
      "security-battle-royale": { kind: "uptime" as const, pointsPerSuccess: 50 },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          score: 250,
          lastScoredAt: "2026-05-05T10:00:00.000Z",
          lastResult: "ok",
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    const p = view?.problems[0];
    expect(p?.score).toBe(250);
    expect(p?.lastScoredAt).toBe("2026-05-05T10:00:00.000Z");
    expect(p?.lastResult).toBe("ok");
    expect(p?.scoring?.kind).toBe("uptime");
    expect(p?.scoring?.pointsPerSuccess).toBe(50);
  });

  it("should expose safe scoring views for flag hints and polling kinds", async () => {
    const scoring = {
      "flag-problem": {
        kind: "flag" as const,
        flagOutputKey: "FlagAnswer",
        points: 100,
        hints: [
          { id: "h1", content: "revealed hint", penalty: 5 },
          { id: "h2", content: "locked hint", penalty: 10 },
        ],
      },
      "uptime-multi-problem": {
        kind: "uptime-multi" as const,
        probedSlots: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsAllOk: 500,
      },
      "phased-problem": {
        kind: "phased-polling" as const,
        intervalMinutes: 1,
        probe: { metaPath: "/meta", scorePath: "/score" },
        platformRules: { ec2: { points: 100 }, lambda: { points: 1000 } },
      },
      "attack-problem": {
        kind: "attack-detection" as const,
        statsOutputKey: "AttackStats",
        pointsPerAttack: 25,
      },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          jobId: "J1",
          PK: "DEPLOYMENT#J1",
          problemId: "flag-problem",
          flagSubmitted: true,
          hintsRevealed: [
            { hintId: "h1", revealedAt: "2026-05-15T01:00:00.000Z", penaltyApplied: 5 },
          ],
          stackOutputs: JSON.stringify({
            FrontendUrl: "https://x.example.com",
            FlagAnswer: "flag-answer",
          }),
        }),
        sampleRow({ jobId: "J2", PK: "DEPLOYMENT#J2", problemId: "uptime-multi-problem" }),
        sampleRow({ jobId: "J3", PK: "DEPLOYMENT#J3", problemId: "phased-problem" }),
        sampleRow({ jobId: "J4", PK: "DEPLOYMENT#J4", problemId: "attack-problem" }),
      ],
    });

    const problems = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems ?? [];
    expect(problems[0]?.scoring).toEqual({
      kind: "flag",
      points: 100,
      flagSubmitted: true,
      hints: [
        {
          id: "h1",
          penalty: 5,
          revealed: true,
          content: "revealed hint",
          revealedAt: "2026-05-15T01:00:00.000Z",
        },
        { id: "h2", penalty: 10, revealed: false },
      ],
    });
    expect(problems[0]?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });
    expect(problems[1]?.scoring).toEqual({ kind: "uptime-multi", pointsAllOk: 500 });
    expect(problems[2]?.scoring).toEqual({ kind: "phased-polling", pointsPerSuccess: 1000 });
    expect(problems[3]?.scoring).toEqual({ kind: "attack-detection", pointsPerAttack: 25 });
    expect(JSON.stringify(problems)).not.toContain("flag-answer");
  });

  it("should surface hintReveal:'flat' on the flag scoring view (opt-in)", async () => {
    const scoring = {
      "flat-hints-problem": {
        kind: "flag" as const,
        flagOutputKey: "FlagAnswer",
        points: 100,
        hints: [{ id: "h1", content: "any-order hint", penalty: 5 }],
        hintReveal: "flat" as const,
      },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ jobId: "J1", PK: "DEPLOYMENT#J1", problemId: "flat-hints-problem" })],
    });
    const problems = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems ?? [];
    expect(problems[0]?.scoring).toMatchObject({ kind: "flag", hintReveal: "flat" });
  });

  it("should expose the latest measured posture and platform snapshot", async () => {
    const scoring = {
      "security-battle-royale": { kind: "uptime" as const, pointsPerSuccess: 50 },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          posture: JSON.stringify({ db_present: true, auth_enabled: false }),
          platform: "posture-1",
        }),
      ],
    });

    const p = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems[0];
    expect(p?.posture).toEqual({ db_present: true, auth_enabled: false });
    expect(p?.platform).toBe("posture-1");
  });

  it("should drop malformed posture snapshots from the participant view", async () => {
    const scoring = {
      "security-battle-royale": { kind: "uptime" as const, pointsPerSuccess: 50 },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ posture: "{not-json", platform: "posture-1" })],
    });

    const p = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems[0];
    expect(p?.posture).toBeUndefined();
    expect(p?.platform).toBe("posture-1");
  });

  it("should keep only boolean posture fields and drop non-string platform values", async () => {
    const scoring = {
      "security-battle-royale": { kind: "uptime" as const, pointsPerSuccess: 50 },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          posture: JSON.stringify({ db_present: true, auth_enabled: "yes", retries: 2 }),
          platform: 123,
        }),
      ],
    });

    const p = (await lookupTeamByLoginKey(shared, "KEY1"))?.problems[0];
    expect(p?.posture).toEqual({ db_present: true });
    expect(p?.platform).toBeUndefined();
  });

  it("should return 0 for rows without score (default)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.score).toBe(0);
  });

  /* applicationStatus aggregate ----------------------- */

  it("should return uptime-kind problem applicationStatus as aggregate (healthy)", async () => {
    const scoring = {
      "security-battle-royale": {
        kind: "uptime" as const,
        pointsPerSuccess: 5,
        endpoints: [],
      },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          endpointsHealth: JSON.stringify({
            FrontendUrl: { ok: true, checkedAt: "2026-05-10T09:55:00.000Z" },
            ApiUrl: { ok: true, checkedAt: "2026-05-10T09:55:00.000Z" },
          }),
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.applicationStatus).toEqual({
      overall: "healthy",
      healthyCount: 2,
      totalCount: 2,
      checkedAt: "2026-05-10T09:55:00.000Z",
    });
  });

  it("uptime kind: 一部 NG なら degraded、全 NG なら down", async () => {
    const scoring = { p: { kind: "uptime" as const, pointsPerSuccess: 5, endpoints: [] } };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          jobId: "J1",
          PK: "DEPLOYMENT#J1",
          problemId: "p",
          endpointsHealth: JSON.stringify({
            FrontendUrl: { ok: true, checkedAt: "2026-05-10T09:55:00.000Z" },
            ApiUrl: { ok: false, checkedAt: "2026-05-10T09:55:00.000Z" },
          }),
        }),
        sampleRow({
          jobId: "J2",
          PK: "DEPLOYMENT#J2",
          problemId: "p",
          endpointsHealth: JSON.stringify({
            FrontendUrl: { ok: false, checkedAt: "2026-05-10T09:55:00.000Z" },
            ApiUrl: { ok: false, checkedAt: "2026-05-10T09:55:00.000Z" },
          }),
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.applicationStatus?.overall).toBe("degraded");
    expect(view?.problems[1]?.applicationStatus?.overall).toBe("down");
  });

  it("uptime kind: endpointsHealth が無い (probe 未実行) なら unknown", async () => {
    const scoring = { p: { kind: "uptime" as const, pointsPerSuccess: 5, endpoints: [] } };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ problemId: "p", endpointsHealth: undefined })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.applicationStatus?.overall).toBe("unknown");
    expect(view?.problems[0]?.applicationStatus?.totalCount).toBe(0);
  });

  it("flag kind problem should not expose applicationStatus (Challenges are out of scope)", async () => {
    const scoring = {
      "hello-world": { kind: "flag" as const, flagOutputKey: "F", points: 100 },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          problemId: "hello-world",
          endpointsHealth: JSON.stringify({ X: { ok: true, checkedAt: "x" } }),
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.applicationStatus).toBeUndefined();
  });

  /* Issue #2422: attackProbeStatus surface -------------------------------- */

  it("should surface the attack-probe snapshot from the deployment row (#2422)", async () => {
    const scoring = { p: { kind: "uptime-multi" as const, probedSlots: [], pointsAllOk: 5 } };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          problemId: "p",
          attackProbes: JSON.stringify({
            checkedAt: "2026-07-07T00:00:00.000Z",
            probes: [
              { outcome: "landed", penalty: 60, label: "Auth bypass", symptom: "accepts login" },
              { outcome: "blocked", penalty: 30 },
            ],
          }),
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.attackProbeStatus).toEqual({
      checkedAt: "2026-07-07T00:00:00.000Z",
      probes: [
        { outcome: "landed", penalty: 60, label: "Auth bypass", symptom: "accepts login" },
        { outcome: "blocked", penalty: 30 },
      ],
    });
  });

  it("should leave attackProbeStatus undefined when the row has no snapshot (#2422)", async () => {
    const scoring = { p: { kind: "uptime-multi" as const, probedSlots: [], pointsAllOk: 5 } };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ problemId: "p" })] });
    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.attackProbeStatus).toBeUndefined();
  });

  it("should never leak a probe slot/path into attackProbeStatus (non-spoiler guard, #2422)", async () => {
    const scoring = { p: { kind: "uptime-multi" as const, probedSlots: [], pointsAllOk: 5 } };
    const { shared, ddbSend } = buildShared(scoring);
    // Even if a corrupt row smuggled slot/path in, the parser only keeps the wire fields.
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          problemId: "p",
          attackProbes: JSON.stringify({
            probes: [{ outcome: "landed", penalty: 60, slot: "api", path: "/secret-endpoint" }],
          }),
        }),
      ],
    });
    const view = await lookupTeamByLoginKey(shared, "KEY1");
    const json = JSON.stringify(view?.problems[0]?.attackProbeStatus);
    expect(json).not.toContain("secret-endpoint");
    expect(json).not.toContain("slot");
  });

  it("should never include endpoint names / URLs in applicationStatus (snapshot guard)", async () => {
    const scoring = { p: { kind: "uptime" as const, pointsPerSuccess: 5, endpoints: [] } };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          problemId: "p",
          endpointsHealth: JSON.stringify({
            FrontendUrl: { ok: false, checkedAt: "2026-05-10T09:55:00.000Z" },
            SecretInternalProbeName: { ok: true, checkedAt: "2026-05-10T09:55:00.000Z" },
          }),
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    const json = JSON.stringify(view?.problems[0]?.applicationStatus);
    expect(json).not.toContain("FrontendUrl");
    expect(json).not.toContain("SecretInternalProbeName");
  });
});

describe("provider resolution (#2233)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should resolve provider to aws when runtimeProvider is absent (legacy row contract)", async () => {
    // 行契約 (deploy-handler/types.ts): runtimeProvider 欠落 = aws/cloudformation。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.provider).toBe("aws");
  });

  it("should echo runtimeProvider for non-AWS single-provider rows", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ jobId: "J1", PK: "DEPLOYMENT#J1", runtimeProvider: "sakura" }),
        sampleRow({ jobId: "J2", PK: "DEPLOYMENT#J2", runtimeProvider: "azure" }),
        sampleRow({ jobId: "J3", PK: "DEPLOYMENT#J3", runtimeProvider: "gcp" }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems.map((p) => p.provider)).toEqual(["sakura", "azure", "gcp"]);
  });

  it("should echo runtimeProvider for composite-target-shaped rows (always explicit, aws included)", async () => {
    // Composite target 行は runtimeProvider を常に明示する (aws 含む。composite-repository.ts)。
    // 今日は GSI2 非掲載で /portal/me には現れないが、後続の「intentional view」が
    // 追加されたとき resolver がそのまま動くことをここで pin する。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          jobId: "T1",
          PK: "DEPLOYMENT#T1",
          parentDeploymentId: "PARENT1",
          targetId: "aws-api",
          targetOrdinal: 0,
          runtimeProvider: "aws",
          runtimeEngine: "cloudformation",
          runtimeEntry: "aws/template.yaml",
        }),
        sampleRow({
          jobId: "T2",
          PK: "DEPLOYMENT#T2",
          parentDeploymentId: "PARENT1",
          targetId: "gcp-worker",
          targetOrdinal: 1,
          runtimeProvider: "gcp",
          runtimeEngine: "infra-manager",
          runtimeEntry: "gs://bucket/worker",
        }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems.map((p) => p.provider)).toEqual(["aws", "gcp"]);
  });

  it("should pass an unknown stored provider through raw instead of mislabeling it as aws", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ runtimeProvider: "oraclecloud" })] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.provider).toBe("oraclecloud");
  });

  it("should treat an empty runtimeProvider as the legacy aws contract", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ runtimeProvider: "" })] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.provider).toBe("aws");
  });
});

describe("access capabilities (#2235)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should expose console and cli-credentials capabilities for an AWS problem", async () => {
    // Access capability matrix: aws = managed (console + cli-credentials)。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.accessCapabilities).toEqual(["console", "cli-credentials"]);
  });

  it("should expose the external-portal capability for gcp azure and sakura problems", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ jobId: "J1", PK: "DEPLOYMENT#J1", runtimeProvider: "gcp" }),
        sampleRow({ jobId: "J2", PK: "DEPLOYMENT#J2", runtimeProvider: "azure" }),
        sampleRow({ jobId: "J3", PK: "DEPLOYMENT#J3", runtimeProvider: "sakura" }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems.map((p) => p.accessCapabilities)).toEqual([
      ["external-portal"],
      ["external-portal"],
      ["external-portal"],
    ]);
  });

  it("should expose the unsupported capability for an unknown provider", async () => {
    // 未知 provider を console 対応と誤宣言しない (= descriptor を正直に保つ)。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ runtimeProvider: "oraclecloud" })] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.accessCapabilities).toEqual(["unsupported"]);
  });

  it("should keep capabilities consistent with the composite target access matrix", async () => {
    // 正本は composite-target-access.ts の CAPABILITY_MATRIX。 view 側が別 matrix を
    // 持って drift しないことを、 全プロバイダで直接照合して pin する。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ jobId: "J1", PK: "DEPLOYMENT#J1" }),
        sampleRow({ jobId: "J2", PK: "DEPLOYMENT#J2", runtimeProvider: "gcp" }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.accessCapabilities).toEqual(
      resolveTargetAccessCapability("aws", "COMPLETE"),
    );
    expect(view?.problems[1]?.accessCapabilities).toEqual(
      resolveTargetAccessCapability("gcp", "COMPLETE"),
    );
  });
});
