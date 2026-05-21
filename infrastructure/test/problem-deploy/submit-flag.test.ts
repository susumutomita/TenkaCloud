import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { submitFlag } from "../../lib/problem-deploy/handlers/participant-handler/submit-flag";
import type { ProblemScoringMetadata } from "../../lib/utils/scoring-metadata";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#JOB1",
  SK: "META",
  jobId: "JOB1",
  problemId: "hello-world",
  tenantId: "tenant-acme",
  teamName: "alpha",
  namePrefix: "tc-hello-world-alpha",
  status: "COMPLETE",
  // CFn array shape を模す。parseStackOutputs が両形式を解釈する。
  stackOutputs: JSON.stringify([
    { OutputKey: "ParameterValue", OutputValue: "Hello from tc-hello-world-alpha" },
    { OutputKey: "ParameterName", OutputValue: "/tc-hello-world-alpha/hello" },
  ]),
  expiresAt: 9_999_999_999,
  ...over,
});

const flagScoring: Record<string, ProblemScoringMetadata> = {
  "hello-world": {
    kind: "flag",
    flagOutputKey: "ParameterValue",
    points: 100,
  },
};

describe("submitFlag", () => {
  let shared: ParticipantSharedResources;
  let ddbSend: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const built = buildShared();
    shared = built.shared;
    ddbSend = built.ddbSend;
  });

  it("should return unauthorized when no row matches teamLoginKey", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await submitFlag(
      shared,
      flagScoring,
      "BAD_KEY",
      "hello-world",
      "Hello from tc-...",
    );
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("should return not_flag_problem for problemIds without scoring config", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ problemId: "no-scoring" })] });
    const out = await submitFlag(shared, flagScoring, "KEY", "no-scoring", "anything");
    expect(out).toEqual({ kind: "not_flag_problem" });
  });

  it("should return already_scored when flagSubmitted=true already (don't double-count)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ flagSubmitted: true, score: 100 })],
    });
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
    // UpdateItem は呼ばれないこと (= Query の 1 回のみ)
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("should return no_outputs when stackOutputs lacks flagOutputKey (deploy not yet complete)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ stackOutputs: undefined })],
    });
    const out = await submitFlag(shared, flagScoring, "KEY", "hello-world", "anything");
    expect(out).toEqual({ kind: "no_outputs" });
  });

  it("should return wrong + scoreDelta=0 when the submitted flag does not match expected (no UpdateItem when penalty unset)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 25, wrongAnswerCount: 3 })] });
    const out = await submitFlag(shared, flagScoring, "KEY", "hello-world", "wrong-answer");
    // Issue #817: penalty=0 / 未設定の場合は scoreDelta=0、 既存 wrongCount を返す互換挙動。
    expect(out).toEqual({ kind: "wrong", scoreDelta: 0, totalScore: 25, wrongCount: 3 });
    expect(ddbSend).toHaveBeenCalledTimes(1); // Query のみ、Update なし (= Free Tier WCU 節約)
  });

  it("Issue #817: should deduct score and ADD to wrongAnswerCount on wrong answer when wrongAnswerPenalty > 0", async () => {
    const penaltyScoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 10,
      },
    };
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 30, wrongAnswerCount: 2 })] });
    // UpdateItem 後の Attributes (= score=30-10=20、 wrongAnswerCount=2+1=3)
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 20, wrongAnswerCount: 3 } });
    // writeScoreEvent (= PutItem) の mock
    ddbSend.mockResolvedValueOnce({});

    const out = await submitFlag(shared, penaltyScoring, "KEY", "hello-world", "wrong-answer");

    expect(out).toEqual({ kind: "wrong", scoreDelta: -10, totalScore: 20, wrongCount: 3 });
    expect(ddbSend).toHaveBeenCalledTimes(3); // Query + UpdateItem + score event Put
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd.input.UpdateExpression).toContain("ADD wrongAnswerCount :one, score :neg");
    expect(updateCmd.input.ExpressionAttributeValues?.[":neg"]).toBe(-10);
    expect(updateCmd.input.ConditionExpression).toContain("attribute_not_exists(flagSubmitted)");
  });

  it("Issue #817: should clamp totalScore at 0 even when penalty drives score negative", async () => {
    const penaltyScoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 50,
      },
    };
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 10, wrongAnswerCount: 0 })] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: -40, wrongAnswerCount: 1 } });
    ddbSend.mockResolvedValueOnce({});

    const out = await submitFlag(shared, penaltyScoring, "KEY", "hello-world", "wrong-answer");

    expect(out).toEqual({ kind: "wrong", scoreDelta: -50, totalScore: 0, wrongCount: 1 });
  });

  it("Issue #817: should fall to already_scored on CCF race with flagSubmitted=true on the penalty path", async () => {
    const penaltyScoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 10,
      },
    };
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] });
    ddbSend.mockImplementationOnce(async () => {
      const err: Error & { name?: string } = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    const out = await submitFlag(shared, penaltyScoring, "KEY", "hello-world", "wrong-answer");

    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
  });

  it("should UpdateItem with ADD score :pts SET flagSubmitted=true and return ok on correct answer", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    expect(out).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    // 1: GSI2 query, 2: UpdateItem(score), 3: PutItem(score event log)
    expect(ddbSend).toHaveBeenCalledTimes(3);
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toContain("ADD score :pts");
    expect(updateCmd.input.UpdateExpression).toContain("flagSubmitted = :true");
    expect(updateCmd.input.ConditionExpression).toContain("attribute_not_exists(flagSubmitted)");
  });

  it("should return ok when trimmed values match (don't reject on trailing newlines)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "  Hello from tc-hello-world-alpha\n",
    );
    expect(out.kind).toBe("ok");
  });

  it("should absorb ConditionalCheckFailedException as already_scored (concurrent submit guard)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 0 })] });
    const condErr = Object.assign(new Error("conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    ddbSend.mockRejectedValueOnce(condErr);
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
  });

  it("Query should hit GSI2 with `TEAMKEY#<key>`", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    await submitFlag(
      shared,
      flagScoring,
      "MYKEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    const queryCmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI2");
    expect(queryCmd.input.ExpressionAttributeValues).toEqual({ ":pk": "TEAMKEY#MYKEY" });
  });

  // ---- Issue #13 / scoring gate (startsAt / endsAt / status) ----
  // event-scoped deployment は EventMeta から gate flags を読んで、 競技開始前 / 終了後の
  // 提出を加点経路に通さない。
  describe("competition scoring gate (Issue #13)", () => {
    const eventRow = sampleRow({ eventId: "EVT1", score: 0 });

    it("should fail-closed with scoring_not_started when the Event row is missing", async () => {
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({}); // EventMeta GetItem returns no Item
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out).toEqual({ kind: "scoring_not_started" });
    });

    it("should return scoring_not_started when startsAt is unset (READY but time unspecified)", async () => {
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({ Item: { status: "READY" } });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out.kind).toBe("scoring_not_started");
    });

    it("should return scoring_not_started with startsAt when now < startsAt", async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({ Item: { status: "READY", startsAt: future } });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out).toEqual({ kind: "scoring_not_started", startsAt: future });
    });

    it("should return scoring_ended when endsAt is set and now > endsAt", async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const before = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { status: "READY", startsAt: before, endsAt: past },
      });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out).toEqual({ kind: "scoring_ended", endsAt: past });
    });

    it("should return scoring_ended when status=ENDED, even if startsAt is set", async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({ Item: { status: "ENDED", startsAt: before } });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out.kind).toBe("scoring_ended");
    });

    it("should pass the gate and award as ok when startsAt past + endsAt future + status=READY", async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { status: "READY", startsAt: before, endsAt: future },
      });
      ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out.kind).toBe("ok");
    });

    it("scoringLocked=true は startsAt OK でも scoring_locked を返す (= 既存挙動)", async () => {
      const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      ddbSend.mockResolvedValueOnce({ Items: [eventRow] });
      ddbSend.mockResolvedValueOnce({
        Item: { status: "READY", startsAt: before, scoringLocked: true },
      });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out).toEqual({ kind: "scoring_locked" });
    });

    it("should skip the gate and return ok for rows without eventId (standalone deploy, legacy compat)", async () => {
      // event scope 無し → gate check しない → 即加点経路へ
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] }); // eventId 無し
      ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
      const out = await submitFlag(
        shared,
        flagScoring,
        "KEY",
        "hello-world",
        "Hello from tc-hello-world-alpha",
      );
      expect(out.kind).toBe("ok");
    });
  });
});
