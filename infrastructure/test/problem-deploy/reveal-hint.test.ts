import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { revealHint } from "../../lib/problem-deploy/handlers/participant-handler/reveal-hint";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import type { ProblemScoringMetadata } from "../../lib/utils/scoring-metadata";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const TEAM_KEY = "team-key-abc";
const TEAM_PK = "DEPLOYMENT#01HZX0K3M3K9ZQHB3MRQHBA1B2";

function buildShared(): { shared: ParticipantSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    runtime: makeTestControlDataRuntime(),
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
  it("should return unauthorized when the team is not found", async () => {
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

  it("first reveal: UpdateItem should be called with list_append + score ADD and return ok", async () => {
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

  // ---- Issue #1315: progressive hint の順序制約 (= Hint N は Hint 1..N-1 reveal 後のみ) ----
  describe("hint reveal order constraint (Issue #1315)", () => {
    it("should accept reveal of hint 1 unconditionally (no predecessor)", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] });
      ddbSend.mockResolvedValueOnce({ Attributes: { score: 90 } });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("ok");
    });

    it("should reject reveal of hint 2 when hint 1 not yet revealed", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100, hintsRevealed: [] })] });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-2");
      expect(out.kind).toBe("hint_out_of_order");
      if (out.kind !== "hint_out_of_order") return;
      expect(out.missingHintId).toBe("hint-1");
      // DDB UpdateItem は走らない (= score / hintsRevealed は変更されない)
      expect(ddbSend).toHaveBeenCalledTimes(1);
    });

    it("should accept reveal of hint 2 after hint 1 revealed", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({
        Items: [
          sampleRow({
            score: 90,
            hintsRevealed: [
              { hintId: "hint-1", revealedAt: "2026-05-15T01:00:00.000Z", penaltyApplied: 10 },
            ],
          }),
        ],
      });
      ddbSend.mockResolvedValueOnce({ Attributes: { score: 70 } });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-2");
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.penaltyApplied).toBe(20);
      expect(out.totalScore).toBe(70);
    });

    it("should preserve already_revealed (= same hint twice) when the hint is already in hintsRevealed", async () => {
      // Regression pin: 順序制約の追加で 「既出 hint の二度押し」 idempotent 路を壊さないこと。
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({
        Items: [
          sampleRow({
            score: 90,
            hintsRevealed: [
              { hintId: "hint-1", revealedAt: "2026-05-15T01:00:00.000Z", penaltyApplied: 10 },
            ],
          }),
        ],
      });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("already_revealed");
      // UpdateItem は呼ばれない (= idempotent)
      expect(ddbSend).toHaveBeenCalledTimes(1);
    });

    it("should report missing predecessor as the first unrevealed hint when skipping multiple", async () => {
      // hints = [1,2,3]、 1 だけ reveal 済で 3 を request → missingHintId は 2 を返す。
      const { shared, ddbSend } = buildShared();
      const scoring = buildScoringMap([
        { id: "hint-1", content: "h1", penalty: 5 },
        { id: "hint-2", content: "h2", penalty: 10 },
        { id: "hint-3", content: "h3", penalty: 15 },
      ]);
      ddbSend.mockResolvedValueOnce({
        Items: [
          sampleRow({
            score: 95,
            hintsRevealed: [
              { hintId: "hint-1", revealedAt: "2026-05-15T01:00:00.000Z", penaltyApplied: 5 },
            ],
          }),
        ],
      });
      const out = await revealHint(shared, scoring, TEAM_KEY, "hello-world", "hint-3");
      expect(out.kind).toBe("hint_out_of_order");
      if (out.kind !== "hint_out_of_order") return;
      expect(out.missingHintId).toBe("hint-2");
    });
  });

  // ---- hintReveal: "flat" は順序制約を外す (per-problem opt-in、 既定は sequential) ----
  describe("flat hint reveal mode (scoring.hintReveal = 'flat')", () => {
    function flatScoringMap(): Record<string, ProblemScoringMetadata> {
      return {
        "hello-world": {
          kind: "flag",
          flagOutputKey: "ParameterValue",
          points: 100,
          hints: DEFAULT_HINTS,
          hintReveal: "flat",
        },
      };
    }

    it("should allow revealing hint 2 before hint 1 when flat (no hint_out_of_order)", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100, hintsRevealed: [] })] });
      ddbSend.mockResolvedValueOnce({ Attributes: { score: 80 } });
      const out = await revealHint(shared, flatScoringMap(), TEAM_KEY, "hello-world", "hint-2");
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.penaltyApplied).toBe(20);
      expect(out.totalScore).toBe(80);
    });
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

  it("should throw and surface to CloudWatch when writeScoreEvent fails (Issue #1243)", async () => {
    // #1243: 旧実装は score-event PutItem 失敗を console.warn で握り潰し、 score 減点は
    // 確定したのに履歴が空のまま 「-10 pt なのに履歴 0 件」 表示矛盾を生んでいた。
    // 新契約: 失敗は throw して route-helpers の internal_error 経路で 500 を返し、
    // CloudWatch + portal retry に乗せる。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] }); // queryTeamItems
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 90 } }); // UpdateItem (hint reveal)
    ddbSend.mockRejectedValueOnce(new Error("DDB PutItem throttle")); // writeScoreEvent
    await expect(
      revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1"),
    ).rejects.toThrow(/DDB PutItem throttle/);
    // score event 試行は 3 回目の DDB call (= query + update + put)
    expect(ddbSend).toHaveBeenCalledTimes(3);
  });

  it("should not call writeScoreEvent (no throw on hidden write) when hint penalty is 0", async () => {
    // penalty=0 は score event を書かない契約。 PutItem を呼ばないので writeScoreEvent 失敗
    // の throw 経路にも入らない (= 既存の penalty=0 挙動を pin する)。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const scoring = buildScoringMap([{ id: "hint-1", content: "free", penalty: 0 }]);
    const out = await revealHint(shared, scoring, TEAM_KEY, "hello-world", "hint-1");
    expect(out.kind).toBe("ok");
    // query + update のみ (= 2 call)、 PutCommand は呼ばれない
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  // ---- Issue #1005 / scoring gate (= submit-flag と同じ gate を hint reveal でも通す) ----
  describe("competition scoring gate (Issue #1005)", () => {
    // #2436: getEventGate は repository seam (events.getEvent) 経由になり team の tenantId で
    // event 行を tenant scope する。 team の deployment 行 (findIdentitySample が読む) と event META
    // 行の両方に同じ tenantId を持たせる (= 実データと同じ、 seam の tenant 照合を通過)。
    const TENANT = "tenant-acme";
    const eventRow = sampleRow({ eventId: "EVT1", score: 0, tenantId: TENANT });

    it("should fail-closed with scoring_not_started and not call UpdateItem when the Event row is missing", async () => {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({}); // EventMeta GetItem returns no Item
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("scoring_not_started");
      // hintsRevealed の Update は走らない (= penalty が accrue しない)
      expect(ddbSend).toHaveBeenCalledTimes(2);
    });

    it("should return scoring_not_started with startsAt when now < startsAt", async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { tenantId: TENANT, status: "READY", startsAt: future },
      });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out).toEqual({ kind: "scoring_not_started", startsAt: future });
    });

    it("should return scoring_ended when endsAt is set and now > endsAt", async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const before = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { tenantId: TENANT, status: "READY", startsAt: before, endsAt: past },
      });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out).toEqual({ kind: "scoring_ended", endsAt: past });
    });

    it("should return scoring_ended when status=ENDED, even if startsAt is set", async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { tenantId: TENANT, status: "ENDED", startsAt: before },
      });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("scoring_ended");
    });

    it("should return scoring_locked when scoringLocked=true, even if startsAt is OK", async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { tenantId: TENANT, status: "READY", startsAt: before, scoringLocked: true },
      });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("scoring_locked");
    });

    it("should pass the gate and deduct penalty as ok when startsAt past + endsAt future + status=READY", async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { tenantId: TENANT, status: "READY", startsAt: before, endsAt: future },
      });
      ddbSend.mockResolvedValueOnce({ Attributes: { score: -10 } });
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.penaltyApplied).toBe(10);
    });

    it("should skip the gate check and reveal with legacy behavior for legacy rows without eventId on the item", async () => {
      // = team の row に eventId が無いケース (= non-event-scoped、 historical)
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] }); // no eventId
      ddbSend.mockResolvedValueOnce({ Attributes: { score: 90 } });
      // Issue #1038 P1 #8: hint reveal の score event 履歴書き込み (= 3 つ目の DDB call)。
      ddbSend.mockResolvedValueOnce({});
      const out = await revealHint(shared, buildScoringMap(), TEAM_KEY, "hello-world", "hint-1");
      expect(out.kind).toBe("ok");
      // EventMeta の Get は呼ばない、 score event の Put は呼ぶ (= 3 calls: query + update + score-event Put)
      expect(ddbSend).toHaveBeenCalledTimes(3);
    });
  });
});
