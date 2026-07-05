import { describe, expect, it, vi } from "vitest";
import {
  createLocalPlayState,
  handleLocalPlayRequest,
  isLocalApiHealthy,
  type LocalPlayRequest,
  type VerifyFn,
} from "../../../scripts/local-play/api";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";

const PROBLEM: ContainerProblem = {
  problemId: "sqli-demo",
  name: "SQL Injection Demo",
  description: "Vulnerable login.",
  instructions: "Bypass the login and read the flag.",
  writeup: "日本語の解説",
  writeupI18n: "English explanation",
  problemDir: "/repo/examples/local-play/sqli-demo",
  composePath: "/repo/examples/local-play/sqli-demo/local/docker-compose.yml",
  composeProjectName: "tc-local-sqli-demo",
  challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
  verifyUrl: "http://127.0.0.1:18081/verify",
  secretEnv: ["FLAG_SEED"],
  scoring: {
    kind: "verify",
    points: 200,
    wrongAnswerPenalty: 10,
    hints: [
      { id: "hint-1", content: "Try a quote.", penalty: 0 },
      { id: "hint-2", content: "Use OR 1=1.", penalty: 25 },
    ],
  },
};

const NOW = Date.UTC(2026, 5, 26, 0, 0, 0);

function stateWith(verify: VerifyFn, teamName = "Local Player") {
  return createLocalPlayState({ problem: PROBLEM }, { verify, teamName });
}

function get(path: string): LocalPlayRequest {
  return { method: "GET", path, query: {}, body: undefined };
}

function post(path: string, body: unknown): LocalPlayRequest {
  return { method: "POST", path, query: {}, body };
}

describe("isLocalApiHealthy", () => {
  const healthy = { status: "ok", mode: "local", problemId: "sqli-demo" };

  it("should accept this instance's own healthz payload for the expected problem", () => {
    expect(isLocalApiHealthy(healthy, "sqli-demo")).toBe(true);
  });

  it("should reject a foreign server (different problem / mode) on the same port", () => {
    expect(isLocalApiHealthy({ ...healthy, problemId: "other" }, "sqli-demo")).toBe(false);
    expect(isLocalApiHealthy({ ...healthy, mode: "localstack" }, "sqli-demo")).toBe(false);
    expect(isLocalApiHealthy({ status: "ok", mode: "local" }, "sqli-demo")).toBe(false);
  });

  it("should reject non-object or empty payloads", () => {
    expect(isLocalApiHealthy(null, "sqli-demo")).toBe(false);
    expect(isLocalApiHealthy("ok", "sqli-demo")).toBe(false);
    expect(isLocalApiHealthy({}, "sqli-demo")).toBe(false);
  });
});

