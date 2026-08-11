import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUptimeFlatKind } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-flat";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { UptimeFlatScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `uptime-flat` kind (= 旧 health-check-handler の uptime 採点を Phase 3.B で kind dispatcher
 * に移管した経路)。 hello-world-battle の挙動が unchanged であることを pin する。
 */

const NOW_ISO = "2026-05-12T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function buildInput(
  overrides: Partial<KindHandlerInput<UptimeFlatScoringMetadata>> = {},
): KindHandlerInput<UptimeFlatScoringMetadata> {
  const scoring: UptimeFlatScoringMetadata = {
    kind: "uptime-flat",
    endpoints: [
      { outputKey: "FrontendUrl", path: "/", expectStatus: [200] },
      { outputKey: "ApiUrl", path: "/healthz", expectStatus: [200] },
    ],
    pointsPerSuccess: 100,
  };
  return {
    deployment: {
      PK: "DEPLOYMENT#JOB1",
      jobId: "JOB1",
      problemId: "hello-world-battle",
      tenantId: "tenant-acme",
      teamId: "team-1",
      eventId: "event-1",
      stackOutputs: JSON.stringify({
        FrontendUrl: "https://frontend.example.com",
        ApiUrl: "https://api.example.com",
      }),
      expiresAt: 9_999_999_999,
    },
    scoring,
    slots: [],
    overrides: [],
    phases: [] as readonly PhaseEntry[],
    nowMs: NOW_MS,
    nowIso: NOW_ISO,
    prevState: {},
    ...overrides,
  };
}

describe("uptime-flat kind legacy uptime probe compatibility", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should add pointsPerSuccess and emit 1 ok event when all endpoints return 200", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeFlatKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 100, occurredAt: NOW_ISO }]);
    expect(result.lastResult).toBe("ok");
  });

  it("should return scoreDelta=0 if a single endpoint fails (existing health-check behavior)", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runUptimeFlatKind(buildInput());
    expect(result.scoreDelta).toBe(0);
    expect(result.lastResult).toBe("fail");
  });

  it("should deduct failurePenalty (opt-in) on a failed tick and emit a negative uptime event", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runUptimeFlatKind(
      buildInput({
        scoring: {
          kind: "uptime-flat",
          endpoints: [
            { outputKey: "FrontendUrl", path: "/", expectStatus: [200] },
            { outputKey: "ApiUrl", path: "/healthz", expectStatus: [200] },
          ],
          pointsPerSuccess: 100,
          failurePenalty: -100,
        },
      }),
    );
    expect(result.scoreDelta).toBe(-100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: -100, occurredAt: NOW_ISO }]);
    expect(result.lastResult).toBe("fail");
  });

  it("should still award pointsPerSuccess when all endpoints are ok even with failurePenalty set", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeFlatKind(
      buildInput({
        scoring: {
          kind: "uptime-flat",
          endpoints: [
            { outputKey: "FrontendUrl", path: "/", expectStatus: [200] },
            { outputKey: "ApiUrl", path: "/healthz", expectStatus: [200] },
          ],
          pointsPerSuccess: 100,
          failurePenalty: -100,
        },
      }),
    );
    expect(result.scoreDelta).toBe(100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 100, occurredAt: NOW_ISO }]);
  });

  it("should emit an attack-detected event when previous tick was ok and current tick fails", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      deployment: {
        ...buildInput().deployment,
        lastResult: "ok",
      },
    });
    const result = await runUptimeFlatKind(input);
    expect(result.attackDetected).toBe(true);
    expect(result.scoreEvents).toEqual([
      { source: "attack-detected", points: 0, occurredAt: NOW_ISO },
    ]);
  });

  it("should not re-emit attack-detected on consecutive fail ticks (hard guard against duplicate writes)", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      deployment: { ...buildInput().deployment, lastResult: "fail" },
    });
    const result = await runUptimeFlatKind(input);
    expect(result.attackDetected).toBeUndefined();
    expect(result.scoreEvents).toEqual([]);
  });

  it("should write back per-slot/outputKey ok / checkedAt into endpointsHealth JSON", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeFlatKind(buildInput());
    const health = JSON.parse(result.endpointsHealthJson ?? "{}");
    expect(health.FrontendUrl).toMatchObject({ ok: true, checkedAt: NOW_ISO });
    expect(health.ApiUrl).toMatchObject({ ok: true, checkedAt: NOW_ISO });
  });

  it("should resolve metadata.endpoints default URLs via slot", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-flat",
        endpoints: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
      slots: [
        {
          slot: "frontend",
          default: { from: "cfn-output", key: "FrontendUrl" },
          overridable: false,
        },
      ],
    });
    const result = await runUptimeFlatKind(input);
    expect(result.scoreDelta).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toBe("https://frontend.example.com/");
  });

  it("should probe the override URL for slots with an override", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-flat",
        endpoints: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
      slots: [
        {
          slot: "frontend",
          default: { from: "cfn-output", key: "FrontendUrl" },
          overridable: true,
        },
      ],
      overrides: [{ slot: "frontend", overrideUrl: "https://my-override.example.com/" }],
    });
    await runUptimeFlatKind(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://my-override.example.com/");
  });

  it("should noop when stackOutputs is missing (don't probe pre-deploy)", async () => {
    const input = buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: undefined },
    });
    const result = await runUptimeFlatKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should run as a flat probe for legacy `kind: "uptime"` input (alias compat)', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 100,
      },
    });
    const result = await runUptimeFlatKind(input);
    expect(result.scoreDelta).toBe(100);
  });
});
