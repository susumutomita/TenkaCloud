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

describe("uptime-flat kind (ADR-012 Phase 3.B、 legacy uptime probe 動作不変)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("全 endpoint が 200 を返したら pointsPerSuccess を加算し ok event を 1 件 emit すべき", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeFlatKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 100, occurredAt: NOW_ISO }]);
    expect(result.lastResult).toBe("ok");
  });

  it("1 endpoint が fail でも全 ok でない限り scoreDelta=0 になるべき (= 既存 health-check 挙動)", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runUptimeFlatKind(buildInput());
    expect(result.scoreDelta).toBe(0);
    expect(result.lastResult).toBe("fail");
  });

  it("直前 tick が ok で今 tick fail なら attack-detected event を emit すべき (= ADR-005 D2-A)", async () => {
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

  it("連続 fail tick では attack-detected を再 emit しないべき (= 重複 write 防止 hard guard)", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      deployment: { ...buildInput().deployment, lastResult: "fail" },
    });
    const result = await runUptimeFlatKind(input);
    expect(result.attackDetected).toBeUndefined();
    expect(result.scoreEvents).toEqual([]);
  });

  it("endpointsHealth JSON に slot/outputKey ごとの ok / checkedAt を書き戻すべき", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeFlatKind(buildInput());
    const health = JSON.parse(result.endpointsHealthJson ?? "{}");
    expect(health.FrontendUrl).toMatchObject({ ok: true, checkedAt: NOW_ISO });
    expect(health.ApiUrl).toMatchObject({ ok: true, checkedAt: NOW_ISO });
  });

  it("slot 経由で metadata.endpoints の default URL を解決すべき (ADR-012 Phase 3.B 新規)", async () => {
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

  it("override がある slot は override URL を probe すべき", async () => {
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

  it("stackOutputs が無いと noop (= deploy 未完了で probe しない)", async () => {
    const input = buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: undefined },
    });
    const result = await runUptimeFlatKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('legacy `kind: "uptime"` 入力でも flat probe として動くべき (= alias 互換)', async () => {
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
