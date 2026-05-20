import { describe, expect, it, vi } from "vitest";
import {
  getParticipantDeployLogs,
  parseDeployLogLimit,
} from "../../lib/problem-deploy/handlers/participant-handler/deploy-logs";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

const TEAM_KEY = "team-login-key";
const JOB_ID = "01H8XGJWBWBAQ4N6RZHM4S2KMV";

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  queryTeamItems: vi.fn(),
}));

const { queryTeamItems } = await import(
  "../../lib/problem-deploy/handlers/participant-handler/shared"
);

function buildDeps() {
  return {
    codebuild: { send: vi.fn() },
    logs: { send: vi.fn() },
  };
}

const shared = {
  tableName: "TestDeployments",
  eventsTableName: "TestEvents",
  ddb: { send: vi.fn() },
  problemsScoring: {},
} as unknown as ParticipantSharedResources;

describe("parseDeployLogLimit", () => {
  it("未指定なら default limit を返すべき", () => {
    expect(parseDeployLogLimit(undefined)).toBe(50);
  });

  it("1-100 の整数だけを許可すべき", () => {
    expect(parseDeployLogLimit("1")).toBe(1);
    expect(parseDeployLogLimit("100")).toBe(100);
    expect(parseDeployLogLimit("0")).toBeNull();
    expect(parseDeployLogLimit("101")).toBeNull();
    expect(parseDeployLogLimit("10.5")).toBeNull();
    expect(parseDeployLogLimit("10abc")).toBeNull();
  });
});

describe("getParticipantDeployLogs", () => {
  it("teamLoginKey に紐づく deployment が無ければ unauthorized を返すべき", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([]);
    const deps = buildDeps();

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("unauthorized");
    expect(deps.codebuild.send).not.toHaveBeenCalled();
    expect(deps.logs.send).not.toHaveBeenCalled();
  });

  it("別 jobId は not_found を返し CodeBuild を呼ばないべき", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([{ jobId: "01HOTHERJOBID012345678901" }]);
    const deps = buildDeps();

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("not_found");
    expect(deps.codebuild.send).not.toHaveBeenCalled();
  });

  it("buildId 未採番なら空ログを 200 用 response として返すべき", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "PENDING", updatedAt: "2026-05-20T10:00:00.000Z" },
    ]);
    const deps = buildDeps();

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out).toEqual({
      kind: "ok",
      response: {
        jobId: JOB_ID,
        buildStatus: "PENDING",
        complete: false,
        entries: [],
      },
    });
    expect(deps.codebuild.send).not.toHaveBeenCalled();
  });

  it("CodeBuild の log group/stream から増分 log events を返すべき", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "IN_PROGRESS", buildId: "project:build-1" },
    ]);
    const deps = buildDeps();
    deps.codebuild.send.mockResolvedValueOnce({
      builds: [
        {
          id: "project:build-1",
          buildStatus: "IN_PROGRESS",
          logs: { groupName: "/aws/codebuild/tenkacloud", streamName: "build-stream" },
        },
      ],
    });
    deps.logs.send.mockResolvedValueOnce({
      events: [
        { timestamp: 1_779_273_600_000, ingestionTime: 1_779_273_600_100, message: "phase 1" },
        { timestamp: 1_779_273_601_000, ingestionTime: 1_779_273_601_100, message: "phase 2" },
      ],
      nextForwardToken: "next-token",
    });

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, {
      jobId: JOB_ID,
      nextToken: "prev-token",
      limit: 25,
    });

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response).toEqual({
      jobId: JOB_ID,
      buildStatus: "IN_PROGRESS",
      complete: false,
      nextToken: "next-token",
      entries: [
        {
          id: "1779273600000:1779273600100:0",
          timestamp: "2026-05-20T10:40:00.000Z",
          source: "codebuild",
          message: "phase 1",
        },
        {
          id: "1779273601000:1779273601100:1",
          timestamp: "2026-05-20T10:40:01.000Z",
          source: "codebuild",
          message: "phase 2",
        },
      ],
    });
    expect(deps.logs.send.mock.calls[0]?.[0].input).toMatchObject({
      logGroupName: "/aws/codebuild/tenkacloud",
      logStreamName: "build-stream",
      nextToken: "prev-token",
      limit: 25,
      startFromHead: true,
    });
  });

  it("CodeBuild が terminal status なら complete=true を返すべき", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "IN_PROGRESS", buildId: "project:build-1" },
    ]);
    const deps = buildDeps();
    deps.codebuild.send.mockResolvedValueOnce({
      builds: [
        {
          id: "project:build-1",
          buildStatus: "FAILED",
          logs: { groupName: "/aws/codebuild/tenkacloud", streamName: "build-stream" },
        },
      ],
    });
    deps.logs.send.mockResolvedValueOnce({ events: [], nextForwardToken: "same-token" });

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response.complete).toBe(true);
    expect(out.response.buildStatus).toBe("FAILED");
  });

  it("flagOutputKey を含む CodeBuild log は redaction して返すべき", async () => {
    const flagShared = {
      ...shared,
      problemsScoring: {
        "hello-world": {
          kind: "flag",
          flagOutputKey: "ParameterValue",
          points: 100,
        },
      },
    } as unknown as ParticipantSharedResources;
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      {
        jobId: JOB_ID,
        problemId: "hello-world",
        status: "IN_PROGRESS",
        buildId: "project:build-1",
      },
    ]);
    const deps = buildDeps();
    deps.codebuild.send.mockResolvedValueOnce({
      builds: [
        {
          id: "project:build-1",
          buildStatus: "IN_PROGRESS",
          logs: { groupName: "/aws/codebuild/tenkacloud", streamName: "build-stream" },
        },
      ],
    });
    deps.logs.send.mockResolvedValueOnce({
      events: [
        {
          timestamp: 1_779_273_600_000,
          ingestionTime: 1_779_273_600_100,
          message: "| ParameterValue | Hello from tc-secret-team |",
        },
      ],
      nextForwardToken: "next-token",
    });

    const out = await getParticipantDeployLogs(flagShared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response.entries[0]?.message).toBe("[redacted scoring output]");
  });
});
