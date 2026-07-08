import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTenantFlagCacheForTest,
  getJobPrerequisiteBlock,
} from "../../lib/problem-deploy/handlers/participant-handler/challenge-access";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
import { revealHint } from "../../lib/problem-deploy/handlers/participant-handler/reveal-hint";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { submitFlag } from "../../lib/problem-deploy/handlers/participant-handler/submit-flag";
import { setDisplayTeamName } from "../../lib/problem-deploy/handlers/participant-handler/update";
import {
  deleteProblemEndpointOverride,
  listProblemEndpoints,
  upsertProblemEndpointOverride,
} from "../../lib/problem-deploy/handlers/problem-endpoints-handler/endpoints";
import type { ProblemScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * Issue #2283: locked challenge への競技操作が server-side で拒否されることの経路別検証。
 * UI を介さず service 関数を直接呼ぶ (= URL 直打ち / API 直呼び相当) ので、 frontend の
 * 見た目に依存した bypass ができないことを担保する。
 */

const TEAM_KEY = "k".repeat(43);
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const gateConfig = {
  gateProblemId: "hello-world-battle",
  unlockTargetIds: ["stackstack-battle"],
  defaultPolicy: "required" as const,
  teamOverrides: { "team-adv": { policy: "off" as const } },
};

const scoringMap: Record<string, ProblemScoringMetadata> = {
  "stackstack-battle": {
    kind: "flag",
    points: 200,
    flagOutputKey: "FlagValue",
    hints: [{ id: "hint-1", penalty: 10, content: "look closer" }],
  } as ProblemScoringMetadata,
  "hello-world-battle": {
    kind: "uptime-flat",
    pointsPerSuccess: 100,
  } as ProblemScoringMetadata,
};

interface ScenarioOpts {
  gateScore?: number;
  teamId?: string;
  flagEnabled?: boolean;
  gateStored?: boolean;
}

function buildScenario(opts: ScenarioOpts = {}) {
  const send = vi.fn();
  const teamId = opts.teamId ?? "team-beginner";
  const items = [
    {
      PK: "DEPLOYMENT#job-gate",
      SK: "META",
      jobId: "job-gate",
      problemId: "hello-world-battle",
      tenantId: "tenant-test",
      teamId,
      eventId: EVENT_ID,
      teamName: "team-1",
      status: "COMPLETE",
      score: opts.gateScore ?? 0,
      expiresAt: 1234,
      stackOutputs: JSON.stringify({ Ec2HostHint: "host.example" }),
    },
    {
      PK: "DEPLOYMENT#job-target",
      SK: "META",
      jobId: "job-target",
      problemId: "stackstack-battle",
      tenantId: "tenant-test",
      teamId,
      eventId: EVENT_ID,
      teamName: "team-1",
      status: "COMPLETE",
      score: 0,
      expiresAt: 1234,
      stackOutputs: JSON.stringify({ FlagValue: "TC{answer}", ApiUrl: "http://x.example" }),
    },
  ];

  const respondToQuery = (cmd: QueryCommand) =>
    cmd.input.IndexName === "GSI2"
      ? Promise.resolve({ Items: items })
      : // endpoints override query (許可経路のみ到達)。
        Promise.resolve({ Items: [] });

  const respondToGet = (cmd: GetCommand) => {
    if (cmd.input.Key?.SK === "FLAGS") {
      return Promise.resolve({
        Item: { flags: { challengePrerequisiteGate: opts.flagEnabled !== false } },
      });
    }
    // #2436: getEventGate は repository seam (events.getEvent) 経由になり team の tenantId で
    // event 行を tenant scope する。 event META 行に deployment 行と同じ tenantId を持たせて通過させる。
    return Promise.resolve({
      Item: {
        tenantId: "tenant-test",
        status: "READY",
        startsAt: "2020-01-01T00:00:00.000Z",
        ...(opts.gateStored !== false ? { progressionGate: gateConfig } : {}),
      },
    });
  };

  send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof QueryCommand) return respondToQuery(cmd);
    if (cmd instanceof GetCommand) return respondToGet(cmd);
    if (cmd instanceof UpdateCommand) {
      // ReturnValues=ALL_NEW を期待する caller (setDisplayTeamName) 向けに該当行を返す。
      const row = items.find((i) => i.PK === cmd.input.Key?.PK);
      return Promise.resolve({ Attributes: { ...(row ?? {}), score: row?.score ?? 200 } });
    }
    if (cmd instanceof PutCommand) return Promise.resolve({});
    throw new Error("unexpected command");
  });

  const shared = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    endpointsTableName: "TestEndpoints",
    ddb: { send },
    problemsScoring: scoringMap,
    problemsEndpoints: {
      "stackstack-battle": [
        {
          slot: "api",
          overridable: true,
          label: "API",
          default: { from: "cfn-output", key: "ApiUrl" },
        },
      ],
    },
  } as unknown as ParticipantSharedResources;

  return { shared, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTenantFlagCacheForTest();
});

