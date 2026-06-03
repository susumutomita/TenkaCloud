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

  it("should award pointsAllOk when all slots return 200", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 100, occurredAt: NOW_ISO }]);
    expect(result.lastResult).toBe("ok");
  });

  it("should add failurePenalty when 1 slot fails (negative value = deduction)", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(-50);
    expect(result.lastResult).toBe("fail");
  });

  it("should default failurePenalty to 0 and not award anything when omitted", async () => {
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

  it("should noop when no slot can be resolved (deploy not yet complete / stack output absent)", async () => {
    const input = buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: JSON.stringify({}) },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
  });

  it("should probe the override URL for slots with an override", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      overrides: [{ slot: "frontend", overrideUrl: "https://override.example.com/" }],
    });
    await runUptimeMultiKind(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://override.example.com/");
  });

  it("should emit attack-detected on ok→fail transition (ADR-005 D2-A compat)", async () => {
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

  it("should build the slot default URL including appendPath and probe it", async () => {
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

  // [ADR-034 / #1666] optional attack-blocked bonus: アプリの counter endpoint を live probe して防御加点。
  function withAttackBonus(
    prevAttackCount: number | undefined,
  ): KindHandlerInput<UptimeMultiScoringMetadata> {
    const base = buildInput();
    return {
      ...base,
      scoring: {
        kind: "uptime-multi",
        probedSlots: base.scoring.probedSlots,
        pointsAllOk: 100,
        attackBlocked: { slot: "api", path: "/attack-stats", pointsPerBlock: 25 },
      },
      prevState: prevAttackCount === undefined ? {} : { attackCount: prevAttackCount },
    };
  }

  /** slot probe は 200/空、 counter endpoint (/attack-stats) は body にブロック回数を返す fetch mock。 */
  function mockProbesWithCounter(blockedCount: string): void {
    fetchMock.mockImplementation(async (url: string) => ({
      status: 200,
      url,
      text: async () => (url.includes("/attack-stats") ? blockedCount : ""),
    }));
  }

  it("should add an attack-blocked bonus on counter increment (defense held)", async () => {
    mockProbesWithCounter("5");
    const result = await runUptimeMultiKind(withAttackBonus(2)); // delta 3 × 25 = 75
    expect(result.scoreDelta).toBe(175); // pointsAllOk 100 + bonus 75
    expect(result.newState).toEqual({ attackCount: 5 });
    expect(result.scoreEvents).toEqual([
      { source: "uptime", points: 100, occurredAt: NOW_ISO },
      { source: "uptime", points: 75, occurredAt: NOW_ISO },
    ]);
  });

  it("should only record the baseline on the first tick (no bonus yet)", async () => {
    mockProbesWithCounter("5");
    const result = await runUptimeMultiKind(withAttackBonus(undefined));
    expect(result.scoreDelta).toBe(100); // availability only; bonus 0 on baseline
    expect(result.newState).toEqual({ attackCount: 5 });
  });

  it("should award no bonus when the counter endpoint is unreachable", async () => {
    // slot probes ok, but the counter endpoint 500s → no bonus, no state.
    fetchMock.mockImplementation(async (url: string) => ({
      status: url.includes("/attack-stats") ? 500 : 200,
      url,
      text: async () => "",
    }));
    const result = await runUptimeMultiKind(withAttackBonus(2));
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
  });

  it("should not set newState or a bonus when attackBlocked is absent (backward compat)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
  });
});
