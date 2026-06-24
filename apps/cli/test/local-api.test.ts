import { describe, expect, it } from "vitest";
import {
  createLocalState,
  handleLocalRequest,
  LOCAL_CONTEXT,
  type LocalApiContext,
  type LocalRequest,
  type LocalState,
} from "../src/local/api.ts";
import { type LocalCatalogProblem, localPracticeFlag } from "../src/local/catalog.ts";

// Fixed epoch ms so the derived ISO timestamp is deterministic across the suite.
const NOW = 1_700_000_000_000;
const ISO = new Date(NOW).toISOString();
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** A fully-populated problem exercising every optional endpoint field + a >0 and a 0 penalty hint. */
function fullProblem(overrides: Partial<LocalCatalogProblem> = {}): LocalCatalogProblem {
  return {
    problemId: "p1",
    category: "Challenge",
    name: "Problem One",
    description: "desc",
    instructions: "do the thing",
    scoringKind: "flag",
    points: 100,
    hints: [
      { id: "h1", penalty: 10, content: "hint one content" },
      { id: "h2", penalty: 0, content: "free hint content" },
    ],
    endpoints: [
      {
        slot: "api",
        label: "API endpoint",
        description: "the api",
        overridable: true,
        defaultKey: "ApiUrl",
      },
      {
        // No label / no description → exercises the "omit optional" branch.
        slot: "web",
        overridable: false,
        defaultKey: "WebUrl",
      },
    ],
    ...overrides,
  };
}

function makeCtx(opts?: {
  catalog?: readonly LocalCatalogProblem[];
  state?: LocalState;
}): LocalApiContext {
  return {
    catalog: opts?.catalog ?? [fullProblem()],
    state: opts?.state ?? createLocalState(),
    now: NOW,
  };
}

function req(partial: Partial<LocalRequest> & Pick<LocalRequest, "method" | "path">): LocalRequest {
  return { query: {}, body: undefined, ...partial };
}

describe("LOCAL_CONTEXT", () => {
  it("should pin all identifiers to 'local'", () => {
    expect(LOCAL_CONTEXT).toEqual({
      tenantId: "local",
      eventId: "local",
      teamId: "local",
      participantId: "local",
    });
  });
});

describe("createLocalState", () => {
  it("should default the team name to 'Local Player' with empty collections", () => {
    const state = createLocalState();
    expect(state.teamName).toBe("Local Player");
    expect(state.solved.size).toBe(0);
    expect(state.revealed.size).toBe(0);
    expect(state.wrongCounts.size).toBe(0);
    expect(state.scoreEvents).toEqual([]);
    expect(state.score).toBe(0);
  });
  it("should honor an explicit team name", () => {
    expect(createLocalState("Alpha").teamName).toBe("Alpha");
  });
});

describe("handleLocalRequest GET /healthz", () => {
  it("should report ok in local mode", () => {
    const res = handleLocalRequest(req({ method: "GET", path: "/healthz" }), makeCtx());
    expect(res).toEqual({ status: 200, body: { status: "ok", mode: "local" } });
  });
});