describe("submitFlag with a progression gate", () => {
  it("should reject a flag submission for a locked challenge with the gate problem id", async () => {
    const { shared } = buildScenario();

    const outcome = await submitFlag(
      shared,
      scoringMap,
      TEAM_KEY,
      "stackstack-battle",
      "TC{answer}",
    );

    expect(outcome).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should accept the same submission once the gate is completed", async () => {
    const { shared } = buildScenario({ gateScore: 100 });

    const outcome = await submitFlag(
      shared,
      scoringMap,
      TEAM_KEY,
      "stackstack-battle",
      "TC{answer}",
    );

    expect(outcome.kind).toBe("ok");
  });

  it("should accept the submission when the tenant flag is OFF even with a stored gate config", async () => {
    const { shared } = buildScenario({ flagEnabled: false });

    const outcome = await submitFlag(
      shared,
      scoringMap,
      TEAM_KEY,
      "stackstack-battle",
      "TC{answer}",
    );

    expect(outcome.kind).toBe("ok");
  });

  it("should accept the submission for a team whose override policy is off", async () => {
    const { shared } = buildScenario({ teamId: "team-adv" });

    const outcome = await submitFlag(
      shared,
      scoringMap,
      TEAM_KEY,
      "stackstack-battle",
      "TC{answer}",
    );

    expect(outcome.kind).toBe("ok");
  });
});

describe("revealHint with a progression gate", () => {
  it("should reject a hint reveal for a locked challenge", async () => {
    const { shared } = buildScenario();

    const outcome = await revealHint(shared, scoringMap, TEAM_KEY, "stackstack-battle", "hint-1");

    expect(outcome).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });
});

describe("endpoint overrides with a progression gate", () => {
  it("should reject registering an endpoint for a locked challenge", async () => {
    const { shared } = buildScenario();

    const outcome = await upsertProblemEndpointOverride(
      shared,
      TEAM_KEY,
      "stackstack-battle",
      "api",
      "http://my-endpoint.example",
      "2026-07-02T00:00:00.000Z",
    );

    expect(outcome).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should reject clearing an endpoint override for a locked challenge", async () => {
    const { shared } = buildScenario();

    const outcome = await deleteProblemEndpointOverride(
      shared,
      TEAM_KEY,
      "stackstack-battle",
      "api",
    );

    expect(outcome).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should allow endpoint registration on the gate challenge itself", async () => {
    const { shared } = buildScenario();
    (shared.problemsEndpoints as Record<string, unknown>)["hello-world-battle"] = [
      {
        slot: "frontend",
        overridable: true,
        label: "Frontend",
        default: { from: "cfn-output", key: "Ec2HostHint" },
      },
    ];

    const outcome = await upsertProblemEndpointOverride(
      shared,
      TEAM_KEY,
      "hello-world-battle",
      "frontend",
      "http://my-endpoint.example",
      "2026-07-02T00:00:00.000Z",
    );

    expect(outcome.kind).toBe("ok");
  });

  it("should allow endpoint registration once the gate is completed", async () => {
    const { shared } = buildScenario({ gateScore: 100 });

    const outcome = await upsertProblemEndpointOverride(
      shared,
      TEAM_KEY,
      "stackstack-battle",
      "api",
      "http://my-endpoint.example",
      "2026-07-02T00:00:00.000Z",
    );

    expect(outcome.kind).toBe("ok");
  });
});

