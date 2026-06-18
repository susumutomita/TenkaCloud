import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

function buildShared(scoring: ParticipantSharedResources["problemsScoring"] = {}): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
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

  it("should return 0 for rows without score (default)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.score).toBe(0);
  });

  /* ADR-005 Phase 3.1: applicationStatus aggregate ----------------------- */

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
