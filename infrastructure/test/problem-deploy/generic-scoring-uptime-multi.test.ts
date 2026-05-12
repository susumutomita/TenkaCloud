import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUptimeMultiKind } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-multi";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { UptimeMultiScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `uptime-multi` kind (= N slot AND probe で全 ok のとき pointsAllOk 加点、 1 fail で
 * failurePenalty 適用)。security-battle-royale 想定。
 */

const NOW_ISO = "2026-05-12T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function buildInput(
  overrides: Partial<KindHandlerInput<UptimeMultiScoringMetadata>> = {},
): KindHandlerInput<UptimeMultiScoringMetadata> {
  return {
    deployment: {
      PK: "DEPLOYMENT#JOB1",
      jobId: "JOB1",
      problemId: "security-battle-royale",
      tenantId: "tenant-acme",
      teamId: "team-1",
      eventId: "event-1",
      stackOutputs: JSON.stringify({
        FrontendUrl: "https://frontend.example.com",
        ApiUrl: "https://api.example.com",
      }),
      expiresAt: 9_999_999_999,
    },
    scoring: {
      kind: "uptime-multi",
      probedSlots: [
        { slot: "frontend", path: "/", expectStatus: [200] },
        { slot: "api", path: "/healthz", expectStatus: [200] },
      ],
      pointsAllOk: 100,
      failurePenalty: -50,
    },
    slots: [
      { slot: "frontend", default: { from: "cfn-output", key: "FrontendUrl" }, overridable: true },
      { slot: "api", default: { from: "cfn-output", key: "ApiUrl" }, overridable: true },
    ],
    overrides: [],
    phases: [] as readonly PhaseEntry[],
    nowMs: NOW_MS,
    nowIso: NOW_ISO,
    prevState: {},
    ...overrides,
  };
}

describe("uptime-multi kind", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("全 slot 200 なら pointsAllOk を加点すべき", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 100, occurredAt: NOW_ISO }]);
    expect(result.lastResult).toBe("ok");
  });

  it("1 slot fail なら failurePenalty を加点すべき (負値 = 減点)", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(-50);
    expect(result.lastResult).toBe("fail");
  });

  it("failurePenalty 省略時は default 0 で加点しないべき", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-multi",
        probedSlots: [
          { slot: "frontend", path: "/", expectStatus: [200] },
          { slot: "api", path: "/healthz", expectStatus: [200] },
        ],
        pointsAllOk: 100,
      },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.lastResult).toBe("fail");
  });

  it("全 slot が解決不可なら noop になるべき (= deploy 未完了 / stack output 不在)", async () => {
    const input = buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: JSON.stringify({}) },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
  });

  it("override がある slot は override URL を probe すべき", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      overrides: [{ slot: "frontend", overrideUrl: "https://override.example.com/" }],
    });
    await runUptimeMultiKind(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://override.example.com/");
  });

  it("ok→fail 遷移時に attack-detected を emit すべき (= ADR-005 D2-A 互換)", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-multi",
        probedSlots: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsAllOk: 100,
      },
      deployment: { ...buildInput().deployment, lastResult: "ok" },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.attackDetected).toBe(true);
    expect(result.scoreEvents).toContainEqual({
      source: "attack-detected",
      points: 0,
      occurredAt: NOW_ISO,
    });
  });

  it("appendPath を含む slot default URL を組み立てて probe すべき", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-multi",
        probedSlots: [{ slot: "users", path: "/score", expectStatus: [200] }],
        pointsAllOk: 100,
      },
      slots: [
        {
          slot: "users",
          default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
          overridable: true,
        },
      ],
      deployment: {
        ...buildInput().deployment,
        stackOutputs: JSON.stringify({ BaseUrl: "https://api.example.com/" }),
      },
    });
    await runUptimeMultiKind(input);
    // joinUrl は appendPath (/users) と probe path (/score) を path-style concat する。
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/users/score");
  });
});