describe("listProblemEndpoints with a progression gate", () => {
  it("should not return endpoint URLs for a locked challenge (read path is also gated)", async () => {
    const { shared } = buildScenario();

    const outcome = await listProblemEndpoints(shared, TEAM_KEY, "stackstack-battle");

    expect(outcome).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should list endpoints again once the gate is completed", async () => {
    const { shared } = buildScenario({ gateScore: 100 });

    const outcome = await listProblemEndpoints(shared, TEAM_KEY, "stackstack-battle");

    expect(outcome.kind).toBe("ok");
  });
});

describe("getJobPrerequisiteBlock (Console / CLI / deploy-logs guard)", () => {
  it("should block jobId-based access to a locked challenge's deployment", async () => {
    const { shared } = buildScenario();

    const block = await getJobPrerequisiteBlock(shared, TEAM_KEY, "job-target");

    expect(block).toEqual({
      kind: "challenge_prerequisite_not_met",
      gateProblemId: "hello-world-battle",
    });
  });

  it("should allow jobId-based access to the gate challenge itself", async () => {
    const { shared } = buildScenario();
    expect(await getJobPrerequisiteBlock(shared, TEAM_KEY, "job-gate")).toBeUndefined();
  });

  it("should defer unknown jobIds to the caller's own not_found handling", async () => {
    const { shared } = buildScenario();
    expect(await getJobPrerequisiteBlock(shared, TEAM_KEY, "job-nope")).toBeUndefined();
  });
});

describe("PATCH /portal/me with a progression gate", () => {
  it("should strip locked problems' stackOutputs from the rename response too", async () => {
    const { shared } = buildScenario();

    const outcome = await setDisplayTeamName(shared, TEAM_KEY, "renamed team");

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const locked = outcome.view.problems.find((p) => p.problemId === "stackstack-battle");
    expect(locked?.stackOutputs).toEqual({});
    expect(outcome.view.progression?.lockedProblemIds).toEqual(["stackstack-battle"]);
  });
});

describe("GET /portal/me progression view", () => {
  it("should include the progression view and strip stackOutputs of locked problems", async () => {
    const { shared } = buildScenario();

    const view = await lookupTeamByLoginKey(shared, TEAM_KEY);

    expect(view?.progression).toEqual({
      gateProblemId: "hello-world-battle",
      gateCompleted: false,
      policy: "required",
      completionBonus: 0,
      lockedProblemIds: ["stackstack-battle"],
    });
    const locked = view?.problems.find((p) => p.problemId === "stackstack-battle");
    expect(locked?.stackOutputs).toEqual({});
    const gateProblem = view?.problems.find((p) => p.problemId === "hello-world-battle");
    expect(gateProblem?.stackOutputs).toMatchObject({ Ec2HostHint: "host.example" });
  });

  it("should omit the progression view and keep outputs when the tenant flag is OFF", async () => {
    const { shared } = buildScenario({ flagEnabled: false });

    const view = await lookupTeamByLoginKey(shared, TEAM_KEY);

    expect(view?.progression).toBeUndefined();
    const target = view?.problems.find((p) => p.problemId === "stackstack-battle");
    // flag OFF では答え (FlagValue) だけ strip され、 接続情報は従来どおり見える。
    expect(target?.stackOutputs).toMatchObject({ ApiUrl: "http://x.example" });
  });

  it("should report gateCompleted and restore outputs after the gate is done", async () => {
    const { shared } = buildScenario({ gateScore: 100 });

    const view = await lookupTeamByLoginKey(shared, TEAM_KEY);

    expect(view?.progression).toMatchObject({ gateCompleted: true, lockedProblemIds: [] });
    const target = view?.problems.find((p) => p.problemId === "stackstack-battle");
    expect(target?.stackOutputs).toMatchObject({ ApiUrl: "http://x.example" });
  });
});