describe("handleLocalRequest GET /portal/me", () => {
  it("should return the team view with an unsolved, unrevealed problem", () => {
    const res = handleLocalRequest(req({ method: "GET", path: "/portal/me" }), makeCtx());
    expect(res.status).toBe(200);
    const body = res.body as {
      team: Record<string, unknown>;
      problems: Array<Record<string, unknown>>;
      eventGate: unknown;
    };
    expect(body.team).toEqual({
      teamName: "Local Player",
      teamNameSetByCompetitor: true,
      eventId: "local",
      teamId: "local",
    });
    expect(body.eventGate).toEqual({ kind: "ok" });
    expect(body.problems).toHaveLength(1);
    const p = body.problems[0];
    expect(p.jobId).toBe("local-p1");
    expect(p.problemId).toBe("p1");
    // #1975: 問題文 (name / description / instructions) を view に同梱する (= ハリボテ修正)。
    expect(p.name).toBe("Problem One");
    expect(p.description).toBe("desc");
    expect(p.instructions).toBe("do the thing");
    expect(p.region).toBe("local");
    expect(p.awsAccountId).toBe("000000000000");
    expect(p.status).toBe("COMPLETE");
    expect(p.stackOutputs).toEqual({});
    expect(p.expiresAt).toBe(NOW + ONE_YEAR_MS);
    expect(p.score).toBe(0);
    expect(p.lastResult).toBeUndefined();
    expect(p.deployLog).toEqual({ cursor: "", entries: [] });
    expect(p.createdAt).toBe(ISO);
    const scoring = p.scoring as {
      kind: string;
      points: number;
      flagSubmitted: boolean;
      hints: Array<Record<string, unknown>>;
    };
    expect(scoring.kind).toBe("flag");
    expect(scoring.points).toBe(100);
    expect(scoring.flagSubmitted).toBe(false);
    // Unrevealed hints expose only metadata, no content/revealedAt.
    expect(scoring.hints).toEqual([
      { id: "h1", penalty: 10, revealed: false },
      { id: "h2", penalty: 0, revealed: false },
    ]);
  });

  it("should reflect solved score, lastResult and flagSubmitted for a solved problem", () => {
    const state = createLocalState();
    state.solved.add("p1");
    const res = handleLocalRequest(req({ method: "GET", path: "/portal/me" }), makeCtx({ state }));
    const p = (res.body as { problems: Array<Record<string, unknown>> }).problems[0];
    expect(p.score).toBe(100);
    expect(p.lastResult).toBe("ok");
    expect((p.scoring as { flagSubmitted: boolean }).flagSubmitted).toBe(true);
  });

  it("should include content and revealedAt only for revealed hints", () => {
    const state = createLocalState();
    state.revealed.add("p1::h1");
    const res = handleLocalRequest(req({ method: "GET", path: "/portal/me" }), makeCtx({ state }));
    const hints = (
      res.body as { problems: Array<{ scoring: { hints: Array<Record<string, unknown>> } }> }
    ).problems[0].scoring.hints;
    expect(hints[0]).toEqual({
      id: "h1",
      penalty: 10,
      revealed: true,
      content: "hint one content",
      revealedAt: ISO,
    });
    expect(hints[1]).toEqual({ id: "h2", penalty: 0, revealed: false });
  });
});

