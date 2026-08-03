import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import { handleLocalPlayRequest } from "../../../scripts/local-play/api";
import {
  createLocalPlayState,
  isLocalApiHealthy,
  type LocalPlayRequest,
  type VerifyFn,
} from "../../../scripts/local-play/api-state";
import { ContainerStartOwnershipError } from "../../../scripts/local-play/container-runner";
import type { ContainerProblem } from "../../../scripts/local-play/manifest";
import { PORT_STRIDE } from "../../../scripts/local-play/port-remap";

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

/** A single-problem session with the problem already running (on-demand start, fake docker). */
async function stateWith(verify: VerifyFn, teamName = "Local Player") {
  const state = createLocalPlayState({ problems: [PROBLEM] }, { verify, teamName });
  await state.lifecycle.ensureRunning(PROBLEM.problemId);
  return state;
}

/** The sole per-problem runtime of a single-problem session (solved / score live here now). */
function soleRuntime(state: ReturnType<typeof createLocalPlayState>) {
  const runtime = state.runtimes.values().next().value;
  if (!runtime) throw new Error("no problem runtime in state");
  return runtime;
}

function get(path: string): LocalPlayRequest {
  return { method: "GET", path, query: {}, body: undefined };
}

function post(path: string, body: unknown): LocalPlayRequest {
  return { method: "POST", path, query: {}, body };
}

/**
 * Container start は 202 (async) で返る — 応答後に detached で走る start / evict
 * チェーン (fake adapter は microtask 解決) を 1 macrotask 待って確定させる。
 */
function settleLifecycle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("isLocalApiHealthy", () => {
  const healthy = { status: "ok", mode: "local", problemIds: ["sqli-demo", "api-idor-demo"] };

  it("should accept a session that serves every expected problem", () => {
    expect(isLocalApiHealthy(healthy, ["sqli-demo"])).toBe(true);
    expect(isLocalApiHealthy(healthy, ["sqli-demo", "api-idor-demo"])).toBe(true);
  });

  it("should accept a warm session with no pre-started problems", () => {
    expect(isLocalApiHealthy(healthy, [])).toBe(true);
  });

  it("should reject a foreign server (missing problem / wrong mode) on the same port", () => {
    // a session that does not serve one of the expected ids
    expect(isLocalApiHealthy(healthy, ["sqli-demo", "other"])).toBe(false);
    expect(isLocalApiHealthy({ ...healthy, mode: "localstack" }, ["sqli-demo"])).toBe(false);
    expect(isLocalApiHealthy({ status: "ok", mode: "local" }, ["sqli-demo"])).toBe(false);
  });

  it("should reject non-object or empty payloads", () => {
    expect(isLocalApiHealthy(null, ["sqli-demo"])).toBe(false);
    expect(isLocalApiHealthy("ok", ["sqli-demo"])).toBe(false);
    expect(isLocalApiHealthy({}, ["sqli-demo"])).toBe(false);
  });
});