describe("local-play API", () => {
  const neverVerify: VerifyFn = async () => {
    throw new Error("verify should not be called");
  };

  it("should report healthz as our local instance", async () => {
    const res = await handleLocalPlayRequest(get("/healthz"), stateWith(neverVerify), NOW);
    expect(res.body).toEqual({ status: "ok", mode: "local", problemId: "sqli-demo" });
  });

  it("should serve the team view with challenge endpoints and a flag-kind scoring panel", async () => {
    const res = await handleLocalPlayRequest(get("/portal/me"), stateWith(neverVerify), NOW);
    const body = res.body as {
      team: { teamName: string };
      problems: Array<{
        problemId: string;
        instructions: string;
        stackOutputs: Record<string, string>;
        scoring: { kind: string; points: number; flagSubmitted: boolean; hints: unknown[] };
        score: number;
      }>;
      eventGate: { kind: string };
    };
    expect(body.team.teamName).toBe("Local Player");
    expect(body.eventGate.kind).toBe("ok");
    const problem = body.problems[0];
    expect(problem.problemId).toBe("sqli-demo");
    expect(problem.instructions).toBe("Bypass the login and read the flag.");
    expect(problem.stackOutputs).toEqual({ Web: "http://127.0.0.1:18080/" });
    expect(problem.scoring.kind).toBe("flag");
    expect(problem.scoring.flagSubmitted).toBe(false);
    expect(problem.scoring.hints).toHaveLength(2);
    expect(problem.score).toBe(0);
    expect(problem).not.toHaveProperty("writeup");
    expect(problem).not.toHaveProperty("i18n");
    // Default (unset) omits hintReveal → portal keeps the sequential gate.
    expect(problem.scoring).not.toHaveProperty("hintReveal");
  });

  it("should surface hintReveal:'flat' on a verify (flag) view when opted in", async () => {
    const flatProblem: ContainerProblem = {
      ...PROBLEM,
      scoring: { ...PROBLEM.scoring, hintReveal: "flat" } as ContainerProblem["scoring"],
    };
    const state = createLocalPlayState({ problem: flatProblem }, { verify: neverVerify });
    const res = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (res.body as { problems: Array<{ scoring: Record<string, unknown> }> })
      .problems[0];
    expect(problem.scoring).toMatchObject({ kind: "flag", hintReveal: "flat" });
  });

  it("should delegate a correct submission to /verify and award the manifest points", async () => {
    const verify = vi.fn<VerifyFn>(async () => ({ correct: true }));
    const state = stateWith(verify);
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(verify).toHaveBeenCalledWith("http://127.0.0.1:18081/verify", "TC{x}", {
      teamId: "local",
      problemId: "sqli-demo",
    });
    expect(res.body).toEqual({ kind: "ok", scoreDelta: 200, totalScore: 200 });
    expect(state.solved.has("sqli-demo")).toBe(true);
    expect(state.scoreEvents[0]).toMatchObject({ source: "flag", points: 200, result: "ok" });

    const team = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const solvedProblem = (
      team.body as {
        problems: Array<{ writeup?: string; i18n?: { en?: { writeup?: string } } }>;
      }
    ).problems[0];
    expect(solvedProblem.writeup).toBe("日本語の解説");
    expect(solvedProblem.i18n?.en?.writeup).toBe("English explanation");
  });

  it("should honor a points override returned by /verify", async () => {
    const state = stateWith(async () => ({ correct: true, points: 120 }));
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(res.body).toEqual({ kind: "ok", scoreDelta: 120, totalScore: 120 });
  });

  it("should record a wrong submission with a penalty", async () => {
    const state = stateWith(async () => ({ correct: false }));
    state.score = 50;
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "wrong" }),
      state,
      NOW,
    );
    expect(res.body).toEqual({ kind: "wrong", scoreDelta: -10, totalScore: 40, wrongCount: 1 });
    expect(state.scoreEvents[0]).toMatchObject({ source: "flag-wrong", result: "wrong" });
  });

  it("should be idempotent once solved", async () => {
    const state = stateWith(async () => ({ correct: true }));
    await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    const again = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(again.body).toEqual({ kind: "already_scored", totalScore: 200 });
  });

  it("should reject a malformed submission without calling /verify", async () => {
    const verify = vi.fn<VerifyFn>(async () => ({ correct: true }));
    const state = stateWith(verify);
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "other", flag: "x" }),
      state,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_flag" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("should fail loudly (502) when /verify is unavailable, without scoring", async () => {
    const state = stateWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "x" }),
      state,
      NOW,
    );
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "verify_unavailable" });
    expect(state.solved.size).toBe(0);
    expect(state.scoreEvents).toHaveLength(0);
  });

  it("should reveal a hint and apply its penalty once", async () => {
    const state = stateWith(neverVerify);
    state.score = 100;
    const first = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(first.body).toMatchObject({ kind: "ok", content: "Use OR 1=1.", penaltyApplied: 25 });
    expect(state.score).toBe(75);
    const second = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(second.body).toMatchObject({ kind: "already_revealed", penaltyApplied: 0 });
    expect(state.score).toBe(75);
  });

  it("should charge a hint penalty in full even at score 0 (no free hints)", async () => {
    const state = stateWith(neverVerify); // score starts at 0
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(res.body).toMatchObject({ kind: "ok", penaltyApplied: 25 });
    expect(state.score).toBe(-25);
  });

  it("should treat a malformed percent-escaped hint path as unknown (404, not 500)", async () => {
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/%/reveal", {}),
      stateWith(neverVerify),
      NOW,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "unknown_hint" });
  });

  it("should 404 an unknown hint", async () => {
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/nope/reveal", {}),
      stateWith(neverVerify),
      NOW,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "unknown_hint" });
  });

  it("should surface the en overlay in the team view and gate hint translations behind reveal", async () => {
    const problem: ContainerProblem = {
      ...PROBLEM,
      i18n: { en: { name: "SQLi", description: "Vuln login (EN).", instructions: "Bypass (EN)." } },
      scoring: {
        ...PROBLEM.scoring,
        hints: [
          {
            id: "hint-1",
            content: "クオート。",
            penalty: 0,
            i18n: { en: { content: "Try a quote (EN)." } },
          },
          { id: "hint-2", content: "OR 1=1。", penalty: 25 },
        ],
      },
    };
    const state = createLocalPlayState({ problem }, { verify: neverVerify });
    const before = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const beforeProblem = (before.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(beforeProblem.i18n).toEqual({
      en: { name: "SQLi", description: "Vuln login (EN).", instructions: "Bypass (EN)." },
    });
    // unrevealed hints leak neither ja content nor the en translation
    const hintsBefore = (beforeProblem.scoring as { hints: Array<Record<string, unknown>> }).hints;
    expect(hintsBefore[0]).not.toHaveProperty("content");
    expect(hintsBefore[0]).not.toHaveProperty("i18n");

    const reveal = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-1/reveal", {}),
      state,
      NOW,
    );
    expect(reveal.body).toMatchObject({
      content: "クオート。",
      i18n: { en: { content: "Try a quote (EN)." } },
    });

    const after = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const afterHints = (
      after.body as { problems: Array<{ scoring: { hints: Array<Record<string, unknown>> } }> }
    ).problems[0].scoring.hints;
    expect(afterHints[0]).toMatchObject({
      content: "クオート。",
      i18n: { en: { content: "Try a quote (EN)." } },
    });
    // a hint without a translation simply omits i18n once revealed
    await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    const final = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const finalHints = (
      final.body as { problems: Array<{ scoring: { hints: Array<Record<string, unknown>> } }> }
    ).problems[0].scoring.hints;
    expect(finalHints[1]).toMatchObject({ content: "OR 1=1。" });
    expect(finalHints[1]).not.toHaveProperty("i18n");
  });

  it("should omit i18n from the team view when the problem ships no translation", async () => {
    const res = await handleLocalPlayRequest(get("/portal/me"), stateWith(neverVerify), NOW);
    const problem = (res.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(problem).not.toHaveProperty("i18n");
  });

  it("should expose a single-team leaderboard reflecting the score", async () => {
    const state = stateWith(async () => ({ correct: true }));
    await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    const res = await handleLocalPlayRequest(get("/portal/leaderboard"), state, NOW);
    expect(res.body).toMatchObject({
      entries: [{ rank: 1, score: 200, completedProblems: 1, isMyTeam: true }],
    });
  });

  it("should rename the team and reject an empty name", async () => {
    const state = stateWith(neverVerify);
    const ok = await handleLocalPlayRequest(
      { method: "PATCH", path: "/portal/me", query: {}, body: { teamName: "  Red  " } },
      state,
      NOW,
    );
    expect((ok.body as { team: { teamName: string } }).team.teamName).toBe("Red");
    const bad = await handleLocalPlayRequest(
      { method: "PATCH", path: "/portal/me", query: {}, body: { teamName: " " } },
      state,
      NOW,
    );
    expect(bad.status).toBe(400);
  });

  it("should serve score events, notifications, deploy-logs and 404 unknown routes", async () => {
    const state = stateWith(neverVerify);
    expect((await handleLocalPlayRequest(get("/portal/me/score-events"), state, NOW)).body).toEqual(
      {
        entries: [],
      },
    );
    expect(
      (await handleLocalPlayRequest(get("/portal/leaderboard/score-events"), state, NOW)).status,
    ).toBe(200);
    expect(
      (await handleLocalPlayRequest(get("/portal/me/notifications"), state, NOW)).body,
    ).toMatchObject({ items: [] });
    expect(
      (await handleLocalPlayRequest(get("/portal/me/deploy-logs"), state, NOW)).body,
    ).toMatchObject({ complete: true });
    expect((await handleLocalPlayRequest(get("/nope"), state, NOW)).status).toBe(404);
  });
});

