import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { publishRuntimeScoreFeed } from "../../lib/problem-deploy/handlers/generic-scoring-handler/runtime-score-feed.js";

const CONFIG = {
  eventId: "evt-1",
  deploymentsTableName: "Deployments",
  runtimeProblemIds: ["battle-a", "battle-b"],
  controlPlaneUrl: "https://control.example/base",
  tokenParameterName: "/tenkacloud/runtime/feed-token",
} as const;

function dependencies(
  pages: readonly Record<string, unknown>[],
  options: { token?: string; status?: number } = {},
) {
  const remaining = [...pages];
  const ddb = {
    send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(ScanCommand);
      return remaining.shift() ?? { Items: [] };
    }),
  };
  const ssm = {
    send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetParameterCommand);
      return { Parameter: { Value: options.token ?? "secret-token" } };
    }),
  };
  const fetchImpl = vi.fn(
    async () => new Response(null, { status: options.status ?? 204 }),
  ) as unknown as typeof fetch;
  return { ddb, ssm, fetchImpl };
}

describe("publishRuntimeScoreFeed", () => {
  it("should aggregate every runtime problem per team and publish one authoritative batch", async () => {
    const deps = dependencies([
      {
        Items: [
          { eventId: "evt-1", teamId: "team-a", problemId: "battle-a", score: 10 },
          { eventId: "evt-1", teamId: "team-a", problemId: "battle-b", score: -3 },
          { eventId: "evt-1", teamId: "team-b", problemId: "battle-a", score: 20 },
          { eventId: "evt-1", teamId: "team-b", problemId: "flag-a", score: 100 },
          { eventId: "other", teamId: "team-x", problemId: "battle-a", score: 999 },
        ],
        LastEvaluatedKey: { PK: "next" },
      },
      {
        Items: [{ eventId: "evt-1", teamId: "team-b", problemId: "battle-b", score: 5 }],
      },
    ]);

    await publishRuntimeScoreFeed(CONFIG, deps);

    expect(deps.ddb.send).toHaveBeenCalledTimes(2);
    expect(deps.ssm.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Name: "/tenkacloud/runtime/feed-token", WithDecryption: true },
      }),
    );
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://control.example/v1/runtime/events/evt-1/score-summaries");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(JSON.parse(String(init?.body))).toEqual({
      scores: [
        { teamId: "team-a", points: 7 },
        { teamId: "team-b", points: 25 },
      ],
    });
  });

  it("should skip the secret read and HTTP call when the event has no scored deployments", async () => {
    const deps = dependencies([{ Items: [] }]);
    await publishRuntimeScoreFeed(CONFIG, deps);
    expect(deps.ssm.send).not.toHaveBeenCalled();
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("should bound each Worker request to 100 team summaries", async () => {
    const deps = dependencies([
      {
        Items: Array.from({ length: 101 }, (_, index) => ({
          eventId: "evt-1",
          teamId: `team-${index}`,
          problemId: "battle-a",
          score: index,
        })),
      },
    ]);
    await publishRuntimeScoreFeed(CONFIG, deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    const batchSizes = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)).scores.length,
    );
    expect(batchSizes).toEqual([100, 1]);
  });

  it("should avoid DynamoDB work when the catalog has no runtime scoring kinds", async () => {
    const deps = dependencies([]);
    await publishRuntimeScoreFeed({ ...CONFIG, runtimeProblemIds: [] }, deps);
    expect(deps.ddb.send).not.toHaveBeenCalled();
  });

  it("should reject invalid scores, missing secrets, and non-success responses", async () => {
    const invalid = dependencies([
      {
        Items: [{ eventId: "evt-1", teamId: "t", problemId: "battle-a", score: 1.5 }],
      },
    ]);
    await expect(publishRuntimeScoreFeed(CONFIG, invalid)).rejects.toThrow(/invalid runtime score/);

    const missingSecret = dependencies(
      [{ Items: [{ eventId: "evt-1", teamId: "t", problemId: "battle-a", score: 1 }] }],
      {
        token: "",
      },
    );
    await expect(publishRuntimeScoreFeed(CONFIG, missingSecret)).rejects.toThrow(
      /token parameter is empty/,
    );

    const rejected = dependencies(
      [{ Items: [{ eventId: "evt-1", teamId: "t", problemId: "battle-a", score: 1 }] }],
      {
        status: 503,
      },
    );
    await expect(publishRuntimeScoreFeed(CONFIG, rejected)).rejects.toThrow(/HTTP 503/);
  });
});
