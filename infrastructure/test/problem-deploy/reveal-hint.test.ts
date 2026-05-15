import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { revealHint } from "../../lib/problem-deploy/handlers/participant-handler/reveal-hint";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import type { ProblemScoringMetadata } from "../../lib/utils/scoring-metadata";

const TEAM_KEY = "team-key-abc";
const TEAM_PK = "DEPLOYMENT#01HZX0K3M3K9ZQHB3MRQHBA1B2";

function buildShared(): { shared: ParticipantSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    ssm: undefined,
    env: undefined,
    problemsScoring: {},
    problemsEndpoints: {},
  };
  return { shared, ddbSend };
}

const DEFAULT_HINTS = [
  { id: "hint-1", content: "use AWS Console", penalty: 10 },
  { id: "hint-2", content: "check SSM", penalty: 20 },
];

function buildScoringMap(
  hints?: { id: string; content: string; penalty: number }[] | null,
): Record<string, ProblemScoringMetadata> {
  // hints === undefined (引数省略時) は DEFAULT_HINTS を使う。 hints === null は明示的に
  // 「hints 未定義の scoring」 を表現するため空 object に差し替える。
  const resolved = hints === undefined ? DEFAULT_HINTS : hints;
  return {
    "hello-world": {
      kind: "flag",
      flagOutputKey: "ParameterValue",
      points: 100,
      ...(resolved && resolved.length > 0 ? { hints: resolved } : {}),
    },
  };
}

function sampleRow(over: Record<string, unknown> = {}) {
  return {
    PK: TEAM_PK,
    SK: "META",
    jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
    problemId: "hello-world",
    teamLoginKey: TEAM_KEY,
    score: 100,
    ...over,
  };
}

describe("revealHint (#742 Phase 3)", () => {
  it("team が見つからなければ unauthorized を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const result = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("unauthorized");
  });

  it("該当 problemId の deployment が無ければ unauthorized", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ problemId: "other-problem" })],
    });
    const result = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("unauthorized");
  });

  it("kind=flag 以外の問題は not_flag_problem", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    const scoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "uptime-flat",
        endpoints: [{ slot: "main", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
    };
    const result = await revealHint(shared, scoring, TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("not_flag_problem");
  });

  it("不在 hintId は unknown_hint", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    const result = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-99");
    expect(result.kind).toBe("unknown_hint");
  });

  it("scoring.hints が未定義なら unknown_hint", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    const result = await revealHint(
      shared,
      buildScoringMap(null),
      TEAM_KEY,
      "hello-world",
      "hint-1",
    );
    expect(result.kind).toBe("unknown_hint");
  });

  it("初回 reveal: UpdateItem が list_append + score ADD で呼ばれ、 ok を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 90 } });
    const result = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toBe("use AWS Console");
    expect(result.penaltyApplied).toBe(10);
    expect(result.totalScore).toBe(90);

    // UpdateCommand の content を確認
    const updateCall = ddbSend.mock.calls[1]?.[0] as UpdateCommand | undefined;
    expect(updateCall).toBeInstanceOf(UpdateCommand);
    const input = updateCall?.input as {
      UpdateExpression?: string;
      ConditionExpression?: string;
      ExpressionAttributeValues?: { ":neg"?: number; ":record"?: unknown[] };
    };
    expect(input.UpdateExpression).toContain("list_append");
    expect(input.UpdateExpression).toContain("ADD score :neg");
    expect(input.ConditionExpression).toContain("NOT contains");
    expect(input.ExpressionAttributeValues?.[":neg"]).toBe(-10);
  });

  it("既に reveal 済の hintId は already_revealed (= content + 既存 score を返す、 idempotent)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          score: 80,
          hintsRevealed: [
            { hintId: "hint-1", revealedAt: "2026-05-15T01:00:00.000Z", penaltyApplied: 10 },
          ],
        }),
      ],
    });
    const result = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("already_revealed");
    if (result.kind !== "already_revealed") return;
    expect(result.content).toBe("use AWS Console");
    expect(result.penaltyApplied).toBe(10);
    expect(result.totalScore).toBe(80);
    // DDB UpdateCommand は呼ばれない (= score 二重 deduct を防ぐ)。
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("DDB ConditionalCheckFailedException (= race) は already_revealed として返す", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 90 })] });
    const conditionalError = Object.assign(new Error("conditional"), {
      name: "ConditionalCheckFailedException",
    });
    ddbSend.mockRejectedValueOnce(conditionalError);
    const result = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("already_revealed");
  });

  it("penalty=0 hint も ok で reveal でき、 score は変わらない (= 旧 legacy v1 が変換されたパターン)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const scoring = buildScoringMap([{ id: "hint-1", content: "free hint", penalty: 0 }]);
    const result = await revealHint(shared, scoring, TEAM_KEY, "hello-world", "hint-1");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.penaltyApplied).toBe(0);
    expect(result.totalScore).toBe(100);
    const updateCall = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(
      (updateCall.input as { ExpressionAttributeValues?: { ":neg"?: number } })
        .ExpressionAttributeValues?.[":neg"],
    ).toBe(0);
  });

  it("非 ConditionalCheckFailedException の DDB error は throw する (= 上位 internal_error)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockRejectedValueOnce(new Error("DDB throttle"));
    await expect(
      revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1"),
    ).rejects.toThrow(/DDB throttle/);
  });
});