describe("local-play API: multi-verify (issue #2252)", () => {
  const MULTI_PROBLEM: ContainerProblem = {
    ...PROBLEM,
    problemId: "wp-ops",
    composeProjectName: "tc-local-wp-ops",
    scoring: {
      kind: "multi-verify",
      totalPoints: 120,
      checks: [
        {
          id: "public-backup",
          label: "公開バックアップ",
          points: 50,
          wrongAnswerPenalty: 5,
          hints: [{ id: "h-backup", content: "公開パスを確認する", penalty: 2 }],
          i18n: { en: { label: "Public backup" } },
        },
        {
          id: "weak-admin-pw",
          label: "弱い管理者パスワード",
          points: 70,
          wrongAnswerPenalty: 0,
          hints: [],
        },
      ],
    },
  };

  function multiState(verify: VerifyFn) {
    return createLocalPlayState({ problem: MULTI_PROBLEM }, { verify });
  }

  const submit = (flagId: string | undefined, flag = "TC{x}") =>
    post("/portal/me/submit-flag", {
      problemId: "wp-ops",
      flag,
      ...(flagId !== undefined ? { flagId } : {}),
    });

  it("should render the multi-flag view: totals, per-check entries, gated hints, en labels", async () => {
    const state = multiState(vi.fn());
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (view.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(problem.score).toBe(0);
    expect(problem.scoring).toEqual({
      kind: "multi-flag",
      points: 120,
      flags: [
        {
          id: "public-backup",
          label: "公開バックアップ",
          points: 50,
          solved: false,
          i18n: { en: { label: "Public backup" } },
          hints: [{ id: "h-backup", penalty: 2, revealed: false }],
        },
        { id: "weak-admin-pw", label: "弱い管理者パスワード", points: 70, solved: false },
      ],
    });
  });

  it("should surface hintReveal:'flat' at the top of the multi-flag view when opted in", async () => {
    const flatProblem: ContainerProblem = {
      ...MULTI_PROBLEM,
      scoring: { ...MULTI_PROBLEM.scoring, hintReveal: "flat" } as ContainerProblem["scoring"],
    };
    const state = createLocalPlayState({ problem: flatProblem }, { verify: vi.fn() });
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (view.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(problem.scoring).toMatchObject({ kind: "multi-flag", hintReveal: "flat" });
  });

  it("should judge one checkpoint via the container and award metadata points only", async () => {
    // container returns a points override — multi-verify must ignore it (metadata is 正本).
    const verify = vi.fn(async () => ({
      correct: true,
      points: 9_999,
      checkpointId: "public-backup",
    }));
    const state = multiState(verify);

    const res = await handleLocalPlayRequest(submit("public-backup"), state, NOW);
    expect(res.body).toEqual({
      kind: "ok",
      scoreDelta: 50,
      totalScore: 50,
      flagId: "public-backup",
    });
    expect(verify).toHaveBeenCalledWith(
      MULTI_PROBLEM.verifyUrl,
      "TC{x}",
      { teamId: "local", problemId: "wp-ops" },
      { checkpointId: "public-backup" },
    );
  });

  it("should be idempotent per checkpoint: resubmission never re-calls the container", async () => {
    const verify = vi.fn(async () => ({ correct: true, checkpointId: "public-backup" }));
    const state = multiState(verify);
    await handleLocalPlayRequest(submit("public-backup"), state, NOW);

    const again = await handleLocalPlayRequest(submit("public-backup", "wrong-now"), state, NOW);
    expect(again.body).toEqual({
      kind: "already_scored",
      totalScore: 50,
      flagId: "public-backup",
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(state.score).toBe(50);
  });

  it("should apply the per-check wrong-answer penalty and count wrongs per check", async () => {
    const verify = vi.fn(
      async (_u: string, _s: string, _c: unknown, o?: { checkpointId?: string }) => ({
        correct: false,
        checkpointId: o?.checkpointId,
      }),
    );
    const state = multiState(verify as VerifyFn);

    const wrongA = await handleLocalPlayRequest(submit("public-backup"), state, NOW);
    expect(wrongA.body).toEqual({
      kind: "wrong",
      scoreDelta: -5,
      totalScore: -5,
      wrongCount: 1,
      flagId: "public-backup",
    });
    // 別 check の誤答は penalty 0 / wrongCount は check 単位で独立
    const wrongB = await handleLocalPlayRequest(submit("weak-admin-pw"), state, NOW);
    expect(wrongB.body).toEqual({
      kind: "wrong",
      scoreDelta: 0,
      totalScore: -5,
      wrongCount: 1,
      flagId: "weak-admin-pw",
    });
  });

  it("should fail closed on unknown / missing flagId without calling the container", async () => {
    const verify = vi.fn();
    const state = multiState(verify);
    const unknown = await handleLocalPlayRequest(submit("not-a-check"), state, NOW);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ kind: "unknown_flag" });
    const missing = await handleLocalPlayRequest(submit(undefined), state, NOW);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ kind: "unknown_flag" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("should complete the problem only when every checkpoint is solved", async () => {
    const verify = vi.fn(
      async (_u: string, _s: string, _c: unknown, o?: { checkpointId?: string }) => ({
        correct: true,
        checkpointId: o?.checkpointId,
      }),
    );
    const state = multiState(verify as VerifyFn);

    await handleLocalPlayRequest(submit("public-backup"), state, NOW);
    const partial = await handleLocalPlayRequest(get("/portal/leaderboard"), state, NOW);
    expect(
      (partial.body as { entries: Array<{ completedProblems: number }> }).entries[0]
        .completedProblems,
    ).toBe(0);

    await handleLocalPlayRequest(submit("weak-admin-pw"), state, NOW);
    const done = await handleLocalPlayRequest(get("/portal/leaderboard"), state, NOW);
    expect(
      (done.body as { entries: Array<{ completedProblems: number }> }).entries[0].completedProblems,
    ).toBe(1);

    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (view.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(problem.score).toBe(120);
    expect(problem.lastResult).toBe("ok");
  });

  it("should reveal a per-check hint through the flat reveal route with its penalty", async () => {
    const state = multiState(vi.fn());
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/wp-ops/hints/h-backup/reveal", {}),
      state,
      NOW,
    );
    expect(res.body).toMatchObject({
      kind: "ok",
      content: "公開パスを確認する",
      penaltyApplied: 2,
      totalScore: -2,
    });
  });
});