describe("handleLocalRequest PATCH /portal/me", () => {
  it("should update the team name when given a non-blank string (trimmed)", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const res = handleLocalRequest(
      req({ method: "PATCH", path: "/portal/me", body: { teamName: "  New Name  " } }),
      ctx,
    );
    expect(state.teamName).toBe("New Name");
    expect((res.body as { team: { teamName: string } }).team.teamName).toBe("New Name");
  });

  it("should leave the team name unchanged for a blank/whitespace string", () => {
    const state = createLocalState("Keep Me");
    handleLocalRequest(
      req({ method: "PATCH", path: "/portal/me", body: { teamName: "   " } }),
      makeCtx({ state }),
    );
    expect(state.teamName).toBe("Keep Me");
  });

  it("should leave the team name unchanged when teamName is missing", () => {
    const state = createLocalState("Keep Me");
    handleLocalRequest(req({ method: "PATCH", path: "/portal/me", body: {} }), makeCtx({ state }));
    expect(state.teamName).toBe("Keep Me");
  });

  it("should leave the team name unchanged for a non-string teamName", () => {
    const state = createLocalState("Keep Me");
    handleLocalRequest(
      req({ method: "PATCH", path: "/portal/me", body: { teamName: 42 } }),
      makeCtx({ state }),
    );
    expect(state.teamName).toBe("Keep Me");
  });

  it("should treat a missing body as no update (req.body undefined -> {})", () => {
    const state = createLocalState("Keep Me");
    handleLocalRequest(req({ method: "PATCH", path: "/portal/me" }), makeCtx({ state }));
    expect(state.teamName).toBe("Keep Me");
  });

  it("should 404 for a PATCH to a path other than /portal/me", () => {
    // handlePatch returns undefined for any non-/portal/me path -> caller 404s.
    const res = handleLocalRequest(
      req({ method: "PATCH", path: "/portal/me/score-events" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("handleLocalRequest GET /portal/me/score-events", () => {
  it("should return the state's score events", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    // Solve to push a score event, then read it back.
    handleLocalRequest(
      req({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "p1", flag: localPracticeFlag("p1") },
      }),
      ctx,
    );
    const res = handleLocalRequest(req({ method: "GET", path: "/portal/me/score-events" }), ctx);
    expect(res.status).toBe(200);
    const entries = (res.body as { entries: typeof state.scoreEvents }).entries;
    expect(entries).toBe(state.scoreEvents);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("flag");
  });
});

describe("handleLocalRequest GET /portal/leaderboard", () => {
  it("should return a single self-team entry with live score/progress", () => {
    const state = createLocalState("My Team");
    state.score = 250;
    state.solved.add("p1");
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/leaderboard" }),
      makeCtx({ state, catalog: [fullProblem(), fullProblem({ problemId: "p2" })] }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      eventId: "local",
      entries: [
        {
          rank: 1,
          teamId: "local",
          teamName: "My Team",
          score: 250,
          completedProblems: 1,
          totalProblems: 2,
          isMyTeam: true,
        },
      ],
      scoreboardFrozen: false,
    });
  });
});

describe("handleLocalRequest GET /portal/leaderboard/score-events", () => {
  it("should return one team bucket holding the state's score events", () => {
    const state = createLocalState("My Team");
    const ctx = makeCtx({ state });
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/leaderboard/score-events" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      eventId: "local",
      teams: [
        {
          teamId: "local",
          teamName: "My Team",
          isMyTeam: true,
          events: state.scoreEvents,
        },
      ],
    });
    expect((res.body as { teams: Array<{ events: unknown }> }).teams[0].events).toBe(
      state.scoreEvents,
    );
  });
});

describe("handleLocalRequest GET /portal/me/notifications", () => {
  it("should return an empty notifications list", () => {
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/notifications" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 200, body: { eventId: "local", items: [] } });
  });
});

describe("handleLocalRequest GET /portal/me/deploy-logs", () => {
  it("should echo the jobId query when present", () => {
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/deploy-logs", query: { jobId: "local-p1" } }),
      makeCtx(),
    );
    expect(res).toEqual({
      status: 200,
      body: { jobId: "local-p1", complete: true, entries: [] },
    });
  });

  it("should default jobId to an empty string when absent", () => {
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/deploy-logs" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 200, body: { jobId: "", complete: true, entries: [] } });
  });
});

describe("handleLocalRequest GET /portal/me/battle-attacks", () => {
  it("should echo jobId and parse sinceMin when present", () => {
    const res = handleLocalRequest(
      req({
        method: "GET",
        path: "/portal/me/battle-attacks",
        query: { jobId: "local-p1", sinceMin: "15" },
      }),
      makeCtx(),
    );
    expect(res).toEqual({
      status: 200,
      body: { jobId: "local-p1", problemId: "", sinceMin: 15, events: [] },
    });
  });

  it("should default jobId to '' and sinceMin to 0 when absent", () => {
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/battle-attacks" }),
      makeCtx(),
    );
    expect(res).toEqual({
      status: 200,
      body: { jobId: "", problemId: "", sinceMin: 0, events: [] },
    });
  });
});

