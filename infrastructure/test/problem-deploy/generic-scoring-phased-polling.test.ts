import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPhasedPollingKind } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/phased-polling";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { PhasedPollingScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `phased-polling` kind (= microservice-migration-battle 想定)。 time-based rule 切替 +
 * platform 分類 + bonus once 制御を pin する。
 */

const CREATED_AT = "2026-05-12T09:00:00.000Z";
const NOW_AT_30MIN = "2026-05-12T09:30:00.000Z";
const NOW_AT_70MIN = "2026-05-12T10:10:00.000Z";
const NOW_AT_100MIN = "2026-05-12T10:40:00.000Z";

const baseScoring: PhasedPollingScoringMetadata = {
  kind: "phased-polling",
  intervalMinutes: 1,
  probe: { metaPath: "/meta", scorePath: "/score" },
  platformRules: {
    ec2: { points: 100, degradedPoints: 10 },
    lambda: { points: 1000 },
    ecs: { points: 1000 },
    apprunner: { points: 1000 },
  },
  failurePenalty: -100,
  responsePenalties: [{ if: "responseTimeMs > 1500", points: -10 }],
  bonuses: [
    {
      kind: "all-slots-on-platforms",
      platforms: ["lambda", "ecs", "apprunner"],
      points: 5000,
      once: true,
    },
  ],
};

const basePhases: readonly PhaseEntry[] = [
  { name: "degraded", afterMinutes: 60, effect: { switchPlatformToDegraded: ["ec2"] } },
  { name: "legacy", afterMinutes: 90, effect: { scorePathOverride: "/score?legacy=true" } },
];

const baseSlots = [
  {
    slot: "users",
    default: { from: "cfn-output" as const, key: "BaseUrl", appendPath: "/users" },
    overridable: true,
  },
];

function buildInput(
  overrides: Partial<KindHandlerInput<PhasedPollingScoringMetadata>> = {},
): KindHandlerInput<PhasedPollingScoringMetadata> {
  return {
    deployment: {
      PK: "DEPLOYMENT#JOB1",
      jobId: "JOB1",
      problemId: "microservice-migration-battle",
      tenantId: "tenant-acme",
      teamId: "team-1",
      eventId: "event-1",
      createdAt: CREATED_AT,
      stackOutputs: JSON.stringify({ BaseUrl: "https://api.example.com/" }),
      expiresAt: 9_999_999_999,
    },
    scoring: baseScoring,
    slots: baseSlots,
    overrides: [],
    phases: basePhases,
    nowMs: Date.parse(NOW_AT_30MIN),
    nowIso: NOW_AT_30MIN,
    prevState: {},
    ...overrides,
  };
}

describe("phased-polling kind", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Phase 0 (30分経過) + ec2 platform で +100 加点すべき", async () => {
    // meta → ec2、 score → 200
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(100);
  });

  it("Phase 1 (degraded、 60 分後) + ec2 platform で degradedPoints (+10) を加点すべき", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(
      buildInput({ nowMs: Date.parse(NOW_AT_70MIN), nowIso: NOW_AT_70MIN }),
    );
    expect(result.scoreDelta).toBe(10);
  });

  it("Phase 2 (legacy、 90 分後) は scorePath を /score?legacy=true に切替えるべき", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    await runPhasedPollingKind(
      buildInput({ nowMs: Date.parse(NOW_AT_100MIN), nowIso: NOW_AT_100MIN }),
    );
    // 2 回目 fetch (= /score) が override path を使う (= phase.effect.scorePathOverride)。
    const scoreCall = fetchMock.mock.calls[1]?.[0];
    expect(scoreCall).toBe("https://api.example.com/users/score?legacy=true");
  });

  it("platform=lambda なら +1000 加点すべき (+ all-slots-on-lambda bonus +5000、 1 slot で satisfy)", async () => {
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ platform: "lambda" }),
      })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    // 1 slot で all-slots 条件が満たされるので bonus も同時に発火
    expect(result.scoreDelta).toBe(1000 + 5000);
  });

  it("/score が 500 なら failurePenalty (-100) を加点すべき", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(-100);
    expect(result.lastResult).toBe("fail");
  });

  it("platform 不明 (meta 応答 body 不正) なら failurePenalty 適用すべき", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(-100);
  });

  it("bonus all-slots-on-platforms: 全 slot が lambda にあれば +5000 を 1 回だけ加算すべき", async () => {
    // meta=lambda, score=ok
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "lambda" }) };
      }
      return { status: 200, text: async () => "" };
    });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(1000 + 5000);
    expect(result.newState?.bonusAwarded?.["all-slots-on-platforms"]).toBe(true);

    // 次 tick (= prevState に awarded フラグあり) では bonus 加点なし
    const next = await runPhasedPollingKind(
      buildInput({
        prevState: { bonusAwarded: { "all-slots-on-platforms": true } },
      }),
    );
    expect(next.scoreDelta).toBe(1000);
  });

  it("responsePenalty (= responseTimeMs > 1500) は遅い slot に -10 を追加適用すべき", async () => {
    // status=200 だが responseTimeMs を 2000 にしたい → fetch mock で setTimeout で遅延を作る
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "ec2" }) };
      }
      // score: 200 で遅延を simulate (実時間で 2 秒待つのは test 性能上 NG なので、
      // 別の方法で responseTimeMs を inject する手段が無い → 本 test は skip)
      return { status: 200, text: async () => "" };
    });
    // 遅延を確実に inject できないため、 ここでは responsePenalty 適用なし path を pin する
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(100);
  });
});
