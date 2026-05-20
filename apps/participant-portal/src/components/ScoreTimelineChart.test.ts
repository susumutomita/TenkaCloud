import { describe, expect, it } from "vitest";
import type { TeamScoreEvents } from "../api/portal-client";
import { buildCumulativePoints, toScoreTimelineLoadError } from "./ScoreTimelineChart";

describe("ScoreTimelineChart helpers", () => {
  it("score events を累積 point に変換し invalid timestamp は除外すべき", () => {
    const team: TeamScoreEvents = {
      teamId: "team-a",
      teamName: "Team A",
      isMyTeam: true,
      events: [
        {
          jobId: "job-1",
          problemId: "p1",
          source: "flag",
          points: 10,
          result: "ok",
          occurredAt: "2026-05-20T10:00:00.000Z",
        },
        {
          jobId: "job-2",
          problemId: "p2",
          source: "hint",
          points: -2,
          result: "ok",
          occurredAt: "bad timestamp",
        },
        {
          jobId: "job-3",
          problemId: "p3",
          source: "uptime",
          points: 5,
          result: "ok",
          occurredAt: "2026-05-20T10:01:00.000Z",
        },
      ],
    };

    const points = buildCumulativePoints(team);

    expect(points).toHaveLength(2);
    expect(points.map((p) => p.y)).toEqual([10, 13]);
    expect(points[0]?.x.toISOString()).toBe("2026-05-20T10:00:00.000Z");
  });

  it("AbortError は skip、それ以外は error message に変換すべき", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";

    expect(toScoreTimelineLoadError(abort)).toEqual({ kind: "skip" });
    expect(toScoreTimelineLoadError(new Error("network failed"))).toEqual({
      kind: "error",
      message: "network failed",
    });
    expect(toScoreTimelineLoadError("bad")).toEqual({ kind: "error", message: "bad" });
  });
});