describe("handleLocalRequest POST /portal/me/submit-flag", () => {
  it("should reject a missing/non-object body with unknown_problem", () => {
    // body undefined -> {} -> problemId "" -> no catalog match -> 400.
    const res = handleLocalRequest(
      req({ method: "POST", path: "/portal/me/submit-flag" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 400, body: { error: "unknown_problem" } });
  });

  it("should coerce a non-string problemId/flag and reject as unknown_problem", () => {
    const res = handleLocalRequest(
      req({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: 123, flag: 456 },
      }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 400, body: { error: "unknown_problem" } });
  });

  it("should reject an unknown problemId with 400", () => {
    const res = handleLocalRequest(
      req({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "nope", flag: "x" },
      }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 400, body: { error: "unknown_problem" } });
  });

  it("should score a correct flag, mutate state and push a flag score-event", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const res = handleLocalRequest(
      req({
        method: "POST",
        path: "/portal/me/submit-flag",
        body: { problemId: "p1", flag: localPracticeFlag("p1") },
      }),
      ctx,
    );
    expect(res).toEqual({
      status: 200,
      body: { kind: "ok", scoreDelta: 100, totalScore: 100 },
    });
    expect(state.solved.has("p1")).toBe(true);
    expect(state.score).toBe(100);
    expect(state.scoreEvents).toEqual([
      {
        jobId: "local-p1",
        problemId: "p1",
        source: "flag",
        points: 100,
        result: "ok",
        occurredAt: ISO,
      },
    ]);
  });

  it("should return already_scored without re-adding score on resubmit", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const submit = () =>
      handleLocalRequest(
        req({
          method: "POST",
          path: "/portal/me/submit-flag",
          body: { problemId: "p1", flag: localPracticeFlag("p1") },
        }),
        ctx,
      );
    submit();
    const res = submit();
    expect(res).toEqual({ status: 200, body: { kind: "already_scored", totalScore: 100 } });
    expect(state.score).toBe(100);
    expect(state.scoreEvents).toHaveLength(1);
  });

  it("should mark a wrong flag, increment wrongCount across calls and push flag-wrong events", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const submitWrong = () =>
      handleLocalRequest(
        req({
          method: "POST",
          path: "/portal/me/submit-flag",
          body: { problemId: "p1", flag: "not-the-flag" },
        }),
        ctx,
      );
    const first = submitWrong();
    expect(first).toEqual({
      status: 200,
      body: { kind: "wrong", scoreDelta: 0, totalScore: 0, wrongCount: 1 },
    });
    const second = submitWrong();
    expect(second).toEqual({
      status: 200,
      body: { kind: "wrong", scoreDelta: 0, totalScore: 0, wrongCount: 2 },
    });
    expect(state.wrongCounts.get("p1")).toBe(2);
    expect(state.solved.has("p1")).toBe(false);
    expect(state.scoreEvents).toHaveLength(2);
    expect(state.scoreEvents.every((e) => e.source === "flag-wrong" && e.result === "wrong")).toBe(
      true,
    );
  });
});

describe("handleLocalRequest POST .../hints/:hid/reveal", () => {
  it("should 404 for an unknown problem", () => {
    const res = handleLocalRequest(
      req({ method: "POST", path: "/portal/me/problems/nope/hints/h1/reveal" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 404, body: { error: "unknown_hint" } });
  });

  it("should 404 for an unknown hint on a known problem", () => {
    const res = handleLocalRequest(
      req({ method: "POST", path: "/portal/me/problems/p1/hints/nope/reveal" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 404, body: { error: "unknown_hint" } });
  });

  it("should reveal a >0-penalty hint, deduct score and push a hint score-event", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const res = handleLocalRequest(
      req({ method: "POST", path: "/portal/me/problems/p1/hints/h1/reveal" }),
      ctx,
    );
    expect(res).toEqual({
      status: 200,
      body: {
        kind: "ok",
        content: "hint one content",
        penaltyApplied: 10,
        totalScore: -10,
        revealedAt: ISO,
      },
    });
    expect(state.revealed.has("p1::h1")).toBe(true);
    expect(state.score).toBe(-10);
    expect(state.scoreEvents).toEqual([
      {
        jobId: "local-p1",
        problemId: "p1",
        source: "hint",
        points: -10,
        result: "ok",
        occurredAt: ISO,
      },
    ]);
  });

  it("should reveal a 0-penalty hint without pushing a score-event", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const res = handleLocalRequest(
      req({ method: "POST", path: "/portal/me/problems/p1/hints/h2/reveal" }),
      ctx,
    );
    expect(res).toEqual({
      status: 200,
      body: {
        kind: "ok",
        content: "free hint content",
        penaltyApplied: 0,
        totalScore: 0,
        revealedAt: ISO,
      },
    });
    expect(state.revealed.has("p1::h2")).toBe(true);
    expect(state.score).toBe(0);
    expect(state.scoreEvents).toEqual([]);
  });

  it("should return already_revealed with penaltyApplied 0 on re-reveal", () => {
    const state = createLocalState();
    const ctx = makeCtx({ state });
    const reveal = () =>
      handleLocalRequest(
        req({ method: "POST", path: "/portal/me/problems/p1/hints/h1/reveal" }),
        ctx,
      );
    reveal();
    const res = reveal();
    expect(res).toEqual({
      status: 200,
      body: {
        kind: "already_revealed",
        content: "hint one content",
        penaltyApplied: 0,
        totalScore: -10,
        revealedAt: ISO,
      },
    });
    // Score only deducted once; no second score-event.
    expect(state.score).toBe(-10);
    expect(state.scoreEvents).toHaveLength(1);
  });

  it("should decode URL-encoded problem and hint ids", () => {
    const problem = fullProblem({
      problemId: "ns/p one",
      hints: [{ id: "hint a", penalty: 5, content: "encoded hint" }],
      endpoints: [],
    });
    const state = createLocalState();
    const ctx = makeCtx({ state, catalog: [problem] });
    const res = handleLocalRequest(
      req({
        method: "POST",
        path: `/portal/me/problems/${encodeURIComponent("ns/p one")}/hints/${encodeURIComponent("hint a")}/reveal`,
      }),
      ctx,
    );
    expect((res.body as { kind: string; content: string }).kind).toBe("ok");
    expect((res.body as { content: string }).content).toBe("encoded hint");
    expect(state.revealed.has("ns/p one::hint a")).toBe(true);
  });
});

