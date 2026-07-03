import { ResourceNotFoundException } from "@aws-sdk/client-cloudwatch-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("should return the default limit when unspecified", () => {
    expect(parseDeployLogLimit(undefined)).toBe(50);
  });

  it("should accept only integers from 1 to 100", () => {
    expect(parseDeployLogLimit("1")).toBe(1);
    expect(parseDeployLogLimit("100")).toBe(100);
    expect(parseDeployLogLimit("0")).toBeNull();
    expect(parseDeployLogLimit("101")).toBeNull();
    expect(parseDeployLogLimit("10.5")).toBeNull();
    expect(parseDeployLogLimit("10abc")).toBeNull();
  });
});

describe("getParticipantDeployLogs", () => {
  // #2291: the Lambda-path branch is gated on this env. Clear it after every test so the
  // CodeBuild-path tests (which assert the empty-fallback when buildId is absent) see today's
  // exact behavior and no env leaks across tests.
  afterEach(() => {
    delete process.env.DEPLOY_JOB_LOG_GROUP;
  });

  it("should return unauthorized when there are no deployments linked to teamLoginKey", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([]);
    const deps = buildDeps();

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("unauthorized");
    expect(deps.codebuild.send).not.toHaveBeenCalled();
    expect(deps.logs.send).not.toHaveBeenCalled();
  });

  it("should return not_found without calling CodeBuild for a different jobId", async () => {
    vi.mocked(queryTeamItems).mockResolvedValueOnce([{ jobId: "01HOTHERJOBID012345678901" }]);
    const deps = buildDeps();

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("not_found");
    expect(deps.codebuild.send).not.toHaveBeenCalled();
  });

  it("should return an empty log as a 200 response when buildId has not been assigned", async () => {
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

  it("should return incremental log events from the CodeBuild log group/stream", async () => {
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

  it("should return complete=true when CodeBuild is in a terminal status", async () => {
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

  it("should redact CodeBuild logs containing flagOutputKey before returning", async () => {
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

  it("should stream Lambda-path deploy logs from the jobId CloudWatch stream when DEPLOY_JOB_LOG_GROUP is set", async () => {
    process.env.DEPLOY_JOB_LOG_GROUP = "/tenkacloud/deploy-jobs";
    // No buildId (Lambda path has no CodeBuild build) → the jobId stream is read instead.
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "IN_PROGRESS", problemId: "hello-world" },
    ]);
    const deps = buildDeps();
    deps.logs.send.mockResolvedValueOnce({
      events: [
        {
          timestamp: 1_779_273_600_000,
          ingestionTime: 1_779_273_600_100,
          message: "Deploying stack tc-x-y ...",
        },
        {
          timestamp: 1_779_273_601_000,
          ingestionTime: 1_779_273_601_100,
          message: "CreateStack submitted (stackId arn:aws:cfn:...)",
        },
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
          source: "lambda",
          message: "Deploying stack tc-x-y ...",
        },
        {
          id: "1779273601000:1779273601100:1",
          timestamp: "2026-05-20T10:40:01.000Z",
          source: "lambda",
          message: "CreateStack submitted (stackId arn:aws:cfn:...)",
        },
      ],
    });
    // Reads the jobId-keyed stream in the configured group; no CodeBuild lookup on the Lambda path.
    expect(deps.logs.send.mock.calls[0]?.[0].input).toMatchObject({
      logGroupName: "/tenkacloud/deploy-jobs",
      logStreamName: JOB_ID,
      nextToken: "prev-token",
      limit: 25,
      startFromHead: true,
    });
    expect(deps.codebuild.send).not.toHaveBeenCalled();
  });

  it("should return empty entries when the job log stream does not exist yet", async () => {
    process.env.DEPLOY_JOB_LOG_GROUP = "/tenkacloud/deploy-jobs";
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "PENDING", problemId: "hello-world" },
    ]);
    const deps = buildDeps();
    deps.logs.send.mockRejectedValueOnce(
      new ResourceNotFoundException({
        message: "The specified log stream does not exist.",
        $metadata: {},
      }),
    );

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
  });

  it("should redact sensitive Lambda-path lines identically to the CodeBuild path", async () => {
    process.env.DEPLOY_JOB_LOG_GROUP = "/tenkacloud/deploy-jobs";
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "IN_PROGRESS", problemId: "hello-world" },
    ]);
    const deps = buildDeps();
    deps.logs.send.mockResolvedValueOnce({
      events: [
        {
          timestamp: 1_779_273_600_000,
          ingestionTime: 1_779_273_600_100,
          message: "using externalId abc",
        },
      ],
      nextForwardToken: "next-token",
    });

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response.entries[0]?.message).toBe("[redacted sensitive output]");
  });

  it("should keep the empty-fallback (no CloudWatch read) when DEPLOY_JOB_LOG_GROUP is unset", async () => {
    // Default-safe: with the flag OFF the env is absent and the Lambda-path branch never runs.
    vi.mocked(queryTeamItems).mockResolvedValueOnce([
      { jobId: JOB_ID, status: "PENDING", problemId: "hello-world" },
    ]);
    const deps = buildDeps();

    const out = await getParticipantDeployLogs(shared, deps, TEAM_KEY, { jobId: JOB_ID });

    expect(out).toEqual({
      kind: "ok",
      response: { jobId: JOB_ID, buildStatus: "PENDING", complete: false, entries: [] },
    });
    expect(deps.logs.send).not.toHaveBeenCalled();
    expect(deps.codebuild.send).not.toHaveBeenCalled();
  });
});