describe("local-play API", () => {
  const neverVerify: VerifyFn = async () => {
    throw new Error("verify should not be called");
  };

  it("should report healthz as our local instance", async () => {
    const res = await handleLocalPlayRequest(get("/healthz"), await stateWith(neverVerify), NOW);
    expect(res.body).toEqual({ status: "ok", mode: "local", problemIds: ["sqli-demo"] });
  });

  it("should serve the team view with challenge endpoints and a flag-kind scoring panel", async () => {
    const res = await handleLocalPlayRequest(get("/portal/me"), await stateWith(neverVerify), NOW);
    const body = res.body as {
      team: { teamName: string };
      problems: Array<{
        problemId: string;
        instructions: string;
        stackOutputs: Record<string, string>;
        lifecycle: { status: string };
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
    expect(problem.lifecycle).toEqual({ status: "running", runtimeKind: "docker" });
    expect(problem.stackOutputs).toEqual({ Web: "http://127.0.0.1:18080/" });
    expect(problem.scoring.kind).toBe("flag");
    expect(problem.scoring.flagSubmitted).toBe(false);
    expect(problem.scoring.hints).toHaveLength(2);
    expect(problem.score).toBe(0);
    expect(problem).not.toHaveProperty("writeup");
    expect(problem).not.toHaveProperty("i18n");
    // fairness contract (platform #1124 / SCHEMA): `description` is the
    // admin/authoring field (scoring rules, hardened state, red-team playbook)
    // and must never reach the competitor. Only `instructions` is participant-facing.
    expect(problem).not.toHaveProperty("description");
    // Default (unset) omits hintReveal → portal keeps the sequential gate.
    expect(problem.scoring).not.toHaveProperty("hintReveal");
    // The documented Docker reference problem is the local-mode starting point.
    expect(problem.recommended).toBe(true);
  });

  it("should mark lifecycle.terminal only for a problem whose metadata opted in (#2850)", async () => {
    const declared = { ...PROBLEM, problemId: "shell-lab", terminal: { service: "verifier" } };
    const state = createLocalPlayState({ problems: [PROBLEM, declared] }, { verify: neverVerify });
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    await state.lifecycle.ensureRunning(declared.problemId);

    const res = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const body = res.body as {
      problems: Array<{ problemId: string; lifecycle: Record<string, unknown> }>;
    };
    const byId = new Map(body.problems.map((problem) => [problem.problemId, problem]));

    // The portal renders the terminal panel from this flag alone, so an undeclared
    // problem must not carry it — a panel there would dead-end on a 404 handoff.
    expect(byId.get("shell-lab")?.lifecycle).toEqual({
      status: "running",
      runtimeKind: "docker",
      terminal: true,
    });
    expect(byId.get("sqli-demo")?.lifecycle).toEqual({ status: "running", runtimeKind: "docker" });
  });

  it("should not recommend an ordinary container problem", async () => {
    const ordinaryProblem: ContainerProblem = { ...PROBLEM, problemId: "csrf-demo" };
    const state = createLocalPlayState({ problems: [ordinaryProblem] }, { verify: neverVerify });
    await state.lifecycle.ensureRunning(ordinaryProblem.problemId);
    const res = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (res.body as { problems: Array<{ problemId: string; recommended?: boolean }> })
      .problems[0];
    expect(problem?.problemId).toBe("csrf-demo");
    expect(problem).not.toHaveProperty("recommended");
  });

  it("should surface hintReveal:'flat' on a verify (flag) view when opted in", async () => {
    const flatProblem: ContainerProblem = {
      ...PROBLEM,
      scoring: { ...PROBLEM.scoring, hintReveal: "flat" } as ContainerProblem["scoring"],
    };
    const state = createLocalPlayState({ problems: [flatProblem] }, { verify: neverVerify });
    const res = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (res.body as { problems: Array<{ scoring: Record<string, unknown> }> })
      .problems[0];
    expect(problem.scoring).toMatchObject({ kind: "flag", hintReveal: "flat" });
  });

  it("should delegate a correct submission to /verify and award the manifest points", async () => {
    const verify = vi.fn<VerifyFn>(async () => ({ correct: true }));
    const state = await stateWith(verify);
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
    expect(soleRuntime(state).solved.has("sqli-demo")).toBe(true);
    expect(state.scoreEvents[0]).toMatchObject({ source: "flag", points: 200, result: "ok" });

    const team = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const solvedProblem = (
      team.body as {
        problems: Array<{ writeup?: string; i18n?: { en?: { writeup?: string } } }>;
      }
    ).problems[0];
    expect(solvedProblem.writeup).toContain("日本語の解説");
    expect(solvedProblem.i18n?.en?.writeup).toContain("English explanation");
  });

  it("should honor a points override returned by /verify", async () => {
    const state = await stateWith(async () => ({ correct: true, points: 120 }));
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(res.body).toEqual({ kind: "ok", scoreDelta: 120, totalScore: 120 });
  });

  it("should record a wrong submission with a penalty", async () => {
    const state = await stateWith(async () => ({ correct: false }));
    soleRuntime(state).score = 50;
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "wrong" }),
      state,
      NOW,
    );
    expect(res.body).toEqual({ kind: "wrong", scoreDelta: -10, totalScore: 40, wrongCount: 1 });
    expect(state.scoreEvents[0]).toMatchObject({ source: "flag-wrong", result: "wrong" });
  });

  it("should be idempotent once solved", async () => {
    const state = await stateWith(async () => ({ correct: true }));
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
    const state = await stateWith(verify);
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
    const state = await stateWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "x" }),
      state,
      NOW,
    );
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "verify_unavailable" });
    expect(soleRuntime(state).solved.size).toBe(0);
    expect(state.scoreEvents).toHaveLength(0);
  });

  it("should reveal a hint and apply its penalty once", async () => {
    const state = await stateWith(neverVerify);
    soleRuntime(state).score = 100;
    const first = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(first.body).toMatchObject({ kind: "ok", content: "Use OR 1=1.", penaltyApplied: 25 });
    expect(soleRuntime(state).score).toBe(75);
    const second = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(second.body).toMatchObject({ kind: "already_revealed", penaltyApplied: 0 });
    expect(soleRuntime(state).score).toBe(75);
  });

  it("should charge a hint penalty in full even at score 0 (no free hints)", async () => {
    const state = await stateWith(neverVerify); // score starts at 0
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(res.body).toMatchObject({ kind: "ok", penaltyApplied: 25 });
    expect(soleRuntime(state).score).toBe(-25);
  });

  it("should treat a malformed percent-escaped hint path as unknown (404, not 500)", async () => {
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/%/reveal", {}),
      await stateWith(neverVerify),
      NOW,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "unknown_hint" });
  });

  it("should 404 an unknown hint", async () => {
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/nope/reveal", {}),
      await stateWith(neverVerify),
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
    const state = createLocalPlayState({ problems: [problem] }, { verify: neverVerify });
    await state.lifecycle.ensureRunning(problem.problemId);
    const before = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const beforeProblem = (before.body as { problems: Array<Record<string, unknown>> }).problems[0];
    // fairness contract: the en overlay drops `description` for the same reason
    // the top-level field does (mirror of the build-time catalog's sanitizeI18n).
    expect(beforeProblem.i18n).toEqual({
      en: { name: "SQLi", instructions: "Bypass (EN)." },
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
    const res = await handleLocalPlayRequest(get("/portal/me"), await stateWith(neverVerify), NOW);
    const problem = (res.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(problem).not.toHaveProperty("i18n");
  });

  it("should expose a single-team leaderboard reflecting the score", async () => {
    const state = await stateWith(async () => ({ correct: true }));
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
    const state = await stateWith(neverVerify);
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
    const state = await stateWith(neverVerify);
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

  async function multiState(verify: VerifyFn) {
    const state = createLocalPlayState({ problems: [MULTI_PROBLEM] }, { verify });
    await state.lifecycle.ensureRunning(MULTI_PROBLEM.problemId);
    return state;
  }

  const submit = (flagId: string | undefined, flag = "TC{x}") =>
    post("/portal/me/submit-flag", {
      problemId: "wp-ops",
      flag,
      ...(flagId !== undefined ? { flagId } : {}),
    });

  it("should render the multi-flag view: totals, per-check entries, gated hints, en labels", async () => {
    const state = await multiState(vi.fn());
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
    const state = createLocalPlayState({ problems: [flatProblem] }, { verify: vi.fn() });
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
    const state = await multiState(verify);

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
    const state = await multiState(verify);
    await handleLocalPlayRequest(submit("public-backup"), state, NOW);

    const again = await handleLocalPlayRequest(submit("public-backup", "wrong-now"), state, NOW);
    expect(again.body).toEqual({
      kind: "already_scored",
      totalScore: 50,
      flagId: "public-backup",
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(soleRuntime(state).score).toBe(50);
  });

  it("should apply the per-check wrong-answer penalty and count wrongs per check", async () => {
    const verify = vi.fn(
      async (_u: string, _s: string, _c: unknown, o?: { checkpointId?: string }) => ({
        correct: false,
        checkpointId: o?.checkpointId,
      }),
    );
    const state = await multiState(verify as VerifyFn);

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
    const state = await multiState(verify);
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
    const state = await multiState(verify as VerifyFn);

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
    const state = await multiState(vi.fn());
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

describe("local-play API: multi-problem session (#2392)", () => {
  const second: ContainerProblem = {
    ...PROBLEM,
    problemId: "api-idor-demo",
    name: "IDOR Demo",
    challengeEndpoints: { Web: "http://127.0.0.1:18180/" },
    verifyUrl: "http://127.0.0.1:18181/verify",
    scoring: {
      kind: "verify",
      points: 100,
      wrongAnswerPenalty: 5,
      hints: [{ id: "idor-1", content: "swap the id", penalty: 10 }],
    },
  };
  const twoProblems = async (verify: VerifyFn) => {
    const state = createLocalPlayState({ problems: [PROBLEM, second] }, { verify });
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    await state.lifecycle.ensureRunning(second.problemId);
    return state;
  };

  it("should list both problems in healthz and the team view (display order)", async () => {
    const state = await twoProblems(async () => ({ correct: false }));
    const health = await handleLocalPlayRequest(get("/healthz"), state, NOW);
    expect(health.body).toEqual({
      status: "ok",
      mode: "local",
      problemIds: ["sqli-demo", "api-idor-demo"],
    });
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const ids = (view.body as { problems: Array<{ problemId: string }> }).problems.map(
      (p) => p.problemId,
    );
    expect(ids).toEqual(["sqli-demo", "api-idor-demo"]);
  });

  it("should route a submission to the addressed problem and total across the session", async () => {
    // The container only 'verifies' for the second problem's /verify url. That
    // problem started second, so its URLs sit on the offset-1000 port block
    // (base 18181 → 19181) — submissions must follow the running container.
    const verify = vi.fn<VerifyFn>(async (url) => ({
      correct: url.includes(String(18181 + PORT_STRIDE)),
    }));
    const state = await twoProblems(verify);
    const res = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "api-idor-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(res.body).toMatchObject({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    expect(verify).toHaveBeenCalledWith(`http://127.0.0.1:${18181 + PORT_STRIDE}/verify`, "TC{x}", {
      teamId: "local",
      problemId: "api-idor-demo",
    });
    // The first problem is untouched; the total is the session sum.
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problems = (view.body as { problems: Array<{ problemId: string; score: number }> })
      .problems;
    expect(problems[0]).toMatchObject({ problemId: "sqli-demo", score: 0 });
    expect(problems[1]).toMatchObject({ problemId: "api-idor-demo", score: 100 });
  });

  it("should route a hint reveal by problemId and reject a hint from another problem", async () => {
    const state = await twoProblems(async () => ({ correct: false }));
    const ok = await handleLocalPlayRequest(
      post("/portal/me/problems/api-idor-demo/hints/idor-1/reveal", {}),
      state,
      NOW,
    );
    expect(ok.body).toMatchObject({ kind: "ok", penaltyApplied: 10, totalScore: -10 });
    // idor-1 belongs to api-idor-demo; addressing it under sqli-demo is unknown.
    const wrong = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/idor-1/reveal", {}),
      state,
      NOW,
    );
    expect(wrong.status).toBe(404);
  });

  it("should remap the port in instructions to match the running container's block", async () => {
    // The catalog problem hard-codes its base surface port in its prose (here
    // 18180, matching `second`'s declared endpoints). Starting it second moves
    // the surface to the offset-1000 block (19180), and the instructions must
    // follow — the portal must not tell the player the stale port (#2392).
    const withPortInInstructions: ContainerProblem = {
      ...second,
      instructions: "Run `curl http://127.0.0.1:18180/internal/ops/status`.",
      i18n: { en: { instructions: "Run `curl http://127.0.0.1:18180/internal/ops/status`." } },
    };
    const state = createLocalPlayState(
      { problems: [PROBLEM, withPortInInstructions] },
      { verify: async () => ({ correct: false }) },
    );
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    await state.lifecycle.ensureRunning(withPortInInstructions.problemId);

    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (
      view.body as {
        problems: Array<{
          instructions: string;
          stackOutputs: Record<string, string>;
          i18n?: { en?: { instructions?: string } };
        }>;
      }
    ).problems[1];
    expect(problem.instructions).toBe(
      `Run \`curl http://127.0.0.1:${18180 + PORT_STRIDE}/internal/ops/status\`.`,
    );
    expect(problem.i18n?.en?.instructions).toBe(
      `Run \`curl http://127.0.0.1:${18180 + PORT_STRIDE}/internal/ops/status\`.`,
    );
    // The instructions now agree with the surface URL the portal shows.
    expect(problem.stackOutputs).toEqual({
      Web: `http://127.0.0.1:${18180 + PORT_STRIDE}/`,
    });
  });

  it("should rewrite display URLs for Codespaces without changing the internal verifier URL", async () => {
    const withPortInInstructions: ContainerProblem = {
      ...second,
      instructions: "Open http://127.0.0.1:18180/admin.",
    };
    const verify = vi.fn<VerifyFn>(async () => ({ correct: false }));
    const state = createLocalPlayState(
      { problems: [PROBLEM, withPortInInstructions] },
      {
        verify,
        browserText: (text) =>
          text.replace(
            /\bhttp:\/\/127\.0\.0\.1:(\d+)(?=\/|[\s`"'<>)]|$)/g,
            (_match, port: string) => `https://tenkacloud-demo-${port}.app.github.dev`,
          ),
      },
    );
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    await state.lifecycle.ensureRunning(withPortInInstructions.problemId);

    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (
      view.body as {
        problems: Array<{
          problemId: string;
          instructions: string;
          stackOutputs: Record<string, string>;
        }>;
      }
    ).problems[1];
    expect(problem.problemId).toBe("api-idor-demo");
    expect(problem.instructions).toBe(
      `Open https://tenkacloud-demo-${18180 + PORT_STRIDE}.app.github.dev/admin.`,
    );
    expect(problem.stackOutputs).toEqual({
      Web: `https://tenkacloud-demo-${18180 + PORT_STRIDE}.app.github.dev/`,
    });

    await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "api-idor-demo", flag: "wrong" }),
      state,
      NOW,
    );
    expect(verify).toHaveBeenCalledWith(`http://127.0.0.1:${18181 + PORT_STRIDE}/verify`, "wrong", {
      teamId: "local",
      problemId: "api-idor-demo",
    });
  });

  it("should count completed problems and the session score in the leaderboard", async () => {
    const state = await twoProblems(async () => ({ correct: true }));
    await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    const lb = await handleLocalPlayRequest(get("/portal/leaderboard"), state, NOW);
    const entry = (
      lb.body as {
        entries: Array<{ score: number; completedProblems: number; totalProblems: number }>;
      }
    ).entries[0];
    expect(entry).toMatchObject({ score: 200, completedProblems: 1, totalProblems: 2 });
  });
});

describe("local-play API: on-demand container lifecycle (#2392 Phase 2)", () => {
  const IDOR: ContainerProblem = {
    ...PROBLEM,
    problemId: "api-idor-demo",
    name: "IDOR Demo",
    composeProjectName: "tc-local-api-idor-demo",
    challengeEndpoints: { Web: "http://127.0.0.1:18180/" },
    verifyUrl: "http://127.0.0.1:18181/verify",
  };
  const XSS: ContainerProblem = {
    ...PROBLEM,
    problemId: "xss-demo",
    name: "XSS Demo",
    composeProjectName: "tc-local-xss-demo",
    challengeEndpoints: { Web: "http://127.0.0.1:18380/" },
    verifyUrl: "http://127.0.0.1:18381/verify",
  };
  const neverVerify: VerifyFn = async () => {
    throw new Error("verify should not be called");
  };

  it("should expose the whole catalog stopped: healthz lists it, views hide endpoints", async () => {
    const state = createLocalPlayState({ problems: [PROBLEM, IDOR] }, { verify: neverVerify });
    const health = await handleLocalPlayRequest(get("/healthz"), state, NOW);
    expect(health.body).toEqual({
      status: "ok",
      mode: "local",
      problemIds: ["sqli-demo", "api-idor-demo"],
    });
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problems = (
      view.body as {
        problems: Array<{
          name: string;
          description: string;
          stackOutputs: Record<string, string>;
          lifecycle: { status: string };
          scoring: { kind: string; points: number };
        }>;
      }
    ).problems;
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem.lifecycle).toEqual({ status: "stopped", runtimeKind: "docker" });
      // a stopped container's endpoints must not leak into the portal
      expect(problem.stackOutputs).toEqual({});
    }
    // the display / scoring shell stays so the portal can render a start affordance
    expect(problems[0].name).toBe("SQL Injection Demo");
    // fairness contract (platform #1124): the admin/authoring `description` is
    // dropped even in the stopped view — `instructions` is the participant text.
    expect(problems[0]).not.toHaveProperty("description");
    expect(problems[0].scoring).toMatchObject({ kind: "flag", points: 200 });
  });

  it("should start a problem on demand and surface its endpoints while running", async () => {
    const state = createLocalPlayState({ problems: [PROBLEM] }, { verify: neverVerify });
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/start", {}),
      state,
      NOW,
    );
    // 202 (async): 初回 start は compose の暗黙イメージビルドで数分かかり得るため、
    // 応答は待たずに返し、 進行は lifecycle.status の polling で読む (Codespaces の
    // forwarded proxy が長時間リクエストを切断するのを避ける)。
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(res.body).toEqual({ status: "starting" });
    await settleLifecycle();
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (
      view.body as {
        problems: Array<{ stackOutputs: Record<string, string>; lifecycle: { status: string } }>;
      }
    ).problems[0];
    expect(problem.lifecycle).toEqual({ status: "running", runtimeKind: "docker" });
    // first start takes offset 0 → the declared ports are kept as-is
    expect(problem.stackOutputs).toEqual({ Web: "http://127.0.0.1:18080/" });
  });

  it("should move the second running problem onto its own port block", async () => {
    const state = createLocalPlayState({ problems: [PROBLEM, IDOR] }, { verify: neverVerify });
    await handleLocalPlayRequest(post("/portal/me/problems/sqli-demo/start", {}), state, NOW);
    await handleLocalPlayRequest(post("/portal/me/problems/api-idor-demo/start", {}), state, NOW);
    await settleLifecycle();
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problems = (view.body as { problems: Array<{ stackOutputs: Record<string, string> }> })
      .problems;
    expect(problems[0].stackOutputs).toEqual({ Web: "http://127.0.0.1:18080/" });
    // offset 1000: the fake docker applies the same URL remap as ContainerRunner
    expect(problems[1].stackOutputs).toEqual({
      Web: `http://127.0.0.1:${18180 + PORT_STRIDE}/`,
    });
  });

  it("should 404 start/stop for an unknown or malformed problem id", async () => {
    const state = createLocalPlayState({ problems: [PROBLEM] }, { verify: neverVerify });
    const start = await handleLocalPlayRequest(
      post("/portal/me/problems/nope/start", {}),
      state,
      NOW,
    );
    expect(start.status).toBe(404);
    expect(start.body).toEqual({ error: "unknown_problem" });
    const stop = await handleLocalPlayRequest(
      post("/portal/me/problems/nope/stop", {}),
      state,
      NOW,
    );
    expect(stop.status).toBe(404);
    expect(stop.body).toEqual({ error: "unknown_problem" });
    // a malformed percent escape is an unknown problem, not a 500
    const badStart = await handleLocalPlayRequest(
      post("/portal/me/problems/%/start", {}),
      state,
      NOW,
    );
    expect(badStart.status).toBe(404);
    const badStop = await handleLocalPlayRequest(
      post("/portal/me/problems/%/stop", {}),
      state,
      NOW,
    );
    expect(badStop.status).toBe(404);
  });

  it("should reject reset and console handoff for Docker problems", async () => {
    const state = await stateWith(neverVerify);
    const reset = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/reset", {}),
      state,
      NOW,
    );
    expect(reset).toEqual({
      status: StatusCodes.NOT_FOUND,
      body: { error: "unknown_simulated_problem" },
    });
    const consoleHandoff = await handleLocalPlayRequest(
      get("/portal/me/problems/sqli-demo/console"),
      state,
      NOW,
    );
    expect(consoleHandoff).toEqual({
      status: StatusCodes.NOT_FOUND,
      body: { error: "unknown_simulated_problem" },
    });
  });

  it("should surface an async start failure via lifecycle lastError (202 + polling)", async () => {
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        verify: neverVerify,
        startContainer: async () => {
          throw new Error("compose boom");
        },
      },
    );
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/start", {}),
      state,
      NOW,
    );
    // 202 が先に返り、 失敗は polling で読む lifecycle (status "error" + lastError)
    // が唯一の伝達経路になる。
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    await settleLifecycle();
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (view.body as { problems: Array<{ lifecycle: { status: string } }> })
      .problems[0];
    expect(problem.lifecycle).toEqual({
      status: "error",
      runtimeKind: "docker",
      lastError: "compose boom",
    });
  });

  it("should expose retained ownership and retry cleanup with the exact failed-start unit", async () => {
    const unit = {
      problemId: PROBLEM.problemId,
      composePath: "/tmp/retained.compose.yml",
      composeProjectName: "tc-local-retained",
      secretEnv: [],
      remappedComposePath: "/tmp/retained.compose.yml",
    };
    const stopped: (typeof unit)[] = [];
    let failStop = true;
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        verify: neverVerify,
        startContainer: async () => {
          throw new ContainerStartOwnershipError(unit, [new Error("readiness cleanup failed")]);
        },
        stopContainer: async (candidate) => {
          stopped.push(candidate as typeof unit);
          if (failStop) {
            failStop = false;
            throw new Error("retry down failed");
          }
        },
      },
    );

    const start = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/start", {}),
      state,
      NOW,
    );
    expect(start.status).toBe(StatusCodes.ACCEPTED);
    await settleLifecycle();
    const failedView = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const failedProblem = (
      failedView.body as { problems: Array<{ lifecycle: { lastError?: string } }> }
    ).problems[0];
    expect(failedProblem.lifecycle).toMatchObject({
      status: "error",
      runtimeKind: "docker",
      cleanupRequired: true,
    });
    expect(typeof failedProblem.lifecycle.lastError).toBe("string");

    await expect(
      handleLocalPlayRequest(post("/portal/me/problems/sqli-demo/stop", {}), state, NOW),
    ).rejects.toThrow("retry down failed");
    expect(state.lifecycle.cleanupRequired(PROBLEM.problemId)).toBe(true);
    const retry = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/stop", {}),
      state,
      NOW,
    );
    expect(retry).toEqual({ status: StatusCodes.OK, body: { status: "stopped" } });
    expect(stopped).toEqual([unit, unit]);
    expect(state.lifecycle.cleanupRequired(PROBLEM.problemId)).toBe(false);
  });

  it("should stop a running problem, tear its unit down, and restore the catalog problem", async () => {
    const stopped: string[] = [];
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        verify: neverVerify,
        stopContainer: (unit) => {
          stopped.push(unit.problemId);
        },
      },
    );
    await handleLocalPlayRequest(post("/portal/me/problems/sqli-demo/start", {}), state, NOW);
    await settleLifecycle();
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/stop", {}),
      state,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "stopped" });
    expect(stopped).toEqual(["sqli-demo"]);
    // the runtime holds the catalog original again (no stale offset URLs)
    expect(state.runtimes.get("sqli-demo")?.problem).toBe(PROBLEM);
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (
      view.body as {
        problems: Array<{ stackOutputs: Record<string, string>; lifecycle: { status: string } }>;
      }
    ).problems[0];
    expect(problem.lifecycle).toEqual({ status: "stopped", runtimeKind: "docker" });
    expect(problem.stackOutputs).toEqual({});
  });

  it("should adopt the problem returned by the injected docker start (submit hits its /verify)", async () => {
    const verify = vi.fn<VerifyFn>(async () => ({ correct: true }));
    const remapped: ContainerProblem = {
      ...PROBLEM,
      challengeEndpoints: { Web: "http://127.0.0.1:28080/" },
      verifyUrl: "http://127.0.0.1:28081/verify",
    };
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        verify,
        startContainer: async () => ({
          problem: remapped,
          unit: {
            problemId: PROBLEM.problemId,
            composePath: PROBLEM.composePath,
            composeProjectName: PROBLEM.composeProjectName,
            secretEnv: PROBLEM.secretEnv,
          },
        }),
      },
    );
    await handleLocalPlayRequest(post("/portal/me/problems/sqli-demo/start", {}), state, NOW);
    await settleLifecycle();
    const view = await handleLocalPlayRequest(get("/portal/me"), state, NOW);
    const problem = (view.body as { problems: Array<{ stackOutputs: Record<string, string> }> })
      .problems[0];
    expect(problem.stackOutputs).toEqual({ Web: "http://127.0.0.1:28080/" });
    await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(verify).toHaveBeenCalledWith("http://127.0.0.1:28081/verify", "TC{x}", {
      teamId: "local",
      problemId: "sqli-demo",
    });
  });

  it("should refuse submit and hint reveal with 409 not_running while stopped", async () => {
    const verify = vi.fn<VerifyFn>(async () => ({ correct: true }));
    const state = createLocalPlayState({ problems: [PROBLEM] }, { verify });
    const submit = await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "TC{x}" }),
      state,
      NOW,
    );
    expect(submit.status).toBe(409);
    expect(submit.body).toEqual({ error: "not_running" });
    expect(verify).not.toHaveBeenCalled();
    const reveal = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-2/reveal", {}),
      state,
      NOW,
    );
    expect(reveal.status).toBe(409);
    expect(reveal.body).toEqual({ error: "not_running" });
    // no penalty was charged for the refused reveal
    expect(state.runtimes.get("sqli-demo")?.score).toBe(0);
  });

  it("should keep an actively played problem off cap eviction: submit touch refreshes LRU (#2512)", async () => {
    let clock = 0;
    const state = createLocalPlayState(
      { problems: [PROBLEM, IDOR, XSS] },
      { verify: async () => ({ correct: false }), now: () => clock, maxRunning: 2 },
    );
    await state.lifecycle.ensureRunning(PROBLEM.problemId); // last played at t=0
    clock = 10;
    await state.lifecycle.ensureRunning(IDOR.problemId); // last played at t=10
    clock = 20;
    // A (wrong) submission counts as playing sqli-demo → its recency moves to t=20.
    await handleLocalPlayRequest(
      post("/portal/me/submit-flag", { problemId: "sqli-demo", flag: "wrong" }),
      state,
      clock,
    );
    clock = 30;
    // At the cap: starting a third evicts the LRU — idor, not the just-played sqli.
    await handleLocalPlayRequest(post("/portal/me/problems/xss-demo/start", {}), state, clock);
    await settleLifecycle();
    expect(state.lifecycle.statusOf("sqli-demo")).toBe("running");
    expect(state.lifecycle.statusOf("api-idor-demo")).toBe("stopped");
    expect(state.lifecycle.statusOf("xss-demo")).toBe("running");
  });

  it("should refresh LRU recency via hint reveal too (#2512)", async () => {
    let clock = 0;
    const state = createLocalPlayState(
      { problems: [PROBLEM, IDOR, XSS] },
      { verify: neverVerify, now: () => clock, maxRunning: 2 },
    );
    await state.lifecycle.ensureRunning(PROBLEM.problemId);
    clock = 10;
    await state.lifecycle.ensureRunning(IDOR.problemId);
    clock = 20;
    await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/hints/hint-1/reveal", {}),
      state,
      clock,
    );
    clock = 30;
    await handleLocalPlayRequest(post("/portal/me/problems/xss-demo/start", {}), state, clock);
    await settleLifecycle();
    expect(state.lifecycle.statusOf("sqli-demo")).toBe("running");
    expect(state.lifecycle.statusOf("api-idor-demo")).toBe("stopped");
    expect(state.lifecycle.statusOf("xss-demo")).toBe("running");
  });

  it("should evict the LRU running problem when starting beyond maxRunning", async () => {
    const stopped: string[] = [];
    const state = createLocalPlayState(
      { problems: [PROBLEM, IDOR] },
      {
        verify: neverVerify,
        maxRunning: 1,
        stopContainer: (unit) => {
          stopped.push(unit.problemId);
        },
      },
    );
    const first = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/start", {}),
      state,
      NOW,
    );
    expect(first.body).toEqual({ status: "starting" });
    await settleLifecycle();
    expect(state.lifecycle.statusOf("sqli-demo")).toBe("running");
    const second = await handleLocalPlayRequest(
      post("/portal/me/problems/api-idor-demo/start", {}),
      state,
      NOW,
    );
    expect(second.status).toBe(StatusCodes.ACCEPTED);
    await settleLifecycle();
    // the cap is 1: starting the second evicted the first (its unit torn down)
    expect(stopped).toEqual(["sqli-demo"]);
    expect(state.lifecycle.statusOf("sqli-demo")).toBe("stopped");
    expect(state.lifecycle.statusOf("api-idor-demo")).toBe("running");
  });

  it("should treat a start of an already-running problem as idempotent", async () => {
    const startCalls: string[] = [];
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        verify: neverVerify,
        startContainer: async (problem) => {
          startCalls.push(problem.problemId);
          return {
            problem,
            unit: {
              problemId: problem.problemId,
              composePath: problem.composePath,
              composeProjectName: problem.composeProjectName,
              secretEnv: problem.secretEnv,
            },
          };
        },
      },
    );
    await handleLocalPlayRequest(post("/portal/me/problems/sqli-demo/start", {}), state, NOW);
    await settleLifecycle();
    const again = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/start", {}),
      state,
      NOW,
    );
    // 既に running のときの再 start は 202 応答の body に現状態がそのまま乗る。
    expect(again.body).toEqual({ status: "running" });
    expect(startCalls).toEqual(["sqli-demo"]); // the container was not restarted
  });

  it("should no-op a stop of an already-stopped problem", async () => {
    const stopped: string[] = [];
    const state = createLocalPlayState(
      { problems: [PROBLEM] },
      {
        verify: neverVerify,
        stopContainer: (unit) => {
          stopped.push(unit.problemId);
        },
      },
    );
    const res = await handleLocalPlayRequest(
      post("/portal/me/problems/sqli-demo/stop", {}),
      state,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "stopped" });
    expect(stopped).toEqual([]);
  });
});