describe("handleLocalRequest GET .../problems/:pid/endpoints", () => {
  it("should 404 for an unknown problem", () => {
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/problems/nope/endpoints" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 404, body: { error: "unknown_problem" } });
  });

  it("should map endpoints, including/omitting optional label and description", () => {
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/problems/p1/endpoints" }),
      makeCtx(),
    );
    expect(res).toEqual({
      status: 200,
      body: {
        teamId: "local",
        endpoints: [
          {
            slot: "api",
            overridable: true,
            defaultKey: "ApiUrl",
            label: "API endpoint",
            description: "the api",
          },
          {
            slot: "web",
            overridable: false,
            defaultKey: "WebUrl",
          },
        ],
      },
    });
  });

  it("should decode a URL-encoded problem id", () => {
    const problem = fullProblem({
      problemId: "ns/p two",
      endpoints: [{ slot: "s", overridable: false, defaultKey: "K" }],
    });
    const res = handleLocalRequest(
      req({
        method: "GET",
        path: `/portal/me/problems/${encodeURIComponent("ns/p two")}/endpoints`,
      }),
      makeCtx({ catalog: [problem] }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { endpoints: Array<{ slot: string }> }).endpoints[0].slot).toBe("s");
  });
});

describe("handleLocalRequest fallthrough", () => {
  it("should 404 an unknown path", () => {
    const res = handleLocalRequest(req({ method: "GET", path: "/nope" }), makeCtx());
    expect(res).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("should 404 a known path with the wrong method", () => {
    const res = handleLocalRequest(req({ method: "DELETE", path: "/portal/me" }), makeCtx());
    expect(res).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("should not match the reveal route for a non-POST method (regex guard)", () => {
    // GET against the reveal path -> REVEAL_RE not run -> falls through to 404.
    const res = handleLocalRequest(
      req({ method: "GET", path: "/portal/me/problems/p1/hints/h1/reveal" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("should not match the endpoints route for a non-GET method (regex guard)", () => {
    // POST against the endpoints path -> ENDPOINTS_RE not run -> falls through to 404.
    const res = handleLocalRequest(
      req({ method: "POST", path: "/portal/me/problems/p1/endpoints" }),
      makeCtx(),
    );
    expect(res).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("should 404 for a method that is not GET/POST/PATCH", () => {
    // DELETE matches none of the per-method routers -> res stays undefined -> 404.
    const res = handleLocalRequest(req({ method: "DELETE", path: "/portal/me" }), makeCtx());
    expect(res).toEqual({ status: 404, body: { error: "not_found" } });
  });
});
