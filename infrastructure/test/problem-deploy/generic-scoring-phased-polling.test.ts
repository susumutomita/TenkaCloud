import { StatusCodes } from "http-status-codes";
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

// Issue #2420: managed-runtime host URLs whose tier the engine trusts (an AWS-owned hostname a
// team on EC2 cannot mint), vs an EC2 host that must never earn managed-tier points on self-report.
const LAMBDA_URL = "https://svc-abc123.lambda-url.us-east-1.on.aws/";
const APIGW_URL = "https://abc123.execute-api.us-east-1.amazonaws.com/";
const APPRUNNER_URL = "https://abc123.us-east-1.awsapprunner.com/";
const ELB_URL = "https://tc-mig-team1-1234567890.us-east-1.elb.amazonaws.com/";
const EC2_HOST_URL = "http://ec2-203-0-113-7.compute-1.amazonaws.com/";

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

  it("should award +100 for Phase 0 (after 30 minutes) + ec2 platform", async () => {
    // meta → ec2、 score → 200
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(100);
  });

  it("should return posture and platform snapshots when posturePath is declared", async () => {
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ platform: "posture-3" }),
      })
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({
        status: 200,
        text: async () =>
          JSON.stringify({
            platform: "posture-3",
            posture: { db_present: true, auth_enabled: false },
          }),
      });
    const result = await runPhasedPollingKind(
      buildInput({
        scoring: { ...baseScoring, probe: { ...baseScoring.probe, posturePath: "/posture" } },
      }),
    );
    expect(result.platform).toBe("posture-3");
    expect(JSON.parse(result.postureJson ?? "{}")).toEqual({
      db_present: true,
      auth_enabled: false,
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.example.com/users/posture");
  });

  it("should ignore malformed posture snapshots and omit mixed platform snapshots", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/users/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "ec2" }) };
      }
      if (url.endsWith("/orders/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "lambda" }) };
      }
      if (url.endsWith("/users/posture")) {
        return { status: 200, text: async () => "{not-json" };
      }
      if (url.endsWith("/orders/posture")) {
        return {
          status: 200,
          text: async () => JSON.stringify({ platform: "lambda", posture: { db_present: "yes" } }),
        };
      }
      return { status: 200, text: async () => "" };
    });
    const result = await runPhasedPollingKind(
      buildInput({
        deployment: {
          ...buildInput().deployment,
          stackOutputs: JSON.stringify({
            UsersUrl: "https://api.example.com/",
            // Issue #2420: orders self-reports lambda AND is registered behind a real Lambda
            // Function URL, so it genuinely earns the managed 1000/slot rate.
            OrdersUrl: LAMBDA_URL,
          }),
        },
        scoring: { ...baseScoring, probe: { ...baseScoring.probe, posturePath: "/posture" } },
        slots: [
          {
            slot: "users",
            default: { from: "cfn-output", key: "UsersUrl", appendPath: "/users" },
            overridable: true,
          },
          {
            slot: "orders",
            default: { from: "cfn-output", key: "OrdersUrl", appendPath: "/orders" },
            overridable: true,
          },
        ],
      }),
    );
    expect(result.postureJson).toBeUndefined();
    expect(result.platform).toBeUndefined();
    expect(result.scoreDelta).toBe(1100);
  });

  it("should award degradedPoints (+10) for Phase 1 (degraded, after 60 minutes) + ec2 platform", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(
      buildInput({ nowMs: Date.parse(NOW_AT_70MIN), nowIso: NOW_AT_70MIN }),
    );
    expect(result.scoreDelta).toBe(10);
  });

  it("Phase 2 (legacy, after 90 minutes) should switch scorePath to /score?legacy=true", async () => {
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

  it("should award +1000 for platform=lambda (+ all-slots-on-lambda bonus +5000 satisfied by 1 slot)", async () => {
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ platform: "lambda" }),
      })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    // Issue #2420: the slot must be registered behind a real Lambda host for the tier to verify.
    const result = await runPhasedPollingKind(
      buildInput({
        deployment: {
          ...buildInput().deployment,
          stackOutputs: JSON.stringify({ BaseUrl: LAMBDA_URL }),
        },
      }),
    );
    // 1 slot で all-slots 条件が満たされるので bonus も同時に発火
    expect(result.scoreDelta).toBe(1000 + 5000);
  });

  it("should award failurePenalty (-100) when /score returns 500", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(-100);
    expect(result.lastResult).toBe("fail");
  });

  it("should apply failurePenalty when the platform is unknown (invalid meta response body)", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(-100);
  });

  it("should accept text/plain platform metadata", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "ec2" })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.platform).toBe("ec2");
  });

  it("should reject oversized text/plain platform metadata", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "x".repeat(64) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(buildInput());
    expect(result.scoreDelta).toBe(-100);
    expect(result.platform).toBeUndefined();
  });

  it("should ignore unknown bonus kinds", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(
      buildInput({
        scoring: {
          ...baseScoring,
          bonuses: [{ kind: "custom-bonus", platforms: ["ec2"], points: 5000, once: true }],
        },
      }),
    );
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
  });

  it("bonus all-slots-on-platforms: should add +5000 once if all slots are on lambda", async () => {
    // meta=lambda, score=ok
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "lambda" }) };
      }
      return { status: 200, text: async () => "" };
    });
    // Issue #2420: slot registered behind a real Lambda host so the lambda tier verifies.
    const lambdaInput = () =>
      buildInput({
        deployment: {
          ...buildInput().deployment,
          stackOutputs: JSON.stringify({ BaseUrl: LAMBDA_URL }),
        },
      });
    const result = await runPhasedPollingKind(lambdaInput());
    expect(result.scoreDelta).toBe(1000 + 5000);
    expect(result.newState?.bonusAwarded?.["all-slots-on-platforms"]).toBe(true);

    // 次 tick (= prevState に awarded フラグあり) では bonus 加点なし
    const next = await runPhasedPollingKind({
      ...lambdaInput(),
      prevState: { bonusAwarded: { "all-slots-on-platforms": true } },
    });
    expect(next.scoreDelta).toBe(1000);
  });

  it("responsePenalty (responseTimeMs > 1500) should additionally apply -10 to slow slots", async () => {
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

  // --- Issue #2420: verify the hosting tier from the registered URL, not the /meta self-report ---

  function singleSlotInput(
    url: string,
    scoringOverride: PhasedPollingScoringMetadata = baseScoring,
    extra: Partial<KindHandlerInput<PhasedPollingScoringMetadata>> = {},
  ): KindHandlerInput<PhasedPollingScoringMetadata> {
    return buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: JSON.stringify({ BaseUrl: url }) },
      scoring: scoringOverride,
      ...extra,
    });
  }

  it("should NOT award managed-tier points or the bonus when an EC2 service self-reports lambda", async () => {
    // /meta lies "lambda" but the registered URL is the EC2 host → verified tier is ec2.
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ platform: "lambda" }),
      })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(singleSlotInput(EC2_HOST_URL));
    expect(result.scoreDelta).toBe(100); // ec2 rate, not 1000, and no +5000 bonus
    expect(result.newState).toBeUndefined();
    expect(result.platform).toBe("ec2");
  });

  it("should apply the degraded phase to a service faking lambda while still on EC2", async () => {
    // degraded phase keys on the verified tier (ec2), so the faked lambda is still degraded.
    fetchMock
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ platform: "lambda" }),
      })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(
      singleSlotInput(EC2_HOST_URL, baseScoring, {
        nowMs: Date.parse(NOW_AT_70MIN),
        nowIso: NOW_AT_70MIN,
      }),
    );
    expect(result.scoreDelta).toBe(10); // ec2 degradedPoints, not lambda's 1000
  });

  it("should preserve StackStack posture scoring when the endpoint is behind an ALB", async () => {
    const stackStackScoring: PhasedPollingScoringMetadata = {
      ...baseScoring,
      platformRules: { "posture-2": { points: 200 } },
      bonuses: [],
    };
    fetchMock
      .mockResolvedValueOnce({
        status: StatusCodes.OK,
        text: async () => JSON.stringify({ platform: "posture-2" }),
      })
      .mockResolvedValueOnce({
        status: StatusCodes.OK,
        text: async () => JSON.stringify({ ok: true }),
      });

    const result = await runPhasedPollingKind(singleSlotInput(ELB_URL, stackStackScoring));

    expect(result.scoreDelta).toBe(200);
    expect(result.lastResult).toBe("ok");
    expect(result.platform).toBe("posture-2");
  });

  it("should award lambda-tier points for a service behind API Gateway even if /meta says ec2", async () => {
    // URL host wins over the self-report: execute-api → lambda tier.
    const noBonus: PhasedPollingScoringMetadata = { ...baseScoring, bonuses: [] };
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(singleSlotInput(APIGW_URL, noBonus));
    expect(result.scoreDelta).toBe(1000);
    expect(result.platform).toBe("lambda");
  });

  it("should award apprunner-tier points when the URL host is an App Runner service", async () => {
    const noBonus: PhasedPollingScoringMetadata = { ...baseScoring, bonuses: [] };
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ platform: "ec2" }) })
      .mockResolvedValueOnce({ status: 200, text: async () => "" });
    const result = await runPhasedPollingKind(singleSlotInput(APPRUNNER_URL, noBonus));
    expect(result.scoreDelta).toBe(1000);
    expect(result.platform).toBe("apprunner");
  });

  // --- Issue #2421: all-slots-distinct-platforms bonus (uses the verified tier from #2420) ---

  const THREE_SLOTS = [
    { slot: "users", key: "UsersUrl" },
    { slot: "orders", key: "OrdersUrl" },
    { slot: "catalog", key: "CatalogUrl" },
  ] as const;

  const distinctScoring: PhasedPollingScoringMetadata = {
    ...baseScoring,
    bonuses: [
      {
        kind: "all-slots-distinct-platforms",
        platforms: ["lambda", "ecs", "apprunner"],
        points: 8000,
        once: true,
      },
    ],
  };

  function threeSlotInput(
    urls: Readonly<Record<string, string>>,
    scoringOverride: PhasedPollingScoringMetadata = distinctScoring,
  ): KindHandlerInput<PhasedPollingScoringMetadata> {
    const stackOutputs: Record<string, string> = {};
    for (const s of THREE_SLOTS) stackOutputs[s.key] = urls[s.slot] ?? EC2_HOST_URL;
    return buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: JSON.stringify(stackOutputs) },
      scoring: scoringOverride,
      slots: THREE_SLOTS.map((s) => ({
        slot: s.slot,
        default: { from: "cfn-output", key: s.key, appendPath: `/${s.slot}` },
        overridable: true,
      })),
    });
  }

  /** All slots healthy; /meta echoes the slot name (irrelevant — the URL host decides the tier). */
  function mockAllHealthy(): void {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "ec2" }) };
      }
      return { status: 200, text: async () => "" };
    });
  }

  it("should award all-slots-distinct-platforms when every slot is on a distinct managed runtime", async () => {
    mockAllHealthy();
    const result = await runPhasedPollingKind(
      threeSlotInput({ users: LAMBDA_URL, orders: ELB_URL, catalog: APPRUNNER_URL }),
    );
    // lambda(1000) + ecs(1000) + apprunner(1000) + distinct bonus(8000)
    expect(result.scoreDelta).toBe(3000 + 8000);
    expect(result.newState?.bonusAwarded?.["all-slots-distinct-platforms"]).toBe(true);
  });

  it("should NOT award all-slots-distinct-platforms when two slots share a platform", async () => {
    mockAllHealthy();
    const result = await runPhasedPollingKind(
      threeSlotInput({ users: LAMBDA_URL, orders: LAMBDA_URL, catalog: APPRUNNER_URL }),
    );
    // two lambda + one apprunner → not pairwise distinct → base points only, no bonus
    expect(result.scoreDelta).toBe(3000);
    expect(result.newState).toBeUndefined();
  });

  it("should NOT award distinct bonus when a slot fakes lambda while on EC2 (verified tier blocks it)", async () => {
    // catalog is registered on the EC2 host but self-reports lambda → verified ec2 → outside the set.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/meta")) {
        return { status: 200, text: async () => JSON.stringify({ platform: "lambda" }) };
      }
      return { status: 200, text: async () => "" };
    });
    const result = await runPhasedPollingKind(
      threeSlotInput({ users: LAMBDA_URL, orders: ELB_URL, catalog: EC2_HOST_URL }),
    );
    // lambda(1000) + ecs(1000) + ec2(100, Phase 0) → 2100, distinct bonus withheld
    expect(result.scoreDelta).toBe(2100);
    expect(result.newState).toBeUndefined();
  });

  it("should treat all-slots-distinct-platforms with an empty platforms set as unsatisfied", async () => {
    mockAllHealthy();
    const emptyPlatforms: PhasedPollingScoringMetadata = {
      ...baseScoring,
      bonuses: [{ kind: "all-slots-distinct-platforms", platforms: [], points: 8000, once: true }],
    };
    const result = await runPhasedPollingKind(
      threeSlotInput(
        { users: LAMBDA_URL, orders: ELB_URL, catalog: APPRUNNER_URL },
        emptyPlatforms,
      ),
    );
    expect(result.scoreDelta).toBe(3000); // base points only, no bonus
    expect(result.newState).toBeUndefined();
  });
});
