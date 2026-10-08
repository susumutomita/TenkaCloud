import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FORENSIC_PROBLEM, forensicFixture, required } from "./forensic-fixture";
import { type ForensicProjection, publicIdentityAnswer } from "./forensic-public-evidence";

interface ProjectionResponse {
  projection: ForensicProjection;
  error?: string;
}
interface ScoreEvent {
  occurredAt: string;
  problemId: string;
  jobId: string;
  points: number;
  source: string;
}

/** Every answer below is reconstructed from the authenticated public evidence response. */
test("Forensic Casebook over real HTTP/SQLite: cited answers, isolated runs, idempotent official scores and restart", async () => {
  const fixture = await forensicFixture();
  async function projection(token: string, runId?: string) {
    const suffix = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const response = await fixture.api<ProjectionResponse>(
      "participant",
      `/portal/me/coordination/projection${suffix}`,
      { token },
    );
    expect(response.status).toBe(200);
    return response.body.projection;
  }
  async function move(token: string, op: unknown, runId?: string, nonce?: string) {
    return fixture.api<ProjectionResponse>("participant", "/portal/me/coordination/op", {
      method: "POST",
      token,
      body: { op, ...(runId === undefined ? {} : { runId }) },
      nonce,
    });
  }
  try {
    const event = await fixture.create("Forensic HTTP rehearsal");
    const otherEvent = await fixture.create("Separate forensic competition");
    const alpha = required(event.teams[0]);
    const beta = required(event.teams[1]);
    const outsider = required(otherEvent.teams[0]);
    const runId = required(fixture.store.jobs(event.eventId, alpha.teamId)[0]).jobId;
    const betaRun = required(fixture.store.jobs(event.eventId, beta.teamId)[0]).jobId;
    const otherRun = required(fixture.store.jobs(otherEvent.eventId, outsider.teamId)[0]).jobId;
    expect((await fixture.api("participant", "/portal/me/coordination/projection")).status).toBe(
      401,
    );
    let alphaView = await projection(alpha.teamLoginKey, runId);
    const betaBefore = await projection(beta.teamLoginKey, betaRun);
    const outsiderBefore = await projection(outsider.teamLoginKey, otherRun);
    expect(alphaView.teamId).toBe(alpha.teamId);
    expect(betaBefore.teamId).toBe(beta.teamId);
    expect(outsiderBefore.teamId).toBe(outsider.teamId);
    const firstCase = required(alphaView.cases.find((item) => item.id === "identity"));
    const identity = required(firstCase.evidence.find((item) => item.id === "I-IDP"));
    const action = required(firstCase.evidence.find((item) => item.id === "I-CLOUD"));
    for (const evidence of alphaView.cases.flatMap((item) => item.evidence)) {
      expect(createHash("sha256").update(evidence.content).digest("hex")).toBe(evidence.sha256);
      expect(JSON.parse(evidence.content).synthetic).toBe(true);
    }
    expect(JSON.stringify(alphaView)).not.toContain('"matchSecret"');
    expect(JSON.stringify(alphaView)).not.toContain('"expected"');
    expect(JSON.stringify(betaBefore)).not.toContain(identity.content);
    expect(betaBefore.cases[0]?.evidence).not.toEqual(firstCase.evidence);
    expect(outsiderBefore.cases[0]?.evidence).not.toEqual(firstCase.evidence);
    expect(
      alphaView.cases.flatMap((item) => item.questions).every((question) => !question.explanation),
    ).toBe(true);
    const answer = publicIdentityAnswer(identity.content, action.content);
    expect(JSON.stringify(betaBefore)).not.toContain(answer);
    expect(JSON.stringify(outsiderBefore)).not.toContain(answer);
    const operation = (id: string, evidenceIds = ["I-IDP", "I-CLOUD"], value = answer) => ({
      kind: "answer",
      id,
      revision: alphaView.revision,
      generation: alphaView.generation,
      caseId: "identity",
      questionId: "account",
      answer: value,
      evidenceIds,
    });

    for (const [generation, error] of [
      [undefined, "invalid_operation"],
      [0, "invalid_operation"],
      [alphaView.generation + 1, "stale_generation"],
    ] as const) {
      const rejected = await move(
        alpha.teamLoginKey,
        { ...operation(`generation-${String(generation)}`), generation },
        runId,
      );
      expect(rejected.status).toBe(422);
      expect(rejected.body.error).toBe(error);
    }
    expect(await projection(alpha.teamLoginKey, runId)).toEqual(alphaView);

    // A body cannot choose an identity, and a run pointer cannot escape its authenticated team.
    for (const field of ["teamId", "eventId"]) {
      const rejected = await fixture.api("participant", "/portal/me/coordination/op", {
        method: "POST",
        token: alpha.teamLoginKey,
        body: {
          [field]: field === "teamId" ? beta.teamId : otherEvent.eventId,
          op: operation(`identity-${field}`),
          runId,
        },
      });
      expect(rejected.status).toBe(400);
    }
    for (const foreignRun of [betaRun, otherRun, "stale-forensic-run"]) {
      const rejected = await move(alpha.teamLoginKey, operation(`run-${foreignRun}`), foreignRun);
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toBe("stale_run");
      const read = await fixture.api(
        "participant",
        `/portal/me/coordination/projection?runId=${encodeURIComponent(foreignRun)}`,
        { token: alpha.teamLoginKey },
      );
      expect(read.status).toBe(409);
    }
    expect(await projection(alpha.teamLoginKey, runId)).toEqual(alphaView);

    // A correct string alone is insufficient; citations form part of the finding.
    const missingCitation = await move(
      alpha.teamLoginKey,
      operation("missing-citation", ["I-IDP"]),
      runId,
    );
    expect(missingCitation.status).toBe(200);
    alphaView = missingCitation.body.projection;
    expect(alphaView.lastResult?.status).toBe("incorrect");
    expect(alphaView.score).toBe(0);
    const wrong = await move(
      alpha.teamLoginKey,
      operation("wrong-account", undefined, "unrelated@aster.example"),
      runId,
    );
    expect(wrong.status).toBe(200);
    alphaView = wrong.body.projection;
    expect(alphaView.lastResult?.status).toBe("incorrect");
    expect(alphaView.score).toBe(0);
    const correctOperation = operation("correct-account");
    const [correct, repeatedRequest] = await Promise.all([
      move(alpha.teamLoginKey, correctOperation, runId, "forensic-same-http-request"),
      move(alpha.teamLoginKey, correctOperation, runId, "forensic-same-http-request"),
    ]);
    expect(correct.status).toBe(200);
    expect(repeatedRequest).toEqual(correct);
    alphaView = correct.body.projection;
    expect(alphaView.lastResult).toMatchObject({ status: "correct", pointsAwarded: 20 });
    expect(alphaView.score).toBe(20);
    expect(
      alphaView.cases[0]?.questions.find((question) => question.id === "account"),
    ).toMatchObject({ solved: true, attempts: 3 });
    expect(
      alphaView.cases[0]?.questions.find((question) => question.id === "account")?.explanation?.en,
    ).toContain("session");

    // Operation IDs, independent of HTTP receipts, also prevent duplicate awards.
    const repeatedOperation = await move(
      alpha.teamLoginKey,
      correctOperation,
      runId,
      "forensic-new-http-request",
    );
    expect(repeatedOperation.status).toBe(200);
    expect(repeatedOperation.body.projection).toEqual(alphaView);
    const mismatchedReceipt = await move(
      alpha.teamLoginKey,
      correctOperation,
      betaRun,
      "forensic-same-http-request",
    );
    expect(mismatchedReceipt.status).toBe(409);
    expect(mismatchedReceipt.body.error).toBe("stale_run");
    const staleGeneration = await move(
      alpha.teamLoginKey,
      { ...correctOperation, generation: alphaView.generation + 1 },
      runId,
      "forensic-stale-generation-replay",
    );
    expect(staleGeneration.status).toBe(422);
    expect(staleGeneration.body.error).toBe("stale_generation");
    const reset = await move(
      alpha.teamLoginKey,
      {
        kind: "reset",
        id: "native-reset",
        revision: alphaView.revision,
        generation: alphaView.generation,
      },
      runId,
    );
    expect(reset.status).toBe(422);
    expect(await projection(alpha.teamLoginKey, runId)).toEqual(alphaView);
    expect(await projection(beta.teamLoginKey, betaRun)).toEqual(betaBefore);
    expect(await projection(outsider.teamLoginKey, otherRun)).toEqual(outsiderBefore);

    const history = await fixture.api<{ entries: ScoreEvent[] }>(
      "participant",
      "/portal/me/score-events",
      { token: alpha.teamLoginKey },
    );
    expect(history.status).toBe(200);
    expect(history.body.entries).toHaveLength(1);
    expect(history.body.entries[0]).toMatchObject({
      problemId: FORENSIC_PROBLEM,
      jobId: runId,
      points: 20,
      source: "coordination",
    });
    const board = await fixture.api<{ entries: { teamId: string; score: number; rank: number }[] }>(
      "participant",
      "/portal/leaderboard",
      { token: beta.teamLoginKey },
    );
    expect(board.body.entries).toHaveLength(2);
    expect(board.body.entries[0]).toMatchObject({ teamId: alpha.teamId, score: 20, rank: 1 });
    expect(board.body.entries.find((team) => team.teamId === beta.teamId)?.score).toBe(0);
    expect(board.body.entries.some((team) => team.teamId === outsider.teamId)).toBe(false);
    const own = await fixture.api<{
      problems: { problemId: string; score: number; stackOutputs: object }[];
    }>("participant", "/portal/me", { token: alpha.teamLoginKey });
    expect(
      own.body.problems.find((problem) => problem.problemId === FORENSIC_PROBLEM),
    ).toMatchObject({
      score: 20,
      stackOutputs: {},
      lastScoredAt: history.body.entries[0]?.occurredAt,
    });

    await fixture.restart();
    expect(await projection(alpha.teamLoginKey, runId)).toEqual(alphaView);
    expect(await projection(beta.teamLoginKey, betaRun)).toEqual(betaBefore);
    expect(await projection(outsider.teamLoginKey, otherRun)).toEqual(outsiderBefore);
    expect(
      await move(alpha.teamLoginKey, correctOperation, runId, "forensic-same-http-request"),
    ).toEqual(correct);
    expect(
      await move(alpha.teamLoginKey, correctOperation, runId, "forensic-after-restart"),
    ).toEqual(correct);
    const restoredHistory = await fixture.api<{ entries: ScoreEvent[] }>(
      "participant",
      "/portal/me/score-events",
      { token: alpha.teamLoginKey },
    );
    expect(restoredHistory).toEqual(history);
    expect(fixture.store.team(alpha.teamId).score).toBe(20);
    expect(fixture.store.team(beta.teamId).score).toBe(0);
    expect(fixture.store.team(outsider.teamId).score).toBe(0);
  } finally {
    await fixture.close();
  }
}, 30_000);
